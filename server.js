require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { db, userOps, gameOps, settingsOps, giftOps, depositOps, promoOps, sessionOps, setOnChange } = require('./database');
const syncOps = require('./sync');
const ProvablyFair = require('./provably-fair');

// Connect Sync
setOnChange(() => {
    // Debounced sync or just push
    syncOps.pushToCloud();
});

require('./bot');

const { spawn } = require('child_process');

const app = express();

// Запуск Python менеджера подарков как дочернего процесса
function startGiftManager() {
    console.log('🐍 [System] Запуск Gift Manager (Python)...');

    // Пытаемся запустить через python3 (стандарт для Linux/Railway) 
    // Если упадет с ENOENT, попробуем просто python (стандарт для Windows)
    let command = 'python3';
    let py = spawn(command, ['gift_manager.py']);

    function setupHandlers(process) {
        process.stdout.on('data', (data) => console.log(`[GiftManager] ${data.toString().trim()}`));
        process.stderr.on('data', (data) => console.error(`[GiftManager Error] ${data.toString().trim()}`));

        process.on('error', (err) => {
            if (err.code === 'ENOENT' && command === 'python3') {
                console.warn('⚠ [System] python3 не найден, пробуем "python"...');
                command = 'python';
                py = spawn(command, ['gift_manager.py']);
                setupHandlers(py);
            } else {
                console.error('❌ [System] Не удалось запустить Python процесс:', err.message);
            }
        });

        process.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.log(`[GiftManager] Процесс завершился с кодом ${code}. Перезапуск через 10 сек...`);
                setTimeout(startGiftManager, 10000);
            }
        });
    }

    setupHandlers(py);
}

// Запускаем только если мы не в режиме тестов и есть файл
if (process.env.NODE_ENV !== 'test') {
    startGiftManager();
}
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => Number(id.trim())).filter(id => !isNaN(id));

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

app.use(cors());
app.use(express.json());

// Обычное "шифрование" для "обычных смертных"
const _SEC_KEY = 'cuberoll';
// DEPLOYMENT TRIGGER: 2026-02-14 20:12
console.log('--- SITE INITIALIZING ---');
app.use((req, res, next) => {
    res.secure = (data) => {
        const str = JSON.stringify(data);
        const buf = Buffer.from(str, 'utf8');
        const keyBuf = Buffer.from(_SEC_KEY, 'utf8');
        for (let i = 0; i < buf.length; i++) {
            buf[i] = buf[i] ^ keyBuf[i % keyBuf.length];
        }
        res.send(buf.toString('base64'));
    };
    next();
});

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

    if (!data) {
        console.warn('[Auth] Access denied: No auth data provided.');
        return res.status(401).secure({ error: 'No auth data provided' });
    }

    const user = validateTgData(data);
    if (!user) {
        console.warn('[Auth] Access denied: Invalid auth data.');
        return res.status(401).secure({ error: 'Invalid auth data' });
    }

    // Проверка бана на уровне мидлвары для всех API запросов
    const dbUser = userOps.get(user.id);
    if (dbUser && dbUser.is_banned) {
        console.warn(`[Auth] Access denied: User ${user.id} is banned.`);
        return res.status(403).secure({ error: 'Account is banned' });
    }

    console.log(`[Auth] User ${user.id} authenticated successfully.`);
    req.tgUser = user;
    next();
}

function adminOnly(req, res, next) {
    if (!req.tgUser || !ADMIN_IDS.includes(req.tgUser.id))
        return res.status(403).secure({ error: 'Access denied' });
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
    if (user.is_banned) return res.status(403).secure({ error: 'Account is banned' });

    const s = getSeed(u.id);
    res.secure({
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
    if (!address) return res.status(400).secure({ error: 'Missing address' });
    userOps.updateWallet(req.tgUser.id, address);
    res.secure({ success: true });
});

// ставка
app.post('/api/bet', auth, (req, res) => {
    const u = req.tgUser;
    const user = userOps.get(u.id);
    if (!user) return res.status(404).secure({ error: 'User not found' });
    if (user.is_banned) return res.status(403).secure({ error: 'Account is banned' });
    if (settingsOps.get('maintenance_mode') === '1') return res.status(503).secure({ error: 'Casino is under maintenance' });

    const { betAmount, betType, exactNumber, rangeMin, rangeMax } = req.body;
    if (!betAmount || !betType) return res.status(400).secure({ error: 'Missing bet amount or type' });

    const amt = Math.round(parseFloat(betAmount) * 1e9) / 1e9;
    const minBet = parseFloat(settingsOps.get('min_bet') || '10');
    const maxBet = parseFloat(settingsOps.get('max_bet') || '10000');

    if (isNaN(amt) || amt < minBet || amt > maxBet) return res.status(400).secure({ error: `Bet must be between ${minBet} and ${maxBet}` });

    // Используем микро-погрешность для сравнения, чтобы 0.1 > 0.1 не выдавало ошибку из-за точности
    if (amt > user.balance + 0.000000001) return res.status(400).secure({ error: 'Insufficient balance' });

    // тип ставки — exact и range обрабатываем отдельно
    const validBets = ['high', 'low', 'seven', 'even', 'odd', 'doubles', 'exact', 'range'];
    if (!validBets.includes(betType)) return res.status(400).secure({ error: 'Invalid bet type' });

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
        if (isNaN(rMin) || isNaN(rMax) || rMin < 2 || rMax > 12 || rMin >= rMax) return res.status(400).secure({ error: 'Invalid range' });
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
    res.secure({
        result: {
            dice: dice.dice, total: dice.total, won: result.won,
            multiplier: result.multiplier, payout: result.payout, profit: result.profit,
            newBalance: updated.balance, betAmount: amt
        },
        fairness: { serverSeedHash: s.hash, clientSeed: s.clientSeed, nonce: s.nonce }
    });
});

// --- CRASH (ROCKET) GAME (GLOBAL SYNC) ---

const crashState = {
    phase: 'WAITING', // WAITING, FLYING, CRASHED
    multiplier: 1.0,
    startTime: Date.now() + 10000, // Start in 10s
    crashPoint: 0,
    history: [],
    bets: [], // { telegramId: number, amount: number, cashedOut: boolean, payout: number }
    gameId: Math.random().toString(36).substring(2, 9)
};

function generateCrashPoint() {
    // Вероятностная формула: 97% RTP (3% house edge)
    const e = 2 ** 32;
    const h = crypto.randomBytes(4).readUInt32BE(0);
    if (h % 33 === 0) return 1.00; // Мгновенный краш (3.03% шанс)
    return Math.floor((100 * e - h) / (e - h)) / 100;
}

function tickCrash() {
    const now = Date.now();

    if (crashState.phase === 'WAITING') {
        if (now >= crashState.startTime) {
            crashState.phase = 'FLYING';
            crashState.crashPoint = generateCrashPoint();
            crashState.multiplier = 1.0;
            console.log(`[Crash] Game ${crashState.gameId} started. Crash Point: ${crashState.crashPoint}`);
        }
    } else if (crashState.phase === 'FLYING') {
        const elapsed = (now - crashState.startTime) / 1000; // s
        // Экспоненциальный рост: 1.07 ^ t
        crashState.multiplier = Math.round(Math.pow(1.07, elapsed) * 100) / 100;

        if (crashState.multiplier >= crashState.crashPoint) {
            crashState.phase = 'CRASHED';
            crashState.multiplier = crashState.crashPoint; // Fix at crash point
            crashState.history.unshift(crashState.crashPoint);
            if (crashState.history.length > 10) crashState.history.pop();

            console.log(`[Crash] Game ${crashState.gameId} CRASHED at ${crashState.crashPoint}x`);

            // Завершаем ставки тех, кто не забрал
            crashState.bets.forEach(b => {
                if (!b.cashedOut) {
                    gameOps.create({
                        telegramId: b.telegramId, betAmount: b.amount, gameType: 'crash',
                        playerChoice: 'crash', diceResult: String(crashState.crashPoint),
                        multiplier: 0, payout: 0, profit: -b.amount, won: 0
                    });
                    userOps.updateStats(b.telegramId, b.amount, false, -b.amount);
                }
            });

            setTimeout(() => {
                crashState.phase = 'WAITING';
                crashState.startTime = Date.now() + 10000;
                crashState.bets = [];
                crashState.gameId = Math.random().toString(36).substring(2, 9);
            }, 5000);
        }
    }
}

setInterval(tickCrash, 100);

app.get('/api/crash/status', auth, (req, res) => {
    const myBet = crashState.bets.find(b => b.telegramId === req.tgUser.id);
    res.secure({
        phase: crashState.phase,
        multiplier: crashState.multiplier,
        timeLeft: Math.max(0, crashState.startTime - Date.now()),
        history: crashState.history,
        gameId: crashState.gameId,
        myBet: myBet ? { amount: myBet.amount, cashedOut: myBet.cashedOut } : null,
        serverTime: Date.now(),
        startTime: crashState.startTime
    });
});

app.post('/api/crash/bet', auth, (req, res) => {
    if (crashState.phase !== 'WAITING') return res.status(400).secure({ error: 'Game already started' });

    const u = req.tgUser;
    const user = userOps.get(u.id);
    if (!user || user.is_banned) return res.status(403).secure({ error: 'Denied' });

    const existing = crashState.bets.find(b => b.telegramId === u.id);
    if (existing) return res.status(400).secure({ error: 'Bet already placed' });

    const { betAmount } = req.body;
    const amt = Math.round(parseFloat(betAmount) * 1e9) / 1e9;
    const minBet = parseFloat(settingsOps.get('min_bet') || '0.1');
    const maxBet = parseFloat(settingsOps.get('max_bet') || '100');

    if (isNaN(amt) || amt < minBet || amt > maxBet) return res.status(400).secure({ error: `Min: ${minBet}, Max: ${maxBet}` });
    if (amt > user.balance + 0.000000001) return res.status(400).secure({ error: 'Insufficient balance' });

    userOps.updateBalance(u.id, -amt, 'crash_bet', 'Crash game bet');
    crashState.bets.push({ telegramId: u.id, amount: amt, cashedOut: false });

    res.secure({ success: true, newBalance: user.balance - amt });
});

app.post('/api/crash/cashout', auth, (req, res) => {
    if (crashState.phase !== 'FLYING') return res.status(400).secure({ error: 'Not in flight' });

    const u = req.tgUser;
    const bet = crashState.bets.find(b => b.telegramId === u.id);
    if (!bet) return res.status(400).secure({ error: 'No bet placed' });
    if (bet.cashedOut) return res.status(400).secure({ error: 'Already cashed out' });

    const currentMultiplier = crashState.multiplier;
    const payout = Math.round((bet.amount * currentMultiplier) * 1e9) / 1e9;
    const profit = payout - bet.amount;

    bet.cashedOut = true;
    bet.payout = payout;

    userOps.updateBalance(u.id, payout, 'crash_win', `Crash cashout ${currentMultiplier}x`);
    userOps.updateStats(u.id, bet.amount, true, profit);

    gameOps.create({
        telegramId: u.id, betAmount: bet.amount, gameType: 'crash',
        playerChoice: 'cashout', diceResult: String(currentMultiplier),
        multiplier: currentMultiplier, payout: payout, profit: profit,
        won: 1
    });

    const updated = userOps.get(u.id);
    res.secure({ success: true, payout, multiplier: currentMultiplier, newBalance: updated.balance });
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

    res.secure({ oldServerSeed: oldSeed, oldServerSeedHash: oldHash, newServerSeedHash: s.hash, clientSeed: s.clientSeed, nonce: s.nonce });
});

// обновление клиент сида
app.post('/api/seeds/client', auth, (req, res) => {
    const { clientSeed } = req.body;
    if (!clientSeed || clientSeed.length < 1) return res.status(400).secure({ error: 'Invalid client seed' });
    const s = getSeed(req.tgUser.id);
    s.clientSeed = clientSeed;
    res.secure({ clientSeed: s.clientSeed });
});

app.get('/api/history', auth, (req, res) => {
    res.secure({ games: gameOps.getByUser(req.tgUser.id, 50) });
});

// верификация (публичный эндпоинт)
app.post('/api/verify', (req, res) => {
    const { serverSeed, clientSeed, nonce } = req.body;
    if (!serverSeed || !clientSeed || nonce === undefined) return res.status(400).secure({ error: 'Missing parameters' });
    const r = ProvablyFair.verify(serverSeed, clientSeed, parseInt(nonce));
    res.secure({ dice: r.dice, total: r.total, serverSeedHash: ProvablyFair.hashServerSeed(serverSeed) });
});

app.get('/api/leaderboard', auth, (req, res) => {
    const top = userOps.getTopPlayers(20);
    res.secure({
        players: top.map(p => ({
            username: p.username || p.first_name || `User ${p.telegram_id}`,
            balance: p.balance, gamesPlayed: p.games_played, gamesWon: p.games_won
        }))
    });
});

// подарки
app.get('/api/gifts', auth, (req, res) => {
    res.secure({ gifts: giftOps.getAll() });
});

app.get('/api/gifts/:id', auth, (req, res) => {
    const g = giftOps.get(parseInt(req.params.id));
    if (!g) return res.status(404).secure({ error: 'Not found' });
    res.secure(g);
});

app.post('/api/gifts/buy', auth, (req, res) => {
    const { giftId } = req.body;
    const user = userOps.get(req.tgUser.id);
    const gift = giftOps.get(giftId);
    if (!gift) return res.status(404).secure({ error: 'Gift not found' });
    if (user.balance < gift.price) return res.status(400).secure({ error: 'Insufficient balance' });

    userOps.updateBalance(req.tgUser.id, -gift.price, 'gift_buy', `Bought ${gift.title}`);

    // Очередь на передачу юзерботом
    giftOps.createTransfer(giftId, req.tgUser.id);

    giftOps.delete(giftId); // Это помечает is_active = 0
    const updated = userOps.get(req.tgUser.id);
    res.secure({ success: true, newBalance: updated.balance });
});

app.post('/api/deposit/request', auth, (req, res) => {
    const { amount } = req.body;
    const amt = parseFloat(amount);
    const minDep = parseFloat(settingsOps.get('min_deposit') || 0.1);
    if (isNaN(amt) || amt < minDep) return res.status(400).secure({ error: `Минимум: ${minDep} TON` });

    const comment = 'CR-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    try {
        depositOps.createPending(req.tgUser.id, amt, comment);
    } catch (e) {
        return res.status(500).secure({ error: 'Could not create request' });
    }

    let wallet = process.env.TON_WALLET || settingsOps.get('ton_wallet');
    // Если в .env или базе заглушка, возвращаем ошибку
    if (!wallet || wallet.includes('...') || wallet === 'UQ...') {
        return res.status(500).secure({ error: 'Admin wallet address is not configured yet.' });
    }
    res.secure({ comment, address: wallet });
});

app.get('/api/deposit/check', auth, (req, res) => {
    const pending = depositOps.getPendingByUser(req.tgUser.id);
    const completed = db.prepare("SELECT * FROM deposits WHERE telegram_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 5").all(req.tgUser.id);
    res.secure({ pending, completed });
});

// УДАЛЕНО: app.post('/api/deposit/optimistic' ...)
// Теперь зачисление только по факту транзакции в блокчейне.

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

    // Пул адреса из настроек или ENV
    if (!addr || addr.length < 10 || addr.includes('...') || addr.includes('your-')) {
        addr = process.env.TON_WALLET;
    }

    // Если всё еще нет адреса или это плейсхолдер - выходим
    if (!addr || addr.length < 10 || addr.includes('...') || addr.includes('your-')) {
        return;
    }

    // console.log(`[Monitor] Scanning ${addr}...`);

    https.get(`https://toncenter.com/api/v2/getTransactions?address=${addr}&limit=15`, (resp) => {
        let data = '';
        resp.on('data', (c) => data += c);
        resp.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (!json.ok) {
                    console.error('[Monitor] TonCenter API error:', json);
                    return;
                }
                const txs = json.result;
                txs.forEach(tx => {
                    const msg = tx.in_msg;
                    if (!msg) return;

                    const comment = parseTonComment(msg);
                    const amountTON = parseInt(msg.value) / 1e9;
                    const txHash = tx.transaction_id.hash;

                    if (!comment) return;

                    // Match by comment
                    let pending = depositOps.getByComment(comment);
                    if (pending && pending.status === 'pending') {
                        // Allow slight variation in amount (e.g. fees or user error)
                        if (amountTON >= pending.amount * 0.98) {
                            console.log(`[Monitor] SUCCESS: Found tx for ${comment}, amount: ${amountTON} TON`);
                            userOps.updateBalance(pending.telegram_id, amountTON, 'deposit', `TON Deposit (Memo: ${comment})`);
                            depositOps.markCompleted(comment, txHash);
                        } else {
                            console.warn(`[Monitor] Amount mismatch for ${comment}: expected ${pending.amount}, got ${amountTON}`);
                        }
                    }
                });
            } catch (e) {
                console.error('[Monitor] Parse error:', e.message);
            }
        });
    }).on('error', (err) => {
        console.error('[Monitor] Network error:', err.message);
    });
}

// Поллинг каждые 10 секунд для скорости подтверждения
setInterval(checkTonTransactions, 10000);

// --- GIFT BUYBACK (NFT) DYNAMIC PARSER ---

async function fetchNftFloorPrice(query) {
    return new Promise((resolve) => {
        // Portal-Market API is used to get the current floor price (suggested by user)
        const url = `https://portal-market.com/api/collections?search=${encodeURIComponent(query)}&limit=1`;
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };
        https.get(url, options, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const collections = data.collections || [];
                    if (collections.length > 0) {
                        const col = collections[0];
                        let price = parseFloat(col.floor_price || 0);
                        // Heuristic: if price > 1,000,000, it's likely NanoTON
                        if (price > 1000000) price /= 1e9;
                        resolve({ price, name: col.name });
                    } else {
                        resolve(null);
                    }
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

async function checkNftGifts() {
    const settings = settingsOps.getAll();
    let dealerAddr = settings.ton_wallet;
    if (!dealerAddr || dealerAddr.includes('UQ...') || dealerAddr.includes('your-')) {
        dealerAddr = process.env.TON_WALLET;
    }
    if (!dealerAddr || dealerAddr.includes('your-') || dealerAddr.includes('UQ...')) return;

    https.get(`https://toncenter.com/api/v2/getTransactions?address=${dealerAddr}&limit=10`, (resp) => {
        let data = '';
        resp.on('data', (c) => data += c);
        resp.on('end', async () => {
            try {
                const json = JSON.parse(data);
                if (!json.ok) return;

                const txs = json.result;
                for (const tx of txs) {
                    const msg = tx.in_msg;
                    if (!msg || !msg.source) continue;

                    const txHash = tx.transaction_id.hash;
                    // Проверяем, не обрабатывали ли мы этот перевод NFT
                    const alreadyDone = db.prepare('SELECT id FROM transactions WHERE description LIKE ?').get(`%NFT:${txHash}%`);
                    if (alreadyDone) continue;

                    const nftItemAddress = msg.source;

                    // 1. Получаем данные NFT
                    https.get(`https://toncenter.com/api/v2/runGetMethod?address=${nftItemAddress}&method=get_nft_data&stack=[]`, (nr) => {
                        let nd = '';
                        nr.on('data', (c) => nd += c);
                        nr.on('end', async () => {
                            try {
                                const nj = JSON.parse(nd);
                                if (!nj.ok || nj.result.exit_code !== 0) return;

                                // Попробуем найти КТО отправил этот NFT
                                https.get(`https://toncenter.com/api/v2/getTransactions?address=${nftItemAddress}&limit=5`, (tr) => {
                                    let td = '';
                                    tr.on('data', (c) => td += c);
                                    tr.on('end', async () => {
                                        try {
                                            const tj = JSON.parse(td);
                                            const transferTx = tj.result.find(t => t.out_msgs && t.out_msgs.some(m => m.destination === dealerAddr));
                                            if (!transferTx) return;

                                            const senderWallet = transferTx.in_msg.source;
                                            const user = userOps.getByWallet(senderWallet);
                                            if (!user) return;

                                            // 2. Определяем ЦЕНУ динамически
                                            let dynamicPrice = null;
                                            let nftName = "Unknown NFT";

                                            // Сначала по адресу самого предмета (некоторые API понимают его как ID коллекции)
                                            const marketData = await fetchNftFloorPrice(nftItemAddress);
                                            if (marketData) {
                                                dynamicPrice = marketData.price;
                                                nftName = marketData.name;
                                            }

                                            // Если не вышло по адресу, ищем по шаблонам в базе
                                            if (!dynamicPrice) {
                                                const allGifts = giftOps.getAll();
                                                const giftTemplate = allGifts.find(g => g.nft_address && (nftItemAddress.includes(g.nft_address)));
                                                if (giftTemplate) {
                                                    const namedPrice = await fetchNftFloorPrice(giftTemplate.title);
                                                    dynamicPrice = namedPrice ? namedPrice.price : giftTemplate.price;
                                                    nftName = giftTemplate.title;
                                                }
                                            }

                                            if (dynamicPrice && dynamicPrice > 0) {
                                                console.log(`[NFT-Buyback] User ${user.telegram_id} sent "${nftName}". Price: ${dynamicPrice} TON`);
                                                userOps.updateBalance(user.telegram_id, dynamicPrice, 'gift_sell', `Sold Gift ${nftName} NFT:${txHash}`);
                                            }
                                        } catch (e) { }
                                    });
                                });
                            } catch (e) { }
                        });
                    });
                }
            } catch (e) { }
        });
    }).on("error", () => { });
}

setInterval(checkNftGifts, 20000);

// Зачисление теперь только через честный мониторинг транзакций.
// Оптимистичное зачисление и его откаты удалены для безопасности.



// --- ПРОМОКОДЫ ---

app.post('/api/promocodes/redeem', auth, (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).secure({ error: 'Введите промокод' });
    try {
        promoOps.redeem(req.tgUser.id, code);
        const updated = userOps.get(req.tgUser.id);
        res.secure({ success: true, message: 'Промокод активирован!', newBalance: updated.balance });
    } catch (e) {
        res.status(400).secure({ error: e.message });
    }
});


// --- админка ---

app.post('/api/admin/parse-gift', auth, adminOnly, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).secure({ error: 'URL required' });

    https.get(url, (resp) => {
        let html = '';
        resp.on('data', (c) => html += c);
        resp.on('end', () => {
            try {
                const titleMatch = html.match(/<meta property="og:title" content="([^"]+)">/);
                const imageMatch = html.match(/<meta property="og:image" content="([^"]+)">/);
                res.secure({
                    title: titleMatch ? titleMatch[1].replace('Collectibles — ', '') : 'Gift',
                    model: imageMatch ? imageMatch[1] : '',
                    background: 'radial-gradient(circle, #333, #000)',
                    symbol: '🎁'
                });
            } catch (e) { res.status(500).secure({ error: e.message }); }
        });
    }).on("error", (e) => res.status(500).secure({ error: e.message }));
});

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
    res.secure({
        overall: gameOps.getStats(), today: gameOps.getTodayStats(),
        userCount: userOps.getCount(), settings: settingsOps.getAll()
    });
});

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
    res.secure({ users: userOps.getAll() });
});

app.get('/api/admin/games', auth, adminOnly, (req, res) => {
    res.secure({ games: gameOps.getRecent(100) });
});

app.post('/api/admin/user/:id/balance', auth, adminOnly, (req, res) => {
    const r = userOps.setBalance(parseInt(req.params.id), parseFloat(req.body.balance));
    if (!r) return res.status(404).secure({ error: 'User not found' });
    res.secure({ success: true, ...r });
});

app.post('/api/admin/user/:id/ban', auth, adminOnly, (req, res) => {
    userOps.ban(parseInt(req.params.id));
    res.secure({ success: true });
});

app.post('/api/admin/user/:id/unban', auth, adminOnly, (req, res) => {
    userOps.unban(parseInt(req.params.id));
    res.secure({ success: true });
});

app.post('/api/admin/settings', auth, adminOnly, (req, res) => {
    if (!req.body.key) return res.status(400).secure({ error: 'Missing key' });
    settingsOps.set(req.body.key, req.body.value);
    res.secure({ success: true });
});

app.post('/api/admin/gifts', auth, adminOnly, (req, res) => {
    giftOps.create(req.body);
    res.secure({ success: true });
});

app.delete('/api/admin/gifts/:id', auth, adminOnly, (req, res) => {
    giftOps.delete(parseInt(req.params.id));
    res.secure({ success: true });
});

app.get('/api/admin/promocodes', auth, adminOnly, (req, res) => {
    res.secure({ promocodes: promoOps.getAll() });
});

app.post('/api/admin/promocodes', auth, adminOnly, (req, res) => {
    const { code, amount, maxActivations } = req.body;
    if (!code || !amount || !maxActivations) return res.status(400).secure({ error: 'Missing data' });
    promoOps.create(code, parseFloat(amount), parseInt(maxActivations));
    res.secure({ success: true });
});

app.delete('/api/admin/promocodes/:id', auth, adminOnly, (req, res) => {
    promoOps.delete(parseInt(req.params.id));
    res.secure({ success: true });
});



app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🚀 [Server] CubeRoll is running on port ${PORT}`);

    // Cloud Restore
    try {
        await syncOps.pullFromCloud();
    } catch (e) {
        console.error('[Sync] Restore failed:', e.message);
    }

    // Background Backup (5 min)
    setInterval(syncOps.pushToCloud, 300000);

    startGiftManager();
});

module.exports = app;
