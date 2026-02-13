# CubeRoll 🎲

тг мини апп казино с дайсами

## запуск

```
npm install
node server.js   # вебапп на :3000
node bot.js      # тг бот (отдельный терминал)
```

## .env

```
BOT_TOKEN=        # от @BotFather
ADMIN_IDS=123456  # твой тг id (от @userinfobot)
PORT=3000
WEBAPP_URL=https://your-domain.com
```

без BOT_TOKEN работает в дев режиме (localhost, без авторизации тг)

## что есть

- 6 типов ставок (больше/меньше/7/чёт/нечёт/дубль + exact)
- 3d кубики с анимацией
- provably fair (hmac-sha256, верификация)
- история игр + лидерборд
- админ бот (/admin, /setbalance, /ban, /broadcast)
- веб админка (/admin)
- sqlite бд

## деплой

нужен https для тг вебапп. варианты:
- railway.app (проще всего)
- vps + nginx + certbot
- ngrok для тестов
