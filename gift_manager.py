import os
import sqlite3
import asyncio
import logging
import random
import aiohttp
from telethon import TelegramClient, functions, types
from telethon.network import connection
from telethon.sessions import StringSession
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

        # Максимально надежный вызов GetUserGifts
        try:
             # Попытка через Invoke с ручным определением структуры
             # 0xe11da17c = payments.getUserGifts#e11da17c user_id:InputUser offset:int limit:int = payments.UserGifts;
             class GetGiftsReq(functions.TLRequest):
                 CONSTRUCTOR_ID = 0xe11da17c
                 SUBCLASS_OF_ID = 0x14ada4f2
                 def __init__(self, user_id, offset=0, limit=100):
                     self.user_id = user_id
                     self.offset = offset
                     self.limit = limit
                 def to_dict(self): return {'user_id': self.user_id, 'offset': self.offset, 'limit': self.limit}
                 def _bytes(self):
                     import struct
                     return b''.join((
                         struct.pack('<I', self.CONSTRUCTOR_ID),
                         self.user_id._bytes(),
                         struct.pack('<i', self.offset),
                         struct.pack('<i', self.limit)
                     ))
             
             # Разрешаем "себя" один раз для всех запросов
             me = await client.get_input_entity('me')
             
             # Пробуем вызвать. Если в библиотеке есть метод - отлично, если нет - Invoke по ID
             try:
                 # Пытаемся импортировать если есть
                 from telethon.tl.functions.payments import GetUserGiftsRequest
                 result = await client(GetUserGiftsRequest(user_id=me, limit=100))
             except:
                 # Если нет - кидаем Raw
                 result = await client(GetGiftsReq(user_id=me, limit=100))

        except Exception as e:
             import traceback
             logger.error(f"Не удалось получить список подарков: {e}\n{traceback.format_exc()}")
             return

        if not result or not hasattr(result, 'gifts'):
            logger.warning("Список подарков пуст или не получен.")
            return

        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Миграция колонок на лету
        for col in ['model', 'background', 'symbol']:
            try: cursor.execute(f"ALTER TABLE gifts ADD COLUMN {col} TEXT")
            except: pass
        conn.commit()

        # Парсер мета-данных (модель, фон, символ)
        async def parse_nft_meta(slug, gift_id):
            if not slug or not gift_id: return {}
            url = f"https://t.me/nft/{slug}-{gift_id}"
            try:
                import re
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, timeout=7) as resp:
                        if resp.status != 200: return {}
                        text = await resp.text()
                        m = re.search(r'og:description["\s]+content="([^"]*)"', text)
                        if not m: return {}
                        desc = m.group(1).replace("&#10;", "\n")
                        meta = {}
                        for line in desc.split("\n"):
                            if "Model:" in line: meta["model"] = line.split("Model:")[1].strip()
                            if "Backdrop:" in line: meta["backdrop"] = line.split("Backdrop:")[1].strip()
                            if "Symbol:" in line: meta["symbol"] = line.split("Symbol:")[1].strip()
                        return meta
            except: return {}

        for item in result.gifts:
            tg_gift_id = str(item.id)
            gift_obj = item.gift
            slug = getattr(gift_obj, 'slug', '')
            
            # Название подарка
            api_title = slug.replace('_', ' ').title() if slug else "NFT Gift"
            if hasattr(item, 'message') and item.message:
                api_title = item.message

            # Проверяем наличие
            cursor.execute("SELECT id FROM gifts WHERE gift_id = ?", (tg_gift_id,))
            if cursor.fetchone():
                continue
            
            # Привязка ручных подарков (по частичному совпадению)
            cursor.execute("SELECT id, title FROM gifts WHERE gift_id IS NULL AND is_active = 1")
            manual_items = cursor.fetchall()
            matched_id = None
            
            for m_id, m_title in manual_items:
                c_api = api_title.lower().split('#')[0].strip()
                c_man = m_title.lower().split('#')[0].strip()
                if c_api in c_man or c_man in c_api:
                    matched_id = m_id
                    break
            
            # Собираем мета-данные
            meta = await parse_nft_meta(slug, tg_gift_id)
            m_url = meta.get("model", "https://i.imgur.com/8YvYyZp.png")
            b_style = meta.get("backdrop", "radial-gradient(circle, #333, #000)")
            sym = meta.get("symbol", "🎁")

            if matched_id:
                logger.info(f"Linking '{api_title}' to existing item #{matched_id}")
                cursor.execute("""
                    UPDATE gifts SET gift_id = ?, model = ?, background = ?, symbol = ? 
                    WHERE id = ?
                """, (tg_gift_id, m_url, b_style, sym, matched_id))
            else:
                logger.info(f"Adding new gift from account: {api_title}")
                price = await fetch_floor_price(api_title)
                cursor.execute("""
                    INSERT INTO gifts (title, price, gift_id, is_active, model, background, symbol)
                    VALUES (?, ?, ?, 1, ?, ?, ?)
                """, (api_title, price, tg_gift_id, m_url, b_style, sym))
            
        conn.commit()
        conn.close()
    except Exception as e:
        import traceback
        logger.error(f"Inventory sync failed: {e}\n{traceback.format_exc()}")

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

                    except:
                        # Ручная отправка через Raw запрос
                        # 0xc220d9f4 = payments.sendGift#c220d9f4 user_id:InputUser gift_id:long = Updates;
                        class SendGiftReq(functions.TLRequest):
                            CONSTRUCTOR_ID = 0xc220d9f4
                            SUBCLASS_OF_ID = 0x8af52bc9
                            def __init__(self, u_id, g_id):
                                self.user_id = u_id
                                self.gift_id = g_id
                            def to_dict(self): return {'user_id': self.user_id, 'gift_id': self.gift_id}
                            def _bytes(self):
                                import struct
                                return b''.join((
                                    struct.pack('<I', self.CONSTRUCTOR_ID),
                                    self.user_id._bytes(),
                                    struct.pack('<q', self.gift_id) # long is q in struct
                                ))
                        
                        await client(SendGiftReq(receiver, int(tg_gift_id)))
                    
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
    
    logger.info("Initializing gift manager client...")
    
    from telethon.sessions import StringSession
    from telethon.network import ConnectionTcpIntermediate
    
    try:
        client = TelegramClient(
            StringSession(session_string),
            int(API_ID),
            API_HASH,
            connection=ConnectionTcpIntermediate
        )
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
