require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { userOps, gameOps, settingsOps } = require('./database');

const { logMonitor, monitoringLogs } = require('./logger');
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

const WELCOME_IMG = `${WEBAPP}/welcome.png`; // Твоя картинка на хостинге

bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const u = msg.from;
    const startParam = (match[1] || '').trim();

    // Resolve referrer from start param
    let referrerId = null;
    if (startParam) {
        if (startParam.startsWith('ref_')) {
            const code = startParam.slice(4);
            const referrer = userOps.getByReferralCode(code);
            if (referrer && referrer.telegram_id !== u.id) {
                referrerId = referrer.telegram_id;
            }
        } else {
            const parsed = parseInt(startParam);
            if (!isNaN(parsed) && parsed !== u.id) referrerId = parsed;
        }
    }

    try {
        const createdUser = userOps.getOrCreate(u.id, u.username || '', u.first_name || '', u.last_name || '', referrerId);

        // Notify referrer about new referral
        if (createdUser._isNew && createdUser._referrerId) {
            const referrer = userOps.get(createdUser._referrerId);
            if (referrer) {
                const newName = u.first_name || u.username || 'Аноним';
                const usernameTag = u.username ? ` (@${u.username})` : '';
                const count = referrer.referral_count || 0;
                try {
                    await bot.sendMessage(createdUser._referrerId,
                        `👤 *Новый реферал!*\n\n` +
                        `${newName}${usernameTag} присоединился по твоей ссылке!\n\n` +
                        `📊 Всего рефералов: *${count}*\n` +
                        `💰 Ты получаешь *10%* с каждого его проигрыша`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) { console.log(`[Bot] Failed to notify referrer ${createdUser._referrerId}:`, e.message); }
            }
        }
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
    } else if (q.data === 'adm_maint' && isAdmin(uid)) {
        const cur = settingsOps.get('maintenance_mode');
        const next = cur === '1' ? '0' : '1';
        settingsOps.set('maintenance_mode', next);
        await bot.sendMessage(chatId, next === '1' ? '🔧 Обслуживание *вкл*' : '✅ Обслуживание *выкл*', { parse_mode: 'Markdown' });
    } else if (q.data === 'adm_status' && isAdmin(uid)) {
        const wallet = settingsOps.get('ton_wallet');
        const logChannel = settingsOps.get('log_channel_id');
        const adminList = (process.env.ADMIN_IDS || 'Не указано');
        await bot.sendMessage(chatId,
            `⚙️ *Статус Системы*\n\n` +
            `👛 *Кошелек:* \`${wallet || 'Не настроено'}\`\n` +
            `📢 *Лог-канал:* \`${logChannel || 'Не настроено'}\`\n` +
            `🔑 *Админы:* \`${adminList}\`\n\n` +
            `_Используйте /setwallet, /setlogchannel для настройки._`,
            { parse_mode: 'Markdown' }
        );
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
                [{ text: '⚙️ Статус Системы', callback_data: 'adm_status' }],
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

bot.onText(/\/setwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const addr = match[1].trim();
    if (addr.length < 30) return bot.sendMessage(msg.chat.id, '❌ Похоже на неверный адрес');
    settingsOps.set('ton_wallet', addr);
    bot.sendMessage(msg.chat.id, `✅ Адрес для пополнений установлен:\n\n\`${addr}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/setlogchannel (.+)/, async (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const cid = match[1].trim();
    settingsOps.set('log_channel_id', cid);
    bot.sendMessage(msg.chat.id, `✅ ID канала для логов установлен:\n\n\`${cid}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/logs/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    if (monitoringLogs.length === 0) return bot.sendMessage(msg.chat.id, '📭 Логи мониторинга пусты.');

    const text = `📋 *Последние события мониторинга:*\n\n` + monitoringLogs.slice(0, 20).join('\n');
    bot.sendMessage(msg.chat.id, text.substring(0, 4000), { parse_mode: 'Markdown' });
});

bot.onText(/\/testlog/, async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const logChannel = process.env.LOG_CHANNEL_ID || settingsOps.get('log_channel_id');
    if (!logChannel) return bot.sendMessage(msg.chat.id, '❌ Канал для логов не настроен. Используйте `/setlogchannel -100...`');

    try {
        await bot.sendMessage(logChannel, `🔔 *ТЕСТОВОЕ УВЕДОМЛЕНИЕ*\nБот успешно подключен к каналу логирования!`, { parse_mode: 'Markdown' });
        bot.sendMessage(msg.chat.id, '✅ Тестовое сообщение отправлено в канал!');
    } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ Ошибка отправки: ${e.message}\n\nУбедитесь, что бот добавлен в канал как администратор.`);
    }
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

// Export bot to use in server.js
module.exports = bot;
