import os
import sqlite3
import asyncio
import logging
import random
import aiohttp
from telethon import TelegramClient, functions, types
from dotenv import load_dotenv

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("gift_manager.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

load_dotenv()

# Конфигурация из .env
API_ID = os.getenv("TG_API_ID")
API_HASH = os.getenv("TG_API_HASH")
BANK_ID = 8291579358
DB_PATH = "cuberoll.db"

# Парсер цен (логика из PriceDetector)
async def fetch_floor_price(name):
    url = "https://portal-market.com/api/collections"
    params = {"search": name, "limit": 5}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }
    try:
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(url, params=params, timeout=10) as response:
                if response.status != 200:
                    return 5.0 # Дефолтная цена если не найдено
                data = await response.json()
                collections = data.get("collections", [])
                if not collections:
                    return 5.0
                
                # Ищем максимально похожее название
                best = collections[0]
                raw_price = float(best.get("floor_price", 5000000000))
                # Конвертация из нано-тонов если нужно
                price = raw_price / 1e9 if raw_price > 1e6 else raw_price
                return round(price * 1.1, 2) # Наценка 10%
    except Exception as e:
        logger.error(f"Error fetching price for {name}: {e}")
        return 5.0

# Путь к БД может отличаться на Railway
DB_PATHS = ["cuberoll.db", "../cuberoll.db", "/app/cuberoll.db"]
DB_PATH = "cuberoll.db"

def get_db_connection():
    for p in DB_PATHS:
        if os.path.exists(p):
            return sqlite3.connect(p)
    return sqlite3.connect("cuberoll.db") # fallback

async def sync_inventory(client):
    """Парсит подарки с аккаунта банка и обновляет магазин"""
    logger.info(f"Scanning for unique gifts on account...")
    try:
        from telethon import functions
        
        # Динамический поиск метода GetUserGifts
        req_class = None
        # Проверяем разные варианты именования в зависимости от версии Telethon
        variants = ['GetUserGiftsRequest', 'GetUserGifts', 'get_user_gifts']
        for var in variants:
            if hasattr(functions.payments, var):
                req_class = getattr(functions.payments, var)
                break
        
        if not req_class:
            # Логируем доступные методы для отладки
            available = [m for m in dir(functions.payments) if not m.startswith('_')]
            logger.error(f"КРИТИЧЕСКАЯ ОШИБКА: Метод GetUserGifts не найден. Доступные методы: {available[:10]}...")
            return

        # На некоторых версиях нужно передавать offset и limit
        try:
            req = req_class(user_id='me', limit=100)
        except TypeError:
            req = req_class(user_id='me', offset=0, limit=100)

        result = await client(req)
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Проверка существования таблицы
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='gifts'")
        if not cursor.fetchone():
            logger.warning("Таблица 'gifts' еще не создана. Ждем инициализации сервера...")
            conn.close()
            return

        for item in result.gifts:
            tg_gift_id = str(item.id)
            cursor.execute("SELECT id FROM gifts WHERE gift_id = ?", (tg_gift_id,))
            if cursor.fetchone():
                continue
                
            gift_info = item.gift
            title = getattr(gift_info, 'title', getattr(gift_info, 'slug', f"NFT Gift #{tg_gift_id}"))
            
            logger.info(f"New gift found: {title}. Detecting price...")
            price = await fetch_floor_price(title)
            
            cursor.execute("""
                INSERT INTO gifts (title, price, gift_id, is_active)
                VALUES (?, ?, ?, 1)
            """, (title, price, tg_gift_id))
            logger.info(f"Added to store: {title} for {price} TON")
            
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Inventory sync failed: {e}")

async def process_transfer_queue(client):
    """Следит за новыми покупками в БД и отправляет подарки"""
    logger.info("Starting transfer queue monitor...")
    while True:
        conn = None
        try:
            conn = get_db_connection()
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Проверка таблицы
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='gift_transfers'")
            if not cursor.fetchone():
                conn.close()
                await asyncio.sleep(10)
                continue

            # Берем незавершенные переводы
            cursor.execute("""
                SELECT t.id, t.receiver_id, g.gift_id, g.title, g.id as db_gift_id
                FROM gift_transfers t
                JOIN gifts g ON t.gift_id = g.id
                WHERE t.status = 'pending'
            """)
            
            pending = cursor.fetchall()
            for row in pending:
                t_id = row['id']
                receiver_id = row['receiver_id']
                tg_gift_id = row['gift_id']
                gift_name = row['title']
                
                logger.info(f"Processing purchase: {gift_name} for user {receiver_id}")
                
                try:
                    from telethon.tl.functions.payments import SendGiftRequest
                    await client(SendGiftRequest(
                        user_id=receiver_id,
                        gift_id=int(tg_gift_id)
                    ))
                    
                    cursor.execute("UPDATE gift_transfers SET status = 'sent' WHERE id = ?", (t_id,))
                    logger.info(f"Successfully sent {gift_name} to {receiver_id}")
                    
                except Exception as e:
                    error_msg = str(e)
                    logger.error(f"Failed to send gift: {error_msg}")
                    cursor.execute("UPDATE gift_transfers SET status = 'failed', error = ? WHERE id = ?", (error_msg, t_id))
            
            conn.commit()
        except Exception as e:
            logger.error(f"Database error in monitor: {e}")
        finally:
            if conn:
                conn.close()
        
        await asyncio.sleep(5)

async def main():
    if not API_ID or not API_HASH:
        logger.error("КРИТИЧЕСКАЯ ОШИБКА: TG_API_ID или TG_API_HASH не установлены в переменных Railway!")
        return

    session_string = os.getenv("TG_SESSION_STRING")
    if not session_string:
         logger.error("КРИТИЧЕСКАЯ ОШИБКА: TG_SESSION_STRING не установлен! Бот не сможет войти.")
         return
    
    logger.info("Initializing Userbot with StringSession...")
    
    from telethon.sessions import StringSession
    
    try:
        client = TelegramClient(StringSession(session_string), int(API_ID), API_HASH)
    except Exception as e:
        logger.error(f"Ошибка инициализации клиента: {e}")
        return
    
    try:
        await client.start()
        me = await client.get_me()
        logger.info(f"Юзербот успешно запущен! Аккаунт: {me.first_name} (ID: {me.id})")
    except Exception as e:
        logger.error(f"Не удалось запустить клиент: {e}")
        return

    # Цикл синхронизации
    async def periodic_sync():
        while True:
            try:
                await sync_inventory(client)
            except Exception as e:
                logger.error(f"Ошибка в цикле синхронизации: {e}")
            await asyncio.sleep(600)

    try:
        await asyncio.gather(
            process_transfer_queue(client),
            periodic_sync()
        )
    except Exception as e:
        logger.error(f"Ошибка в основном цикле: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Shutting down...")
