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
            conn = sqlite3.connect(p)
            conn.row_factory = sqlite3.Row
            return conn
    conn = sqlite3.connect("cuberoll.db") # fallback
    conn.row_factory = sqlite3.Row
    return conn

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
                         elif m_name == "GetSavedStarGiftsRequest":
                             # В Telethon 1.42.0+ этот метод часто требует peer, offset, limit
                             # Если он не срабатывает - просто идем к следующему методу без шума в логах
                             try:
                                result = await client(req(peer=me_input, offset='', limit=100))
                             except Exception:
                                try:
                                    result = await client(req(me_input, '', 100))
                                except:
                                    continue # Просто пробуем следующий метод
                         else:
                             try:
                                result = await client(req(user_id=me_input, limit=100))
                             except:
                                continue
                         
                         if result: break
                     except Exception as e:
                         logger.warning(f"Метод {m_name} не сработал: {e}")

        except Exception as e:
             logger.error(f"Не удалось получить инвентарь: {e}")
             return

        if not result:
            logger.warning("Результат запроса инвентаря пуст (None). Проверьте версию Telethon.")
            return

        if not hasattr(result, 'gifts') or not result.gifts:
            logger.warning(f"Список подарков пуст. (Raw result type: {type(result)})")
            # Если это StarGifts - там другое поле может быть
            if hasattr(result, 'star_gifts'):
                logger.info("Найдено поле 'star_gifts', использую его.")
                result.gifts = result.star_gifts
            else:
                return
        
        logger.info(f"Найдено подарков в Телеграме: {len(result.gifts)}")

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
                        m_desc = re.search(r'og:description["\s]+content="([^"]*)"', text)
                        m_img = re.search(r'og:image["\s]+content="([^"]*)"', text)
                        meta = {}
                        if m_img:
                            meta["model"] = m_img.group(1)
                        if m_desc:
                            desc = m_desc.group(1).replace("&#10;", "\n")
                            for line in desc.split("\n"):
                                if "Model:" in line and "model" not in meta: meta["model"] = line.split("Model:")[1].strip()
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

            cursor.execute("SELECT id, model FROM gifts WHERE gift_id = ?", (tg_gift_id,))
            existing = cursor.fetchone()
            
            meta = await parse_nft_meta(slug, tg_gift_id)
            m_url = meta.get("model", "https://i.imgur.com/8YvYyZp.png")
            b_style = meta.get("backdrop", "radial-gradient(circle, #333, #000)")
            sym = meta.get("symbol", "🎁")
            full_link = f"https://t.me/nft/{slug}-{tg_gift_id}"

            if existing:
                # Если подарок есть, ОБЯЗАТЕЛЬНО активируем его (если он был удален)
                # И обновляем данные, если они изменились
                logger.info(f"Gift '{api_title}' already exists. Ensuring it is active...")
                cursor.execute("""
                    UPDATE gifts 
                    SET is_active = 1, model = ?, background = ?, symbol = ?, link = ?, slug = ?, title = ?
                    WHERE gift_id = ?
                """, (m_url, b_style, sym, full_link, slug, api_title, tg_gift_id))
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
            
            if matched_id:
                logger.info(f"Linking '{api_title}' to existing item #{matched_id}")
                cursor.execute("""
                    UPDATE gifts SET gift_id = ?, model = ?, background = ?, symbol = ?, slug = ?, link = ?
                    WHERE id = ?
                """, (tg_gift_id, m_url, b_style, sym, slug, full_link, matched_id))
            else:
                logger.info(f"Adding new gift: {api_title}")
                price = await fetch_floor_price(api_title)
                cursor.execute("""
                    INSERT OR REPLACE INTO gifts (title, price, gift_id, is_active, model, background, symbol, slug, link)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
                """, (api_title, price, tg_gift_id, m_url, b_style, sym, slug, full_link))
            
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

            # Берем незавершенные переводы + информацию о юзере (username)
            cursor.execute("""
                SELECT t.id, t.receiver_id, u.username, g.gift_id, g.title, g.id as db_gift_id
                FROM gift_transfers t
                JOIN gifts g ON t.gift_id = g.id
                JOIN users u ON t.receiver_id = u.telegram_id
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
                    receiver = None
                    try:
                        # Сначала пробуем по ID
                        receiver = await client.get_input_entity(int(receiver_id))
                    except Exception:
                        # Если по ID не вышло (PeerUser error), пробуем по username если он есть
                        username = row['username']
                        if username:
                            try:
                                logger.info(f"ID {receiver_id} не найден в кэше, пробую по username @{username}...")
                                receiver = await client.get_input_entity(username)
                            except Exception as ent_err:
                                logger.error(f"Не удалось найти @{username}: {ent_err}")
                        
                    if not receiver:
                        logger.error(f"Не могу найти сущность для юзера {receiver_id}. Пропуск.")
                        continue

                    # 2. Ищем данные подарка (slug и gift_id)
                    cursor.execute("SELECT slug, gift_id FROM gifts WHERE gift_id = ? OR id = ?", (tg_gift_id, row['db_gift_id']))
                    gift_row = cursor.fetchone()
                    slug = gift_row['slug'] if gift_row and gift_row['slug'] else None
                    raw_id = gift_row['gift_id'] if gift_row and gift_row['gift_id'] else None
                    
                    if not slug and not raw_id:
                        logger.error(f"Data not found for gift {tg_gift_id or row['db_gift_id']}. Cannot transfer.")
                        continue

                    # Чистим slug от лишних символов (иногда туда попадают пробелы или ковычки)
                    if slug:
                        slug = slug.strip().replace(" ", "_")

                    from telethon.tl import functions, types
                    
                    # ГИБКИЙ ПОИСК ТИПОВ (Защита от разных версий Telethon)
                    TransferReq = getattr(functions.payments, 'TransferStarGiftRequest', None)
                    GetFormReq = getattr(functions.payments, 'GetPaymentFormRequest', None)
                    SendFormReq = getattr(functions.payments, 'SendStarsFormRequest', None)
                    
                    # Ищем типы через перебор (в разных версиях они могут быть в разных местах)
                    def find_type(name):
                        res = getattr(types, name, None)
                        if not res:
                            # Пробуем поискать в payments
                            res = getattr(functions.payments, name, None)
                        return res

                    InputSlug = find_type('InputSavedStarGiftSlug')
                    InputId = find_type('InputSavedStarGiftId')
                    InputInvoice = find_type('InputInvoiceStarGiftTransfer')
                    
                    if not TransferReq or not InputSlug:
                        logger.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Версия Telethon слишком старая.")
                        logger.error("Выполните команду для обновления: /root/CubeRoll/venv/bin/pip install --upgrade telethon")
                        # Прерываем цикл, так как без этих типов передача невозможна
                        break

                    async def try_transfer(stargift_obj):
                        return await client(TransferReq(
                            stargift=stargift_obj,
                            to_id=receiver
                        ))

                    try:
                        # 1. Пробуем по Slug (как есть)
                        logger.info(f"Отправка {slug or raw_id} юзеру {receiver_id}...")
                        
                        target_input = None
                        if slug and InputSlug:
                            target_input = InputSlug(slug=slug)
                        elif raw_id and InputId:
                            target_input = InputId(gift_id=int(raw_id))
                        
                        if not target_input: 
                            raise Exception("Нет данных для идентификации подарка")
                            
                        await try_transfer(target_input)
                        
                    except Exception as gift_err:
                        err_str = str(gift_err).upper()
                        
                        # 2. Если ошибка SLUG_INVALID - пробуем Lowercase или ID
                        if "STARGIFT_SLUG_INVALID" in err_str:
                            if slug and slug != slug.lower() and InputSlug:
                                logger.warning(f"Slug {slug} не подошел, пробую {slug.lower()}...")
                                try:
                                    await try_transfer(InputSlug(slug=slug.lower()))
                                    logger.info("✅ Успешно отправлено (lowercase)!")
                                except Exception as e2:
                                    gift_err = e2
                                    err_str = str(e2).upper()

                            # 3. Финальный Fallback на ID
                            if "STARGIFT_SLUG_INVALID" in err_str and raw_id and InputId:
                                logger.warning(f"Slug не работает совсем, пробую ID {raw_id}...")
                                await try_transfer(InputId(gift_id=int(raw_id)))
                                logger.info("✅ Успешно отправлено по ID!")
                            else:
                                raise gift_err
                                
                        elif "PAYMENT_REQUIRED" in err_str and GetFormReq and SendFormReq and InputInvoice:
                            # Оплата комиссии (Stars)
                            logger.info(f"💰 Оплачиваю комиссию для {slug or raw_id}...")
                            
                            current_input = None
                            if slug and InputSlug: current_input = InputSlug(slug=slug)
                            elif raw_id and InputId: current_input = InputId(gift_id=int(raw_id))
                            
                            if not current_input: raise gift_err

                            invoice = InputInvoice(stargift=current_input, to_id=receiver)
                            form = await client(GetFormReq(invoice=invoice))
                            await client(SendFormReq(form_id=form.form_id, invoice=invoice))
                            logger.info(f"✅ Комиссия оплачена, подарок отправлен!")
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
