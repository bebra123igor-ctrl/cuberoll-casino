# 🎲 CubeRoll Casino — Telegram Mini App

Полноценное казино в Telegram Mini App с бросанием костей, Provably Fair системой, и админ-панелью.

## 🚀 Быстрый старт

### 1. Установка
```bash
npm install
```

### 2. Настройка
Скопируй `.env.example` в `.env` и заполни:
```env
BOT_TOKEN=123456:ABC-DEF...       # Токен бота от @BotFather
ADMIN_IDS=123456789               # Твой Telegram ID
WEBAPP_URL=https://your-domain.com # URL где хостишь WebApp
```

### 3. Запуск
```bash
# Запуск сервера (WebApp)
node server.js

# Запуск бота (в отдельном терминале)
node bot.js
```

### 4. Деплой
Для работы как Telegram WebApp нужен **HTTPS**. Варианты:
- **[Railway](https://railway.app)** — бесплатный деплой
- **VPS + Nginx + Let's Encrypt**
- **ngrok** — для тестирования: `ngrok http 3000`

После деплоя:
1. Открой @BotFather → `/mybots` → Твой бот → `Bot Settings` → `Menu Button`
2. Установи URL: `https://your-domain.com`

---

## 🎮 Функции

### Игра
- **6 типов ставок**: Больше (8-12), Меньше (2-6), Семёрка, Чёт, Нечёт, Дубль
- **3D анимация** бросания костей
- **Provably Fair** — каждая игра криптографически верифицируема
- **Конфетти** при выигрыше
- **Haptic feedback** в Telegram

### Пользователь
- Автоматический вход через Telegram
- Баланс, история игр, таблица лидеров
- Смена client/server seed для верификации

### Админ-бот (Telegram)
| Команда | Описание |
|---------|----------|
| `/start` | Открыть казино |
| `/admin` | Админ-панель |
| `/setbalance <id> <amount>` | Установить баланс |
| `/ban <id>` | Забанить |
| `/unban <id>` | Разбанить |
| `/broadcast <текст>` | Рассылка всем |

### Админ-панель (Web)
- Статистика казино (общая + за сегодня)
- Управление пользователями (баланс, бан)
- Просмотр всех игр
- Настройки (мин/макс ставка, стартовый баланс, обслуживание)

---

## 🔒 Provably Fair

Каждая игра верифицируема:

1. **До игры**: сервер показывает SHA-256 хеш серверного сида
2. **Игра**: результат генерируется из `HMAC-SHA256(serverSeed, clientSeed:nonce)`
3. **После**: можно раскрыть серверный сид и проверить хеш

Пользователь может:
- Установить свой client seed
- Сменить server seed (раскрывает старый)
- Верифицировать любую прошлую игру

---

## 📁 Структура

```
CubeRoll/
├── server.js           # Express сервер + API
├── bot.js              # Telegram бот для админки
├── database.js         # SQLite база данных
├── provably-fair.js    # Система честной игры
├── .env                # Конфигурация
├── .env.example        # Пример конфигурации
├── package.json
└── public/
    ├── index.html      # Главная страница WebApp
    ├── style.css       # Стили (тёмная тема)
    ├── app.js          # Фронтенд логика
    └── admin.html      # Админ-панель
```

---

## 🛠 Технологии

- **Backend**: Node.js, Express
- **Database**: SQLite (better-sqlite3)
- **Bot**: node-telegram-bot-api
- **Frontend**: Vanilla JS, CSS3 (3D transforms, animations)
- **Auth**: Telegram WebApp HMAC validation
- **Fair**: HMAC-SHA256 provably fair
