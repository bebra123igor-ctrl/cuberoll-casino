require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { userOps, gameOps, settingsOps } = require('./database');

const TOKEN = process.env.BOT_TOKEN;
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
const WEBAPP = process.env.WEBAPP_URL || 'https://your-domain.com';

if (!TOKEN) { console.error('нет BOT_TOKEN в .env'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

function isAdmin(id) { return ADMINS.includes(id); }

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const u = msg.from;
    userOps.getOrCreate(u.id, u.username || '', u.first_name || '', u.last_name || '');

    const startBal = settingsOps.get('starting_balance') || 1000;

    await bot.sendMessage(chatId,
        `🎲 *CubeRoll Casino*\n\n` +
        `Привет, ${u.first_name}!\n\n` +
        `Как играть:\n` +
        `• Выбираешь тип ставки\n` +
        `• Ставишь сумму\n` +
        `• Бросаешь кости\n\n` +
        `🔒 Provably Fair — каждая игра проверяема\n` +
        `💰 Стартовый баланс: ${startBal}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎲 Играть', web_app: { url: WEBAPP } }],
                    [{ text: '📊 Профиль', callback_data: 'profile' }, { text: '🏆 Топ', callback_data: 'top' }]
                ]
            }
        }
    );
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const uid = q.from.id;

    if (q.data === 'profile') {
        const user = userOps.get(uid);
        if (!user) return bot.answerCallbackQuery(q.id, { text: 'Нажми /start' });

        const wr = user.games_played > 0 ? ((user.games_won / user.games_played) * 100).toFixed(1) : '0';

        await bot.sendMessage(chatId,
            `👤 *Профиль*\n\n` +
            `ID: \`${user.telegram_id}\`\n` +
            `💰 Баланс: *${user.balance.toFixed(2)}*\n` +
            `🎮 Игр: ${user.games_played} (побед: ${user.games_won})\n` +
            `📊 Винрейт: ${wr}%\n` +
            `💵 Поставлено: ${user.total_wagered.toFixed(2)}\n` +
            `✅ Выиграно: ${user.total_won.toFixed(2)}\n` +
            `❌ Проиграно: ${user.total_lost.toFixed(2)}`,
            { parse_mode: 'Markdown' }
        );
        return bot.answerCallbackQuery(q.id);
    }

    if (q.data === 'top') {
        const top = userOps.getTopPlayers(10);
        const medals = ['🥇', '🥈', '🥉'];
        let txt = '🏆 *Топ игроков*\n\n';
        top.forEach((p, i) => {
            const name = p.username ? `@${p.username}` : (p.first_name || `#${p.telegram_id}`);
            txt += `${i < 3 ? medals[i] : (i + 1) + '.'} ${name} — *${p.balance.toFixed(2)}*\n`;
        });
        await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(q.id);
    }

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

console.log('bot started');
