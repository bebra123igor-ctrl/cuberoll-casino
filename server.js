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

// ===== Telegram WebApp Auth Validation =====
function validateTelegramWebAppData(initData) {
    if (!BOT_TOKEN) return null;

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const sortedParams = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(sortedParams).digest('hex');

        if (computedHash !== hash) return null;

        const userData = JSON.parse(params.get('user') || '{}');
        return userData;
    } catch (err) {
        console.error('Auth validation error:', err);
        return null;
    }
}

// Auth middleware
function authMiddleware(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];

    // For development: allow mock auth
    if (!BOT_TOKEN && req.headers['x-dev-user-id']) {
        req.telegramUser = {
            id: parseInt(req.headers['x-dev-user-id']),
            username: 'dev_user',
            first_name: 'Developer'
        };
        return next();
    }

    if (!initData) {
        return res.status(401).json({ error: 'No auth data provided' });
    }

    const user = validateTelegramWebAppData(initData);
    if (!user) {
        return res.status(401).json({ error: 'Invalid auth data' });
    }

    req.telegramUser = user;
    next();
}

// Admin middleware
function adminMiddleware(req, res, next) {
    if (!req.telegramUser || !ADMIN_IDS.includes(req.telegramUser.id)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
}

// In-memory session seeds
const userSeeds = {};

function getUserSeed(telegramId) {
    if (!userSeeds[telegramId]) {
        userSeeds[telegramId] = {
            serverSeed: ProvablyFair.generateServerSeed(),
            clientSeed: ProvablyFair.generateClientSeed(),
            nonce: 0,
            serverSeedHash: ''
        };
        userSeeds[telegramId].serverSeedHash = ProvablyFair.hashServerSeed(userSeeds[telegramId].serverSeed);
    }
    return userSeeds[telegramId];
}

// ===== API Routes =====

// Get user profile
app.post('/api/auth', authMiddleware, (req, res) => {
    const tgUser = req.telegramUser;
    const user = userOps.getOrCreate(tgUser.id, tgUser.username || '', tgUser.first_name || '', tgUser.last_name || '');

    if (user.is_banned) {
        return res.status(403).json({ error: 'Account is banned' });
    }

    const seeds = getUserSeed(tgUser.id);

    res.json({
        user: {
            telegramId: user.telegram_id,
            username: user.username,
            firstName: user.first_name,
            balance: user.balance,
            gamesPlayed: user.games_played,
            gamesWon: user.games_won,
            totalWagered: user.total_wagered,
            totalWon: user.total_won,
            totalLost: user.total_lost
        },
        seeds: {
            serverSeedHash: seeds.serverSeedHash,
            clientSeed: seeds.clientSeed,
            nonce: seeds.nonce
        },
        settings: {
            minBet: parseFloat(settingsOps.get('min_bet') || '10'),
            maxBet: parseFloat(settingsOps.get('max_bet') || '10000')
        },
        isAdmin: ADMIN_IDS.includes(tgUser.id)
    });
});

// Place a bet
app.post('/api/bet', authMiddleware, (req, res) => {
    const tgUser = req.telegramUser;
    const user = userOps.get(tgUser.id);

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned) return res.status(403).json({ error: 'Account is banned' });

    const maintenance = settingsOps.get('maintenance_mode');
    if (maintenance === '1') {
        return res.status(503).json({ error: 'Casino is under maintenance' });
    }

    const { betAmount, betType } = req.body;

    if (!betAmount || !betType) {
        return res.status(400).json({ error: 'Missing bet amount or type' });
    }

    const amount = parseFloat(betAmount);
    const minBet = parseFloat(settingsOps.get('min_bet') || '10');
    const maxBet = parseFloat(settingsOps.get('max_bet') || '10000');

    if (isNaN(amount) || amount < minBet || amount > maxBet) {
        return res.status(400).json({ error: `Bet must be between ${minBet} and ${maxBet}` });
    }

    if (amount > user.balance) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }

    const validBets = ['high', 'low', 'seven', 'even', 'odd', 'doubles'];
    for (let i = 2; i <= 12; i++) validBets.push(`exact_${i}`);

    if (!validBets.includes(betType)) {
        return res.status(400).json({ error: 'Invalid bet type' });
    }

    // Get user seeds and roll
    const seeds = getUserSeed(tgUser.id);
    seeds.nonce++;

    const diceResult = ProvablyFair.generateDice(seeds.serverSeed, seeds.clientSeed, seeds.nonce);
    const payoutResult = ProvablyFair.calculatePayout(betType, diceResult, amount);

    // Update balance
    const balanceChange = payoutResult.won ? (payoutResult.payout - amount) : -amount;
    userOps.updateBalance(tgUser.id, balanceChange, payoutResult.won ? 'win' : 'loss',
        `Dice game: ${betType} | Result: ${diceResult.dice.join(',')} (${diceResult.total})`
    );
    userOps.updateStats(tgUser.id, amount, payoutResult.won, payoutResult.profit);

    // Save game record
    gameOps.create({
        telegramId: tgUser.id,
        betAmount: amount,
        gameType: 'dice',
        playerChoice: betType,
        diceResult: diceResult.dice.join(','),
        diceTotal: diceResult.total,
        multiplier: payoutResult.multiplier,
        payout: payoutResult.payout,
        profit: payoutResult.profit,
        serverSeed: seeds.serverSeed,
        clientSeed: seeds.clientSeed,
        nonce: seeds.nonce,
        hash: diceResult.hash,
        won: payoutResult.won
    });

    const updatedUser = userOps.get(tgUser.id);

    res.json({
        result: {
            dice: diceResult.dice,
            total: diceResult.total,
            won: payoutResult.won,
            multiplier: payoutResult.multiplier,
            payout: payoutResult.payout,
            profit: payoutResult.profit,
            newBalance: updatedUser.balance
        },
        fairness: {
            serverSeedHash: seeds.serverSeedHash,
            clientSeed: seeds.clientSeed,
            nonce: seeds.nonce
        }
    });
});

// Rotate server seed (reveals old one, generates new)
app.post('/api/seeds/rotate', authMiddleware, (req, res) => {
    const tgUser = req.telegramUser;
    const seeds = getUserSeed(tgUser.id);

    const oldServerSeed = seeds.serverSeed;
    const oldHash = seeds.serverSeedHash;

    // Generate new seeds
    seeds.serverSeed = ProvablyFair.generateServerSeed();
    seeds.serverSeedHash = ProvablyFair.hashServerSeed(seeds.serverSeed);
    seeds.nonce = 0;

    if (req.body.clientSeed) {
        seeds.clientSeed = req.body.clientSeed;
    }

    res.json({
        oldServerSeed,
        oldServerSeedHash: oldHash,
        newServerSeedHash: seeds.serverSeedHash,
        clientSeed: seeds.clientSeed,
        nonce: seeds.nonce
    });
});

// Update client seed
app.post('/api/seeds/client', authMiddleware, (req, res) => {
    const tgUser = req.telegramUser;
    const { clientSeed } = req.body;

    if (!clientSeed || clientSeed.length < 1) {
        return res.status(400).json({ error: 'Invalid client seed' });
    }

    const seeds = getUserSeed(tgUser.id);
    seeds.clientSeed = clientSeed;

    res.json({ clientSeed: seeds.clientSeed });
});

// Get game history
app.get('/api/history', authMiddleware, (req, res) => {
    const tgUser = req.telegramUser;
    const games = gameOps.getByUser(tgUser.id, 50);
    res.json({ games });
});

// Verify a game
app.post('/api/verify', (req, res) => {
    const { serverSeed, clientSeed, nonce } = req.body;

    if (!serverSeed || !clientSeed || nonce === undefined) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const result = ProvablyFair.verify(serverSeed, clientSeed, parseInt(nonce));
    const hash = ProvablyFair.hashServerSeed(serverSeed);

    res.json({
        dice: result.dice,
        total: result.total,
        serverSeedHash: hash
    });
});

// Leaderboard
app.get('/api/leaderboard', authMiddleware, (req, res) => {
    const top = userOps.getTopPlayers(20);
    res.json({
        players: top.map(p => ({
            username: p.username || p.first_name || `User ${p.telegram_id}`,
            balance: p.balance,
            gamesPlayed: p.games_played,
            gamesWon: p.games_won
        }))
    });
});

// ===== Admin API =====

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    const allStats = gameOps.getStats();
    const todayStats = gameOps.getTodayStats();
    const userCount = userOps.getCount();
    const settings = settingsOps.getAll();

    res.json({
        overall: allStats,
        today: todayStats,
        userCount,
        settings
    });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = userOps.getAll();
    res.json({ users });
});

app.get('/api/admin/games', authMiddleware, adminMiddleware, (req, res) => {
    const games = gameOps.getRecent(100);
    res.json({ games });
});

app.post('/api/admin/user/:id/balance', authMiddleware, adminMiddleware, (req, res) => {
    const telegramId = parseInt(req.params.id);
    const { balance } = req.body;

    const result = userOps.setBalance(telegramId, parseFloat(balance));
    if (!result) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, ...result });
});

app.post('/api/admin/user/:id/ban', authMiddleware, adminMiddleware, (req, res) => {
    const telegramId = parseInt(req.params.id);
    userOps.ban(telegramId);
    res.json({ success: true });
});

app.post('/api/admin/user/:id/unban', authMiddleware, adminMiddleware, (req, res) => {
    const telegramId = parseInt(req.params.id);
    userOps.unban(telegramId);
    res.json({ success: true });
});

app.post('/api/admin/settings', authMiddleware, adminMiddleware, (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    settingsOps.set(key, value);
    res.json({ success: true });
});

// Serve admin page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve main page
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🎲 CubeRoll Casino server running on port ${PORT}`);
    console.log(`📱 WebApp: http://localhost:${PORT}`);
    console.log(`👑 Admin: http://localhost:${PORT}/admin`);
});

module.exports = app;
