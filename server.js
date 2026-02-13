require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { userOps, gameOps, settingsOps } = require('./database');
const ProvablyFair = require('./provably-fair');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

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
            totalWagered: user.total_wagered, totalWon: user.total_won, totalLost: user.total_lost
        },
        seeds: { serverSeedHash: s.hash, clientSeed: s.clientSeed, nonce: s.nonce },
        settings: {
            minBet: parseFloat(settingsOps.get('min_bet') || '10'),
            maxBet: parseFloat(settingsOps.get('max_bet') || '10000')
        },
        isAdmin: ADMIN_IDS.includes(u.id)
    });
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


// --- админка ---

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

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
    console.log(`CubeRoll server on :${PORT}`);
});

module.exports = app;
