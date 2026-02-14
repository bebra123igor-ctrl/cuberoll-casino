import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

async def main():
    print("--- Генератор Session String для CubeRoll ---")
    
    # Ваши данные
    api_id = 34803698
    api_hash = "eaa47f97d6780e00f23ec3f190b59651"

    # Создаем клиент
    client = TelegramClient(StringSession(), api_id, api_hash)
    
    async with client:
        print("\nАвторизация успешна!")
        print("\nВАШ TG_SESSION_STRING (скопируйте его ПОЛНОСТЬЮ):\n")
        session_str = client.session.save()
        print(session_str)
        print("\n-------------------------------------------")
        print("Сохраните эту строку в переменные Railway (TG_SESSION_STRING)")

if __name__ == "__main__":
    asyncio.run(main())