require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { userOps, gameOps, settingsOps } = require('./database');

const TOKEN = process.env.BOT_TOKEN;
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
let WEBAPP = process.env.WEBAPP_URL || 'https://your-domain.com';
if (WEBAPP && !WEBAPP.startsWith('http')) WEBAPP = 'https://' + WEBAPP;
if (WEBAPP.endsWith('/')) WEBAPP = WEBAPP.slice(0, -1);

if (!TOKEN) { console.error('нет BOT_TOKEN в .env'); process.exit(1); }
if (WEBAPP.includes('your-domain.com')) {
    console.warn('⚠️ ПРЕДУПРЕЖДЕНИЕ: WEBAPP_URL не настроен! Ссылка в боте не будет работать.');
}

const bot = new TelegramBot(TOKEN, { polling: true });

function isAdmin(id) {
    const ok = ADMINS.includes(Number(id));
    if (!ok) console.log(`Access denied for ${id}. Admin list:`, ADMINS);
    return ok;
}

const WELCOME_IMG = 'https://i.imgur.com/8YvYyZp.png'; // Твоя картинка (можно заменить на /welcome.png если есть на хостинге)

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const u = msg.from;

    try {
        userOps.getOrCreate(u.id, u.username || '', u.first_name || '', u.last_name || '');
    } catch (e) { }

    const caption = `👑 *CubeRoll Casino*\n\nПривет, ${u.first_name || 'игрок'}!\n\nИграй в кости и выигрывай TON. Самый честный софт на блокчейне.\n\nЖми кнопку ниже, чтобы начать!`;
    const markup = {
        inline_keyboard: [
            [{ text: '🚀 ЗАПУСТИТЬ ИГРУ', web_app: { url: WEBAPP } }]
        ]
    };

    try {
        await bot.sendPhoto(chatId, WELCOME_IMG, { caption, parse_mode: 'Markdown', reply_markup: markup });
    } catch (e) {
        await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: markup });
    }
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const uid = q.from.id;

    // админские
    if (q.data === 'adm_stats' && isAdmin(uid)) {
        const st = gameOps.getStats();
        const td = gameOps.getTodayStats();
        const uc = userOps.getCount();

        await bot.sendMessage(chatId,
            `📊 *Статистика*\n\n` +
            `👥 Юзеров: ${uc}\n` +
            `🎮 Игр: ${st.total_games || 0}\n` +
            `💰 Поставлено: ${(st.total_wagered || 0).toFixed(2)}\n` +
            `💸 Выплачено: ${(st.total_payouts || 0).toFixed(2)}\n` +
            `📈 Профит: ${(-(st.total_profit || 0)).toFixed(2)}\n\n` +
            `_Сегодня: ${td.total_games || 0} игр, профит ${(-(td.total_profit || 0)).toFixed(2)}_`,
            { parse_mode: 'Markdown' }
        );
        return bot.answerCallbackQuery(q.id);
    }

    if (q.data === 'adm_maint' && isAdmin(uid)) {
        const cur = settingsOps.get('maintenance_mode');
        const next = cur === '1' ? '0' : '1';
        settingsOps.set('maintenance_mode', next);
        await bot.sendMessage(chatId, next === '1' ? '🔧 Обслуживание *вкл*' : '✅ Обслуживание *выкл*', { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(q.id);
    }

    bot.answerCallbackQuery(q.id);
});

// админ команды
bot.onText(/\/admin/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    await bot.sendMessage(msg.chat.id, '👑 *Админка*', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 Стата', callback_data: 'adm_stats' }],
                [{ text: '🔧 Обслуживание', callback_data: 'adm_maint' }],
                [{ text: '👑 Веб-панель', web_app: { url: `${WEBAPP}/admin` } }]
            ]
        }
    });
});

bot.onText(/\/setbalance (\d+) ([\d.]+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const r = userOps.setBalance(parseInt(match[1]), parseFloat(match[2]));
    if (!r) return bot.sendMessage(msg.chat.id, '❌ Юзер не найден');
    await bot.sendMessage(msg.chat.id, `✅ \`${match[1]}\`: ${r.balanceBefore.toFixed(2)} → *${r.balanceAfter.toFixed(2)}*`, { parse_mode: 'Markdown' });
});

bot.onText(/\/ban (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    userOps.ban(parseInt(match[1]));
    bot.sendMessage(msg.chat.id, `🚫 \`${match[1]}\` забанен`, { parse_mode: 'Markdown' });
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    userOps.unban(parseInt(match[1]));
    bot.sendMessage(msg.chat.id, `✅ \`${match[1]}\` разбанен`, { parse_mode: 'Markdown' });
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const users = userOps.getAll();
    let ok = 0, fail = 0;
    for (const u of users) {
        try { await bot.sendMessage(u.telegram_id, `📢 ${match[1]}`); ok++; }
        catch (e) { fail++; }
    }
    bot.sendMessage(msg.chat.id, `📢 Отправлено: ${ok}, ошибок: ${fail}`);
});

// bot initialized
