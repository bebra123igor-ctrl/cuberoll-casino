require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { userOps, gameOps, settingsOps } = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-domain.com';

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is required in .env file');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

// ===== User Commands =====

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    // Register the user
    userOps.getOrCreate(user.id, user.username || '', user.first_name || '', user.last_name || '');

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🎲 Играть в CubeRoll', web_app: { url: WEBAPP_URL } }],
                [{ text: '📊 Мой профиль', callback_data: 'profile' }],
                [{ text: '🏆 Топ игроков', callback_data: 'leaderboard' }]
            ]
        }
    };

    await bot.sendMessage(chatId,
        `🎲 *Добро пожаловать в CubeRoll Casino!*\n\n` +
        `Привет, ${user.first_name}! 🎰\n\n` +
        `🎯 *Как играть:*\n` +
        `• Выбери тип ставки (Больше/Меньше/Чёт/Нечет и др.)\n` +
        `• Выбери сумму ставки\n` +
        `• Бросай кости!\n\n` +
        `🔒 *Provably Fair* — каждая игра проверяема!\n` +
        `💰 Стартовый баланс: ${settingsOps.get('starting_balance') || 1000} монет\n\n` +
        `Нажми кнопку ниже, чтобы начать играть! 👇`,
        { parse_mode: 'Markdown', ...keyboard }
    );
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    if (query.data === 'profile') {
        const user = userOps.get(userId);
        if (!user) {
            return bot.answerCallbackQuery(query.id, { text: 'Профиль не найден. Нажмите /start' });
        }

        const winRate = user.games_played > 0
            ? ((user.games_won / user.games_played) * 100).toFixed(1)
            : '0.0';

        await bot.sendMessage(chatId,
            `👤 *Ваш профиль*\n\n` +
            `🆔 ID: \`${user.telegram_id}\`\n` +
            `👤 Имя: ${user.first_name || 'N/A'}\n` +
            `💰 Баланс: *${user.balance.toFixed(2)}* монет\n` +
            `🎮 Игр сыграно: ${user.games_played}\n` +
            `🏆 Побед: ${user.games_won}\n` +
            `📊 Процент побед: ${winRate}%\n` +
            `💵 Всего поставлено: ${user.total_wagered.toFixed(2)}\n` +
            `✅ Всего выиграно: ${user.total_won.toFixed(2)}\n` +
            `❌ Всего проиграно: ${user.total_lost.toFixed(2)}`,
            { parse_mode: 'Markdown' }
        );
        return bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'leaderboard') {
        const top = userOps.getTopPlayers(10);

        let text = '🏆 *Топ 10 игроков*\n\n';
        top.forEach((p, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const prefix = i < 3 ? medals[i] : `${i + 1}.`;
            const name = p.username ? `@${p.username}` : (p.first_name || `User ${p.telegram_id}`);
            text += `${prefix} ${name} — *${p.balance.toFixed(2)}* монет\n`;
        });

        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(query.id);
    }

    // Admin callbacks
    if (query.data === 'admin_stats' && isAdmin(userId)) {
        const stats = gameOps.getStats();
        const todayStats = gameOps.getTodayStats();
        const userCount = userOps.getCount();

        await bot.sendMessage(chatId,
            `📊 *Статистика казино*\n\n` +
            `*Общая:*\n` +
            `👥 Всего пользователей: ${userCount}\n` +
            `🎮 Всего игр: ${stats.total_games || 0}\n` +
            `💰 Поставлено: ${(stats.total_wagered || 0).toFixed(2)}\n` +
            `💸 Выплачено: ${(stats.total_payouts || 0).toFixed(2)}\n` +
            `📈 Прибыль казино: ${(-(stats.total_profit || 0)).toFixed(2)}\n\n` +
            `*Сегодня:*\n` +
            `🎮 Игр: ${todayStats.total_games || 0}\n` +
            `💰 Поставлено: ${(todayStats.total_wagered || 0).toFixed(2)}\n` +
            `💸 Выплачено: ${(todayStats.total_payouts || 0).toFixed(2)}\n` +
            `📈 Прибыль: ${(-(todayStats.total_profit || 0)).toFixed(2)}`,
            { parse_mode: 'Markdown' }
        );
        return bot.answerCallbackQuery(query.id);
    }

    if (query.data === 'admin_maintenance' && isAdmin(userId)) {
        const current = settingsOps.get('maintenance_mode');
        const newValue = current === '1' ? '0' : '1';
        settingsOps.set('maintenance_mode', newValue);

        await bot.sendMessage(chatId,
            newValue === '1'
                ? '🔧 Режим обслуживания *ВКЛЮЧЁН*. Игры приостановлены.'
                : '✅ Режим обслуживания *ВЫКЛЮЧЕН*. Игры возобновлены.',
            { parse_mode: 'Markdown' }
        );
        return bot.answerCallbackQuery(query.id);
    }

    bot.answerCallbackQuery(query.id);
});

// ===== Admin Commands =====

bot.onText(/\/admin/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
                [{ text: '🔧 Вкл/Выкл обслуживание', callback_data: 'admin_maintenance' }],
                [{ text: '👑 Админ панель', web_app: { url: `${WEBAPP_URL}/admin` } }]
            ]
        }
    };

    await bot.sendMessage(msg.chat.id,
        `👑 *Панель администратора*\n\n` +
        `Выберите действие:`,
        { parse_mode: 'Markdown', ...keyboard }
    );
});

// /setbalance <user_id> <amount>
bot.onText(/\/setbalance (\d+) ([\d.]+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const targetId = parseInt(match[1]);
    const amount = parseFloat(match[2]);

    const result = userOps.setBalance(targetId, amount);
    if (!result) {
        return bot.sendMessage(msg.chat.id, '❌ Пользователь не найден');
    }

    await bot.sendMessage(msg.chat.id,
        `✅ Баланс пользователя \`${targetId}\` изменён:\n` +
        `${result.balanceBefore.toFixed(2)} → *${result.balanceAfter.toFixed(2)}*`,
        { parse_mode: 'Markdown' }
    );
});

// /ban <user_id>
bot.onText(/\/ban (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const targetId = parseInt(match[1]);
    userOps.ban(targetId);
    await bot.sendMessage(msg.chat.id, `🚫 Пользователь \`${targetId}\` забанен`, { parse_mode: 'Markdown' });
});

// /unban <user_id>
bot.onText(/\/unban (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const targetId = parseInt(match[1]);
    userOps.unban(targetId);
    await bot.sendMessage(msg.chat.id, `✅ Пользователь \`${targetId}\` разбанен`, { parse_mode: 'Markdown' });
});

// /broadcast <message>
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;

    const text = match[1];
    const users = userOps.getAll();
    let sent = 0;
    let failed = 0;

    for (const user of users) {
        try {
            await bot.sendMessage(user.telegram_id, `📢 *Объявление:*\n\n${text}`, { parse_mode: 'Markdown' });
            sent++;
        } catch (e) {
            failed++;
        }
    }

    await bot.sendMessage(msg.chat.id, `📢 Рассылка завершена: ✅ ${sent} отправлено, ❌ ${failed} ошибок`);
});

console.log('🤖 CubeRoll Bot is running...');
console.log(`👑 Admin IDs: ${ADMIN_IDS.join(', ')}`);
