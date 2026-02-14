require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { userOps, gameOps, settingsOps, giftOps, depositOps } = require('./database');
const ProvablyFair = require('./provably-fair');
require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => Number(id.trim())).filter(id => !isNaN(id));

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// валидация данных от тг вебапп (hmac проверка)
function validateTgData(initData) {
    if (!BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const sorted = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

        const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const check = crypto.createHmac('sha256', secret).update(sorted).digest('hex');

        if (check !== hash) return null;
        return JSON.parse(params.get('user') || '{}');
    } catch (e) {
        console.error('auth err:', e);
        return null;
    }
}

// мидлвара авторизации
function auth(req, res, next) {
    const data = req.headers['x-telegram-init-data'];

    // дев мод без токена
    if (!BOT_TOKEN && req.headers['x-dev-user-id']) {
        req.tgUser = { id: parseInt(req.headers['x-dev-user-id']), username: 'dev_user', first_name: 'Developer' };
        return next();
    }

    if (!data) return res.status(401).json({ error: 'No auth data provided' });

    const user = validateTgData(data);
    if (!user) return res.status(401).json({ error: 'Invalid auth data' });

    req.tgUser = user;
    next();
}

function adminOnly(req, res, next) {
    if (!req.tgUser || !ADMIN_IDS.includes(req.tgUser.id))
        return res.status(403).json({ error: 'Access denied' });
    next();
}

// сиды в памяти (при рестарте сбрасываются, это ок - просто новая сессия)
const seeds = {};

function getSeed(tgId) {
    if (!seeds[tgId]) {
        seeds[tgId] = {
            serverSeed: ProvablyFair.generateServerSeed(),
            clientSeed: ProvablyFair.generateClientSeed(),
            nonce: 0,
            hash: ''
        };
        seeds[tgId].hash = ProvablyFair.hashServerSeed(seeds[tgId].serverSeed);
    }
    return seeds[tgId];
}


// --- роуты ---

// авторизация + получение профиля
app.post('/api/auth', auth, (req, res) => {
    const u = req.tgUser;
    const user = userOps.getOrCreate(u.id, u.username || '', u.first_name || '', u.last_name || '');
    if (user.is_banned) return res.status(403).json({ error: 'Account is banned' });

    const s = getSeed(u.id);
    res.json({
        user: {
            telegramId: user.telegram_id, username: user.username, firstName: user.first_name,
            balance: user.balance, gamesPlayed: user.games_played, gamesWon: user.games_won,
            totalWagered: user.total_wagered, totalWon: user.total_won, totalLost: user.total_lost,
            lastDailyClaim: user.last_daily_claim, walletAddress: user.wallet_address
        },
        seeds: s,
        settings: {
            minBet: parseFloat(settingsOps.get('min_bet') || '10'),
            maxBet: parseFloat(settingsOps.get('max_bet') || '10000'),
            tonWallet: settingsOps.get('ton_wallet'),
            minDeposit: parseFloat(settingsOps.get('min_deposit') || '0.1')
        },
        isAdmin: ADMIN_IDS.includes(u.id)
    });
});

app.post('/api/user/wallet', auth, (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    userOps.updateWallet(req.tgUser.id, address);
    res.json({ success: true });
});

// ставка
app.post('/api/bet', auth, (req, res) => {
    const u = req.tgUser;
    const user = userOps.get(u.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned) return res.status(403).json({ error: 'Account is banned' });
    if (settingsOps.get('maintenance_mode') === '1') return res.status(503).json({ error: 'Casino is under maintenance' });

    const { betAmount, betType, exactNumber, rangeMin, rangeMax } = req.body;
    if (!betAmount || !betType) return res.status(400).json({ error: 'Missing bet amount or type' });

    const amt = parseFloat(betAmount);
    const minBet = parseFloat(settingsOps.get('min_bet') || '10');
    const maxBet = parseFloat(settingsOps.get('max_bet') || '10000');

    if (isNaN(amt) || amt < minBet || amt > maxBet) return res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet}` });
    if (amt > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

    // тип ставки — exact и range обрабатываем отдельно
    const validBets = ['high', 'low', 'seven', 'even', 'odd', 'doubles', 'exact', 'range'];
    if (!validBets.includes(betType)) return res.status(400).json({ error: 'Invalid bet type' });

    // конвертируем exact в exact_N
    let resolvedType = betType;
    let rangeBounds = null;
    if (betType === 'exact') {
        const n = parseInt(exactNumber);
        if (isNaN(n) || n < 2 || n > 12) return res.status(400).json({ error: 'Exact number must be 2-12' });
        resolvedType = `exact_${n}`;
    }
    if (betType === 'range') {
        const rMin = parseInt(rangeMin), rMax = parseInt(rangeMax);
        if (isNaN(rMin) || isNaN(rMax) || rMin < 2 || rMax > 12 || rMin >= rMax) return res.status(400).json({ error: 'Invalid range' });
        rangeBounds = { min: rMin, max: rMax };
        resolvedType = 'range';
    }

    const s = getSeed(u.id);
    s.nonce++;

    const dice = ProvablyFair.generateDice(s.serverSeed, s.clientSeed, s.nonce);
    const result = ProvablyFair.calculatePayout(resolvedType, dice, amt, rangeBounds);

    const change = result.won ? (result.payout - amt) : -amt;
    userOps.updateBalance(u.id, change, result.won ? 'win' : 'loss',
        `Dice: ${resolvedType} | ${dice.dice.join(',')} (${dice.total})`
    );
    userOps.updateStats(u.id, amt, result.won, result.profit);

    gameOps.create({
        telegramId: u.id, betAmount: amt, gameType: 'dice', playerChoice: resolvedType,
        diceResult: dice.dice.join(','), diceTotal: dice.total,
        multiplier: result.multiplier, payout: result.payout, profit: result.profit,
        serverSeed: s.serverSeed, clientSeed: s.clientSeed, nonce: s.nonce, hash: dice.hash, won: result.won
    });

    const updated = userOps.get(u.id);
    res.json({
        result: { dice: dice.dice, total: dice.total, won: result.won, multiplier: result.multiplier, payout: result.payout, profit: result.profit, newBalance: updated.balance },
        fairness: { serverSeedHash: s.hash, clientSeed: s.clientSeed, nonce: s.nonce }
    });
});

// ротация сидов (показываем старый, генерим новый)
app.post('/api/seeds/rotate', auth, (req, res) => {
    const s = getSeed(req.tgUser.id);
    const oldSeed = s.serverSeed;
    const oldHash = s.hash;

    s.serverSeed = ProvablyFair.generateServerSeed();
    s.hash = ProvablyFair.hashServerSeed(s.serverSeed);
    s.nonce = 0;
    if (req.body.clientSeed) s.clientSeed = req.body.clientSeed;

    res.json({ oldServerSeed: oldSeed, oldServerSeedHash: oldHash, newServerSeedHash: s.hash, clientSeed: s.clientSeed, nonce: s.nonce });
});

// обновление клиент сида
app.post('/api/seeds/client', auth, (req, res) => {
    const { clientSeed } = req.body;
    if (!clientSeed || clientSeed.length < 1) return res.status(400).json({ error: 'Invalid client seed' });
    const s = getSeed(req.tgUser.id);
    s.clientSeed = clientSeed;
    res.json({ clientSeed: s.clientSeed });
});

app.get('/api/history', auth, (req, res) => {
    res.json({ games: gameOps.getByUser(req.tgUser.id, 50) });
});

// верификация (публичный эндпоинт)
app.post('/api/verify', (req, res) => {
    const { serverSeed, clientSeed, nonce } = req.body;
    if (!serverSeed || !clientSeed || nonce === undefined) return res.status(400).json({ error: 'Missing parameters' });
    const r = ProvablyFair.verify(serverSeed, clientSeed, parseInt(nonce));
    res.json({ dice: r.dice, total: r.total, serverSeedHash: ProvablyFair.hashServerSeed(serverSeed) });
});

app.get('/api/leaderboard', auth, (req, res) => {
    const top = userOps.getTopPlayers(20);
    res.json({
        players: top.map(p => ({
            username: p.username || p.first_name || `User ${p.telegram_id}`,
            balance: p.balance, gamesPlayed: p.games_played, gamesWon: p.games_won
        }))
    });
});

// подарки
app.get('/api/gifts', auth, (req, res) => {
    res.json({ gifts: giftOps.getAll() });
});

app.get('/api/gifts/:id', auth, (req, res) => {
    const g = giftOps.get(parseInt(req.params.id));
    if (!g) return res.status(404).json({ error: 'Not found' });
    res.json(g);
});

app.post('/api/gifts/buy', auth, (req, res) => {
    const { giftId } = req.body;
    const user = userOps.get(req.tgUser.id);
    const gift = giftOps.get(giftId);
    if (!gift) return res.status(404).json({ error: 'Gift not found' });
    if (user.balance < gift.price) return res.status(400).json({ error: 'Insufficient balance' });

    userOps.updateBalance(req.tgUser.id, -gift.price, 'gift_buy', `Bought ${gift.title}`);
    giftOps.delete(giftId); // Это помечает is_active = 0
    const updated = userOps.get(req.tgUser.id);
    res.json({ success: true, newBalance: updated.balance });
});

app.post('/api/deposit/request', auth, (req, res) => {
    const { amount } = req.body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 0.1) return res.status(400).json({ error: 'Min 0.1 TON' });

    const comment = 'CR-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    try {
        depositOps.createPending(req.tgUser.id, amt, comment);
    } catch (e) {
        return res.status(500).json({ error: 'Could not create request' });
    }

    let wallet = process.env.TON_WALLET || settingsOps.get('ton_wallet');
    // Если в .env или базе заглушка, возвращаем ошибку
    if (!wallet || wallet.includes('...') || wallet === 'UQ...') {
        return res.status(500).json({ error: 'Admin wallet address is not configured yet.' });
    }
    res.json({ comment, address: wallet });
});

app.get('/api/deposit/check', auth, (req, res) => {
    const pending = depositOps.getPendingByUser(req.tgUser.id);
    res.json({ pending });
});

// Фоновая проверка транзакций TON
const https = require('https');

function parseTonComment(msg) {
    if (!msg) return null;

    if (typeof msg.message === 'string' && msg.message.trim()) {
        return msg.message.trim();
    }

    if (msg.msg_data && typeof msg.msg_data.text === 'string' && msg.msg_data.text.trim()) {
        return msg.msg_data.text.trim();
    }

    if (msg.msg_data && msg.msg_data['@type'] === 'msg.dataRaw' && typeof msg.msg_data.body === 'string') {
        try {
            const body = Buffer.from(msg.msg_data.body, 'base64');
            if (body.length <= 4) return null;
            const opcode = body.readUInt32BE(0);
            if (opcode !== 0) return null;
            const text = body.subarray(4).toString('utf8').replace(/\0+$/, '').trim();
            return text || null;
        } catch (e) {
            return null;
        }
    }

    return null;
}

async function checkTonTransactions() {
    const settings = settingsOps.getAll();
    let addr = settings.ton_wallet;

    // Если в базе заглушка или пусто, берём из .env
    if (!addr || addr.includes('UQ...') || addr.includes('your-')) {
        addr = process.env.TON_WALLET;
    }

    if (!addr || addr.includes('your-') || addr.includes('UQ...')) {
        // console.log('[Monitor] No valid admin wallet address configured.');
        return;
    }

    https.get(`https://toncenter.com/api/v2/getTransactions?address=${addr}&limit=20`, (resp) => {
        let data = '';
        resp.on('data', (c) => data += c);
        resp.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (!json.ok) return;

                const txs = json.result;
                txs.forEach(tx => {
                    const msg = tx.in_msg;
                    if (!msg) return;

                    const comment = parseTonComment(msg);
                    const amountTON = parseInt(msg.value) / 1e9;
                    const txHash = tx.transaction_id.hash;

                    // 1. Пытаемся найти по комменту
                    let pending = comment ? depositOps.getByComment(comment) : null;

                    if (pending && pending.status === 'pending') {
                        if (amountTON >= pending.amount * 0.99) {
                            userOps.updateBalance(pending.telegram_id, amountTON, 'deposit', `TON Deposit (Memo: ${comment})`);
                            depositOps.markCompleted(comment, txHash);
                            console.log(`[Deposit] Success (Comment) for ${pending.telegram_id}: ${amountTON} TON`);
                        }
                        return;
                    }

                    // 2. Fallback: по адресу кошелька (from_addr)
                    if (msg.source) {
                        const sender = msg.source; // TON адрес отправителя
                        const user = userOps.getByWallet(sender);

                        if (user) {
                            // Проверяем, не обрабатывали ли мы этот хеш уже (markCompleted помещает его в deposits.tx_hash)
                            const alreadyDone = db.prepare('SELECT id FROM deposits WHERE tx_hash = ?').get(txHash);
                            if (alreadyDone) return;

                            // Ищем заявку
                            const userPendings = depositOps.getPendingByUser(user.telegram_id);
                            if (userPendings.length > 0) {
                                const p = userPendings[0];
                                userOps.updateBalance(p.telegram_id, amountTON, 'deposit', `TON Deposit (Wallet: ${sender})`);
                                depositOps.markCompleted(p.comment, txHash);
                                console.log(`[Deposit] Success (Wallet Match) for ${p.telegram_id}: ${amountTON} TON`);
                            } else {
                                // Если заявки нет, но кошелек привязан - всё равно начисляем!
                                userOps.updateBalance(user.telegram_id, amountTON, 'deposit', `TON Deposit (Direct from wallet: ${sender})`);
                                const vComm = 'W-' + txHash.slice(0, 8);
                                db.prepare("INSERT INTO deposits (telegram_id, amount, status, comment, tx_hash) VALUES (?, ?, 'completed', ?, ?)")
                                    .run(user.telegram_id, amountTON, vComm, txHash);
                                console.log(`[Deposit] Success (Direct Wallet) for ${user.telegram_id}: ${amountTON} TON`);
                            }
                        }
                    }
                });
            } catch (e) { }
        });
    }).on("error", (err) => { });
}

setInterval(checkTonTransactions, 20000); // каждые 20 сек


// --- админка ---

app.post('/api/admin/parse-gift', auth, adminOnly, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    https.get(url, (resp) => {
        let html = '';
        resp.on('data', (c) => html += c);
        resp.on('end', () => {
            try {
                const titleMatch = html.match(/<meta property="og:title" content="([^"]+)">/);
                const imageMatch = html.match(/<meta property="og:image" content="([^"]+)">/);
                res.json({
                    title: titleMatch ? titleMatch[1].replace('Collectibles — ', '') : 'Gift',
                    model: imageMatch ? imageMatch[1] : '',
                    background: 'radial-gradient(circle, #333, #000)',
                    symbol: '🎁'
                });
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    }).on("error", (e) => res.status(500).json({ error: e.message }));
});

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
    res.json({
        overall: gameOps.getStats(), today: gameOps.getTodayStats(),
        userCount: userOps.getCount(), settings: settingsOps.getAll()
    });
});

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
    res.json({ users: userOps.getAll() });
});

app.get('/api/admin/games', auth, adminOnly, (req, res) => {
    res.json({ games: gameOps.getRecent(100) });
});

app.post('/api/admin/user/:id/balance', auth, adminOnly, (req, res) => {
    const r = userOps.setBalance(parseInt(req.params.id), parseFloat(req.body.balance));
    if (!r) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, ...r });
});

app.post('/api/admin/user/:id/ban', auth, adminOnly, (req, res) => {
    userOps.ban(parseInt(req.params.id));
    res.json({ success: true });
});

app.post('/api/admin/user/:id/unban', auth, adminOnly, (req, res) => {
    userOps.unban(parseInt(req.params.id));
    res.json({ success: true });
});

app.post('/api/admin/settings', auth, adminOnly, (req, res) => {
    if (!req.body.key) return res.status(400).json({ error: 'Missing key' });
    settingsOps.set(req.body.key, req.body.value);
    res.json({ success: true });
});

app.post('/api/admin/gifts', auth, adminOnly, (req, res) => {
    giftOps.create(req.body);
    res.json({ success: true });
});

app.delete('/api/admin/gifts/:id', auth, adminOnly, (req, res) => {
    giftOps.delete(parseInt(req.params.id));
    res.json({ success: true });
});



app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    console.log(`CubeRoll server on :${PORT}`);
});

module.exports = app;
