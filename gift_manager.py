import os
import sqlite3
import asyncio
import logging
import random
import aiohttp
from telethon import TelegramClient, functions, types, events
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
BANK_ID = 8295093615
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
    """Парсит подарки с аккаунта дилера и обновляет магазин (v1.0.4)"""
    logger.info("--- SYNC START (v1.0.4) ---")
    
    try:
        # 0. Диагностика окружения
        try:
            import telethon
            import sys
            logger.info(f"Environment: Python {sys.version.split()[0]}, Telethon {telethon.__version__}")
        except: pass

        # 1. Проверка аккаунта
        try:
            me = await client.get_me()
            if me.bot:
                logger.error(f"!!! ОШИБКА: Аккаунт '{me.first_name}' - это БОТ. Подарки могут слать только ЮЗЕРЫ.")
                return 
        except Exception as e:
            logger.error(f"Ошибка проверки аккаунта: {e}")
            return

        # 2. ПОЛУЧЕНИЕ ПОДАРКОВ (логика из вашего старого кода)
        result = None
        try:
             from telethon.tl.functions import payments
             from telethon.tl import types
             
             me_input = await client.get_input_entity('me')
             
             # Пробуем разные методы из Telethon 1.38+
             methods_to_try = ["GetSavedStarGiftsRequest", "GetUserGiftsRequest", "GetStarGiftsRequest"]
             for m_name in methods_to_try:
                 if hasattr(payments, m_name):
                     try:
                         logger.info(f"Пробую метод {m_name}...")
                         req = getattr(payments, m_name)
                         if m_name == "GetStarGiftsRequest":
                             result = await client(req(hash=0))
                         else:
                             result = await client(req(user_id=me_input, limit=100))
                         if result: break
                     except Exception as e:
                         logger.warning(f"Метод {m_name} не сработал: {e}")

        except Exception as e:
             logger.error(f"Не удалось получить инвентарь: {e}")
             return

        if not result or not hasattr(result, 'gifts'):
            logger.warning("Список подарков от Телеграма пуст.")
            return

        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Миграция колонок (slug критичен для передачи!)
        for col in ['model', 'background', 'symbol', 'slug']:
            try: cursor.execute(f"ALTER TABLE gifts ADD COLUMN {col} TEXT")
            except: pass
        
        # ЧИСТКА: Удаляем мусорные "NFT Gift"
        try:
            cursor.execute("DELETE FROM gifts WHERE title = 'NFT Gift' AND slug IS NULL")
            logger.info("Удален мусор из базы подарков.")
        except: pass
        conn.commit()

        # Помощник для данных из t.me/nft
        async def parse_nft_meta(slug, gift_id):
            if not slug: return {}
            url = f"https://t.me/nft/{slug}-{gift_id}"
            try:
                import re
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, timeout=5) as resp:
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
            # ЗАЩИТА (v1.0.4)
            tg_gift_id = str(getattr(item, 'id', '0'))
            if tg_gift_id == '0': continue
            
            # Телеграм может вернуть StarGift или UserStarGift
            gift_obj = getattr(item, 'gift', item)
            slug = getattr(gift_obj, 'slug', '')
            
            if not slug and hasattr(item, 'stargift'):
                slug = getattr(item.stargift, 'slug', '')
            
            # ВАЖНО: Если нет slug - это не NFT, игнорируем!
            if not slug:
                continue

            api_title = slug.replace('_', ' ').title()
            if hasattr(item, 'message') and item.message:
                api_title = item.message

            cursor.execute("SELECT id FROM gifts WHERE gift_id = ?", (tg_gift_id,))
            if cursor.fetchone():
                continue
            
            cursor.execute("SELECT id, title FROM gifts WHERE gift_id IS NULL AND is_active = 1")
            manual_items = cursor.fetchall()
            matched_id = None
            
            for m_id, m_title in manual_items:
                c_api = api_title.lower().split('#')[0].strip()
                c_man = m_title.lower().split('#')[0].strip()
                if c_api in c_man or c_man in c_api:
                    matched_id = m_id
                    break
            
            meta = await parse_nft_meta(slug, tg_gift_id)
            m_url = meta.get("model", "https://i.imgur.com/8YvYyZp.png")
            b_style = meta.get("backdrop", "radial-gradient(circle, #333, #000)")
            sym = meta.get("symbol", "🎁")

            if matched_id:
                logger.info(f"Linking '{api_title}' to existing item #{matched_id}")
                cursor.execute("""
                    UPDATE gifts SET gift_id = ?, model = ?, background = ?, symbol = ?, slug = ? 
                    WHERE id = ?
                """, (tg_gift_id, m_url, b_style, sym, slug, matched_id))
            else:
                logger.info(f"Adding new gift: {api_title}")
                price = await fetch_floor_price(api_title)
                cursor.execute("""
                    INSERT INTO gifts (title, price, gift_id, is_active, model, background, symbol, slug)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
                """, (api_title, price, tg_gift_id, m_url, b_style, sym, slug))
            
        conn.commit()
        conn.close()
    except Exception as e:
        import traceback
        logger.error(f"Sync failed (v1.0.4): {e}\n{traceback.format_exc()}")

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
                    # 1. Разрешаем сущность получателя
                    try:
                        receiver = await client.get_input_entity(int(receiver_id))
                    except Exception as entity_err:
                        logger.error(f"Не могу найти юзера {receiver_id}: {entity_err}")
                        continue

                    # 2. Ищем slug подарка (он нужен для TransferStarGiftRequest)
                    cursor.execute("SELECT slug FROM gifts WHERE gift_id = ?", (tg_gift_id,))
                    row = cursor.fetchone()
                    slug = row[0] if row and row[0] else None
                    
                    if not slug:
                        logger.error(f"Slug not found for gift {tg_gift_id}. Cannot transfer.")
                        continue

                    from telethon.tl.functions.payments import TransferStarGiftRequest, GetPaymentFormRequest, SendStarsFormRequest
                    from telethon.tl.types import InputSavedStarGiftSlug, InputInvoiceStarGiftTransfer
                    
                    try:
                        # Попытка прямой передачи
                        logger.info(f"Передаю подарок {slug} пользователю {receiver_id}...")
                        await client(TransferStarGiftRequest(
                            stargift=InputSavedStarGiftSlug(slug=slug),
                            to_id=receiver
                        ))
                    except Exception as gift_err:
                        if "PAYMENT_REQUIRED" in str(gift_err):
                            # Если нужна комиссия в звездах - оплачиваем!
                            logger.info(f"💰 Для передачи {slug} нужна комиссия. Оплачиваю...")
                            invoice = InputInvoiceStarGiftTransfer(
                                stargift=InputSavedStarGiftSlug(slug=slug),
                                to_id=receiver
                            )
                            form = await client(GetPaymentFormRequest(invoice=invoice))
                            await client(SendStarsFormRequest(form_id=form.form_id, invoice=invoice))
                            logger.info(f"✅ Комиссия оплачена, подарок {slug} отправлен!")
                        else:
                            raise gift_err

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

async def handle_incoming_gift(event, client):
    """Слушатель входящих подарков на аккаунте дилера"""
    try:
        # Проверяем, есть ли действие (action) в сообщении
        if not event.message or not event.message.action:
            return

        action = event.message.action
        sender_id = event.sender_id
        
        # Разные типы подарков в Telethon
        is_gift = False
        gift_title = "Unknown Gift"
        
        # Обычный или Unique подарок
        if hasattr(types, 'MessageActionStarGift') and isinstance(action, types.MessageActionStarGift):
            is_gift = True
            # Пытаемся достать название из slug
            if hasattr(action, 'gift') and hasattr(action.gift, 'slug'):
                gift_title = action.gift.slug.replace('_', ' ').title()
        elif hasattr(types, 'MessageActionGiftCode') and isinstance(action, types.MessageActionGiftCode):
            is_gift = True
            gift_title = "Telegram Premium / Gift Code"

        if not is_gift:
            return

        logger.info(f"🎁 ПОЛУЧЕН ПОДАРОК от {sender_id}: {gift_title}")

        # 1. Считаем цену
        price = await fetch_floor_price(gift_title)
        
        # 2. Начисляем в БД
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Проверяем юзера
        cursor.execute("SELECT balance FROM users WHERE telegram_id = ?", (sender_id,))
        row = cursor.fetchone()
        
        if row:
            old_balance = row[0]
            new_balance = old_balance + price
            
            # Обновляем баланс
            cursor.execute("UPDATE users SET balance = ? WHERE telegram_id = ?", (new_balance, sender_id))
            
            # Лог транзакции
            cursor.execute("""
                INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description)
                VALUES (?, 'gift_sell', ?, ?, ?, ?)
            """, (sender_id, price, old_balance, new_balance, f"Sold Gift: {gift_title}"))
            
            conn.commit()
            logger.info(f"✅ Баланс юзера {sender_id} пополнен на {price} TON за подарок {gift_title}")
            
            # Опционально: Отправляем уведомление
            try:
                await client.send_message(sender_id, f"✅ Ваш подарок **{gift_title}** принят!\n💰 На баланс зачислено: **{price} TON**")
            except: pass
        else:
            logger.warning(f"⚠️ Юзер {sender_id} прислал подарок, но его нет в БД казино.")
            
        conn.close()

    except Exception as e:
        logger.error(f"Ошибка при обработке входящего подарка: {e}")

async def main():
    # Подгружаем заново для верности (Railway env)
    api_id = os.getenv("TG_API_ID")
    api_hash = os.getenv("TG_API_HASH")
    session_string = os.getenv("TG_SESSION_STRING")

    if not api_id or not api_hash:
        logger.error("КРИТИЧЕСКАЯ ОШИБКА: TG_API_ID или TG_API_HASH не установлены!")
        return

    if not session_string:
         logger.error("КРИТИЧЕСКАЯ ОШИБКА: TG_SESSION_STRING не установлен!")
         return
    
    logger.info(f"Инициализация... Сессия (начало): {session_string[:8]}...")
    
    try:
        from telethon.sessions import StringSession
        client = TelegramClient(
            StringSession(session_string.strip()), 
            int(api_id), 
            api_hash
        )
        
        await client.connect()
        
        if not await client.is_user_authorized():
            logger.error("❌ ОШИБКА АВТОРИЗАЦИИ: Ваша TG_SESSION_STRING не подходит или протухла.")
            logger.error("Пожалуйста, перевыпустите String Session в @session_gen_bot или через скрипт.")
            return

        me = await client.get_me()
        logger.info(f"✅ Успешный вход! Аккаунт: {me.first_name} (ID: {me.id})")
        if me.bot:
            logger.error("!!! ВНИМАНИЕ: Вы вошли как БОТ. NFT-подарки работают ТОЛЬКО на юзер-аккаунтах.")
            
    except Exception as e:
        logger.error(f"❌ Не удалось запустить клиент: {e}")
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
        # Регистрация слушателя событий
        @client.on(events.NewMessage())
        async def event_handler(event):
            await handle_incoming_gift(event, client)

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
