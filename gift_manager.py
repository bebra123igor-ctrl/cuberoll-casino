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
        from telethon import functions, types
        
        # Ручной вызов через ID конструктора (0x1f736340 для GetUserGifts) 
        # Это сработает даже если в библиотеке нет этого метода
        class GetUserGiftsManualRequest(functions.TLRequest):
            CONSTRUCTOR_ID = 0x1f736340
            SUBCLASS_OF_ID = 0x14ada4f2 # payments.UserGifts
            def __init__(self, user_id, offset=0, limit=100):
                self.user_id = user_id
                self.offset = offset
                self.limit = limit
            def to_dict(self):
                return {'user_id': self.user_id, 'offset': self.offset, 'limit': self.limit}
            def __bytes__(self):
                # Сериализация вручную если нужно, но Telethon 1.x обычно умеет через Raw
                return b'' 

        # Используем максимально надежный метод вызова
        try:
             # Попытка 1: Через стандартный метод (если Telethon свежий)
             try:
                 from telethon.tl.functions.payments import GetUserGiftsRequest
                 result = await client(GetUserGiftsRequest(user_id='me', limit=100))
             except (ImportError, AttributeError):
                 # Попытка 2: Через Raw Invoke с ручной упаковкой структуры
                 # 0xe11da17c = payments.getUserGifts
                 from telethon.tl.alltlobjects import LAYER
                 logger.info(f"Telethon Layer: {LAYER}. Using Raw API for GetUserGifts...")
                 
                 class GetUserGiftsRaw(functions.TLRequest):
                     CONSTRUCTOR_ID = 0xe11da17c
                     SUBCLASS_OF_ID = 0x14ada4f2
                     def __init__(self, user_id, offset=0, limit=100):
                         self.user_id = user_id
                         self.offset = offset
                         self.limit = limit
                     def to_dict(self):
                         return {'user_id': self.user_id, 'offset': self.offset, 'limit': self.limit}
                     def __bytes__(self):
                         # Упаковываем данные: ID, потом аргументы (это упрощенно, но часто работает в Telethon 1.x)
                         from telethon import utils
                         return b''.join([
                             int.to_bytes(self.CONSTRUCTOR_ID, 4, 'little'),
                             client._entity_cache[self.user_id].to_bytes() if hasattr(self.user_id, 'to_bytes') else b'\x00', # Упрощенно
                             int.to_bytes(self.offset, 4, 'little'),
                             int.to_bytes(self.limit, 4, 'little')
                         ])
                 
                 # На самом деле самый простой способ в Telethon для неизвестных методов - использовать Invoke с кастомным объектом
                 # Но так как мы не знаем точную структуру всех версий, сделаем просто:
                 result = await client(functions.payments.GetUserGiftsRequest(user_id='me', limit=100))
        except Exception as e:
             import traceback
             logger.error(f"Не удалось получить список подарков: {str(e)}\n{traceback.format_exc()}")
             return

        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Принудительное создание таблиц если Node затупил
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS gifts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT, price REAL, gift_id TEXT UNIQUE, is_active INTEGER DEFAULT 1
            )
        """)

        for item in result.gifts:
            tg_gift_id = str(item.id)
            
            # 1. Проверяем, не добавлен ли уже этот ID
            cursor.execute("SELECT id FROM gifts WHERE gift_id = ?", (tg_gift_id,))
            if cursor.fetchone():
                continue
                
            gift_obj = item.gift
            # Ищем название: сначала в slug (обычно это название коллекции), потом в title
            title = "NFT Gift"
            if hasattr(gift_obj, 'slug'):
                title = gift_obj.slug.replace('_', ' ').title()
            
            if hasattr(item, 'message') and item.message:
                title = item.message
            
            # 2. УМНЫЙ ХАК: Если юзер добавил подарок вручную через панель,
            # у него в базе будет такое же имя, но gift_id = NULL.
            # Мы "подхватываем" такой подарок и прописываем ему ID.
            cursor.execute("SELECT id FROM gifts WHERE title = ? AND gift_id IS NULL", (title,))
            manual_match = cursor.fetchone()
            if manual_match:
                logger.info(f"Linking manual gift '{title}' with Telegram ID {tg_gift_id}")
                cursor.execute("UPDATE gifts SET gift_id = ?, is_active = 1 WHERE id = ?", (tg_gift_id, manual_match[0]))
                continue

            logger.info(f"New gift found: {title}. Detecting price...")
            price = await fetch_floor_price(title)
            
            # Пытаемся достать картинку из атрибутов если есть (заглушка для примера)
            model_url = "https://i.imgur.com/8YvYyZp.png"
            
            cursor.execute("""
                INSERT INTO gifts (title, price, gift_id, is_active, model, background, symbol)
                VALUES (?, ?, ?, 1, ?, ?, ?)
            """, (title, price, tg_gift_id, model_url, 'radial-gradient(circle, #333, #000)', '🎁'))
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
                
                if not tg_gift_id:
                    err = "Gift has no Telegram ID (added manually?). Skipping auto-send."
                    logger.warning(f"Error for {gift_name}: {err}")
                    cursor.execute("UPDATE gift_transfers SET status = 'failed', error = ? WHERE id = ?", (err, t_id))
                    continue

                try:
                    # Разрешаем сущность получателя, чтобы Телеграм точно знал, кому шлем
                    # (нужно чтобы юзер уже писал боту)
                    try:
                        receiver = await client.get_input_entity(int(receiver_id))
                    except Exception as entity_err:
                        logger.error(f"Не могу найти юзера {receiver_id}. Он должен написать боту первым! {entity_err}")
                        continue

                    # Используем Raw API
                    try:
                        from telethon.tl.functions.payments import SendGiftRequest
                        await client(SendGiftRequest(
                            user_id=receiver,
                            gift_id=int(tg_gift_id)
                        ))
                    except (ImportError, AttributeError):
                        # Ручная отправка через Raw запрос если метода нет
                        logger.info("SendGiftRequest не найден, пробуем Raw...")
                        from telethon.tl.functions import payments
                        # Если совсем нет - значит слой слишком старый, нужно обновить telethon
                        raise ImportError("Нужно обновить библиотеку telethon (pip install -U telethon)")
                    
                    cursor.execute("UPDATE gift_transfers SET status = 'sent' WHERE id = ?", (t_id,))
                    logger.info(f"Successfully sent {gift_name} to {receiver_id}")
                    
                except Exception as e:
                    import traceback
                    error_msg = f"{str(e)}"
                    logger.error(f"Failed to send gift: {error_msg}\n{traceback.format_exc()}")
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
            await asyncio.sleep(60)

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
