require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { db, userOps, gameOps, settingsOps, giftOps, depositOps, promoOps, sessionOps, inventoryOps, marketplaceOps, setOnChange } = require('./database');
const syncOps = require('./sync');
const ProvablyFair = require('./provably-fair');

// Connect Sync
setOnChange(() => {
    // Debounced sync or just push
    syncOps.pushToCloud();
});

const bot = require('./bot');

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
const { logMonitor, monitoringLogs } = require('./logger');

// --- роуты ---

// авторизация + получение профиля
app.post('/api/auth', auth, (req, res) => {
    const u = req.tgUser;
    const { start_param } = req.body; // Telegram referral parameter

    // Resolve referrer: support both "ref_CODE" and raw user ID
    let referrerId = null;
    if (start_param) {
        if (start_param.startsWith('ref_')) {
            const code = start_param.slice(4);
            const referrer = userOps.getByReferralCode(code);
            if (referrer && referrer.telegram_id !== u.id) {
                referrerId = referrer.telegram_id;
            }
        } else {
            const parsed = parseInt(start_param);
            if (!isNaN(parsed) && parsed !== u.id) referrerId = parsed;
        }
    }

    const user = userOps.getOrCreate(u.id, u.username || '', u.first_name || '', u.last_name || '', referrerId);
    if (user.is_banned) return res.status(403).secure({ error: 'Account is banned' });

    const s = getSeed(u.id);

    // Referral promo active until 2026-02-22
    const promoDeadline = new Date('2026-02-22T23:59:59+03:00');
    const promoActive = new Date() <= promoDeadline;

    res.secure({
        user: {
            telegramId: user.telegram_id, username: user.username, firstName: user.first_name,
            balance: user.balance, gamesPlayed: user.games_played, gamesWon: user.games_won,
            totalWagered: user.total_wagered, totalWon: user.total_won, totalLost: user.total_lost,
            lastDailyClaim: user.last_daily_claim, lastDailySpin: user.last_daily_spin,
            walletAddress: user.wallet_address, biggestWinMult: user.biggest_win_mult,
            referralEarned: user.referral_earned, autoCashout: user.auto_cashout,
            referralCode: user.referral_code,
            referralCount: user.referral_count || 0,
            referralBonusClaimed: !!user.referral_bonus_claimed
        },
        seeds: s,
        settings: {
            minBet: parseFloat(settingsOps.get('min_bet') || '0.1'),
            maxBet: parseFloat(settingsOps.get('max_bet') || '100'),
            tonWallet: settingsOps.get('ton_wallet'),
            minDeposit: parseFloat(settingsOps.get('min_deposit') || '0.001')
        },
        referralPromo: {
            active: promoActive,
            deadline: '22.02.2026',
            bonus: 3,
            requiredReferrals: 10
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
app.post('/api/bet', auth, async (req, res) => {
    const u = req.tgUser;
    const user = userOps.get(u.id);
    if (!user) return res.status(404).secure({ error: 'User not found' });
    if (user.is_banned) return res.status(403).secure({ error: 'Account is banned' });
    if (settingsOps.get('maintenance_mode') === '1') return res.status(503).secure({ error: 'Casino is under maintenance' });

    const { betAmount, betType, exactNumber, rangeMin, rangeMax, giftInstanceId } = req.body;
    if ((!betAmount && !giftInstanceId) || !betType) return res.status(400).secure({ error: 'Missing bet amount or type' });

    let amt = 0;
    if (giftInstanceId) {
        // Betting with a gift
        const inventory = inventoryOps.getByUser(u.id);
        const item = inventory.find(i => i.instance_id === giftInstanceId);
        if (!item) return res.status(404).secure({ error: 'Gift not found in inventory' });

        // Initial price from DB as floor price fallback
        amt = item.price;

        // Try to get fresh floor price if possible
        const livePrice = await fetchNftFloorPrice(item.title);
        if (livePrice && livePrice.price > 0) {
            amt = livePrice.price;
        }

        if (amt < 0.01) return res.status(400).secure({ error: 'Gift has no market value' });

        // Remove from inventory as it's a stake
        inventoryOps.remove(giftInstanceId);
        console.log(`[Game] User ${u.id} betting with gift ${item.title} (Value: ${amt} TON)`);
    } else {
        amt = Math.round(parseFloat(betAmount) * 1e9) / 1e9;
        const minBet = parseFloat(settingsOps.get('min_bet') || '0.1');
        if (isNaN(amt) || amt < minBet) return res.status(400).secure({ error: `Минимум: ${minBet} TON` });
        if (amt > user.balance + 0.000000001) return res.status(400).secure({ error: 'Insufficient balance' });
    }

    // тип ставки — exact и range обрабатываем отдельно
    const validBets = ['high', 'low', 'seven', 'even', 'odd', 'doubles', 'exact', 'range'];
    if (!validBets.includes(betType)) return res.status(400).secure({ error: 'Invalid bet type' });

    // конвертируем exact в exact_N
    let resolvedType = betType;
    let rangeBounds = null;
    if (betType === 'exact') {
        const n = parseInt(exactNumber);
        if (isNaN(n) || n < 2 || n > 12) return res.status(400).secure({ error: 'Exact number must be 2-12' });
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
    result.payout = Math.max(0, result.payout); // Safe fallback

    const change = result.won ? (result.payout - amt) : -amt;
    userOps.updateBalance(u.id, change, result.won ? 'win' : 'loss',
        `Dice: ${resolvedType} | ${dice.dice.join(',')} (${dice.total})`
    );
    userOps.updateStats(u.id, amt, result.won, result.profit, result.multiplier);

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

// --- PLINKO GAME ---
const PLINKO_ROWS = 10;
const PLINKO_MULTIS = [15, 6, 2.5, 1.3, 0.6, 0, 0.6, 1.3, 2.5, 6, 15];

app.post('/api/plinko/bet', auth, async (req, res) => {
    const u = req.tgUser;
    const user = userOps.get(u.id);
    if (!user) return res.status(404).secure({ error: 'User not found' });
    if (user.is_banned) return res.status(403).secure({ error: 'Account is banned' });
    if (settingsOps.get('maintenance_mode') === '1') return res.status(503).secure({ error: 'Casino is under maintenance' });

    const { betAmount, giftInstanceId } = req.body;
    let amt = 0;

    if (giftInstanceId) {
        const inventory = inventoryOps.getByUser(u.id);
        const item = inventory.find(i => i.instance_id === giftInstanceId);
        if (!item) return res.status(404).secure({ error: 'Gift not found in inventory' });

        amt = item.price;
        const livePrice = await fetchNftFloorPrice(item.title);
        if (livePrice && livePrice.price > 0) amt = livePrice.price;
        if (amt < 0.01) return res.status(400).secure({ error: 'Gift has no market value' });

        inventoryOps.remove(giftInstanceId);
    } else {
        amt = Math.round(parseFloat(betAmount) * 1e9) / 1e9;
        const minBet = parseFloat(settingsOps.get('min_bet') || '0.1');
        const maxBet = parseFloat(settingsOps.get('max_bet') || '10000');
        if (isNaN(amt) || amt < minBet || amt > maxBet) return res.status(400).secure({ error: `Bet must be between ${minBet} and ${maxBet}` });
        if (amt > user.balance + 1e-9) return res.status(400).secure({ error: 'Insufficient balance' });
    }

    const s = getSeed(u.id);
    s.nonce++;

    const hash = crypto.createHash('sha256').update(`${s.serverSeed}:${s.clientSeed}:${s.nonce}`).digest('hex');
    let rightMoves = 0;
    const path = [];

    for (let i = 0; i < PLINKO_ROWS; i++) {
        const byte = parseInt(hash.substring(i * 2, i * 2 + 2), 16);
        const move = byte % 2;
        if (move === 1) rightMoves++;
        path.push(move);
    }

    const multiplier = PLINKO_MULTIS[rightMoves];
    const payout = Math.round(amt * multiplier * 1e9) / 1e9;
    const won = multiplier > 1;
    const profit = payout - amt;

    userOps.updateBalance(u.id, profit, won ? 'win_plinko' : 'loss_plinko', `Plinko: Slot ${rightMoves}`);
    userOps.updateStats(u.id, amt, won, profit, multiplier);

    gameOps.create({
        telegramId: u.id, betAmount: amt, gameType: 'plinko', playerChoice: `rows_${PLINKO_ROWS}`,
        diceResult: path.join(','), diceTotal: rightMoves,
        multiplier, payout, profit,
        serverSeed: s.serverSeed, clientSeed: s.clientSeed, nonce: s.nonce, hash, won
    });

    const updated = userOps.get(u.id);
    res.secure({
        result: {
            path, slot: rightMoves, won, multiplier, payout, profit,
            newBalance: updated.balance
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
                    userOps.updateStats(b.telegramId, b.amount, false, -b.amount, 0);
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

// --- HIDE AND SEEK (ПРЯТКИ) GAME ---
const hideState = {
    phase: 'VOTING', // VOTING, SELECTION, SEARCHING, RESULT
    timeLeft: 15,
    roomCountVotes: { 4: 0, 8: 0, 12: 0 },
    finalRoomCount: 4,
    rooms: {}, // { roomId: [ { telegramId, amount, isGift, giftInstanceId } ] }
    bets: [], // { telegramId, amount, isGift, giftInstanceId }
    killerTargets: [], // Array of 3 room IDs
    currentSearchingIdx: 0, // index in killerTargets (0, 1, 2)
    history: [],
    gameId: Math.random().toString(36).substring(2, 9)
};

function tickHide() {
    if (hideState.timeLeft > 0) {
        hideState.timeLeft -= 0.1;
    } else {
        if (hideState.phase === 'VOTING') {
            // Determine final count by votes
            const votes = hideState.roomCountVotes;
            if (votes[12] >= votes[8] && votes[12] >= votes[4] && votes[12] > 0) hideState.finalRoomCount = 12;
            else if (votes[8] >= votes[4] && votes[8] > 0) hideState.finalRoomCount = 8;
            else hideState.finalRoomCount = 4;

            hideState.phase = 'SELECTION';
            hideState.timeLeft = 15;
            hideState.rooms = {};
            for (let i = 1; i <= hideState.finalRoomCount; i++) hideState.rooms[i] = [];
        } else if (hideState.phase === 'SELECTION') {
            hideState.phase = 'SEARCHING';
            hideState.timeLeft = 9; // 3 seconds per room (3 rooms total)
            hideState.currentSearchingIdx = 0;

            // Pick 3 unique random rooms
            const available = Array.from({ length: hideState.finalRoomCount }, (_, i) => i + 1);
            const targets = [];
            for (let i = 0; i < 3; i++) {
                if (available.length === 0) break;
                const idx = Math.floor(Math.random() * available.length);
                targets.push(available.splice(idx, 1)[0]);
            }
            hideState.killerTargets = targets;

            // Process results
            const multMap = { 4: 2.5, 8: 2.0, 12: 1.2 };
            const mult = multMap[hideState.finalRoomCount];

            hideState.bets.forEach(b => {
                let userRoom = null;
                for (const rId in hideState.rooms) {
                    if (hideState.rooms[rId].some(u => u.telegramId === b.telegramId)) {
                        userRoom = Number(rId);
                        break;
                    }
                }

                if (userRoom && !hideState.killerTargets.includes(userRoom)) {
                    // Win (Killer DID NOT visit)
                    const payout = Math.round(b.amount * mult * 100) / 100;
                    userOps.updateBalance(b.telegramId, payout, 'hide_win', `Won hide ${mult}x`);
                    gameOps.create({
                        telegramId: b.telegramId, betAmount: b.amount, gameType: 'hide',
                        playerChoice: `room_${userRoom}`, diceResult: hideState.killerTargets.join(','),
                        multiplier: mult, payout: payout, profit: payout - b.amount, won: 1
                    });
                } else {
                    // Loss (Killer visited OR didn't choose room)
                    gameOps.create({
                        telegramId: b.telegramId, betAmount: b.amount, gameType: 'hide',
                        playerChoice: userRoom ? `room_${userRoom}` : 'none', diceResult: hideState.killerTargets.join(','),
                        multiplier: 0, payout: 0, profit: -b.amount, won: 0
                    });
                }
            });
        } else if (hideState.phase === 'SEARCHING') {
            // Sequential visiting: 0..3s -> room1, 3..6s -> room2, 6..9s -> room3
            const elapsed = 9 - hideState.timeLeft;
            hideState.currentSearchingIdx = Math.min(2, Math.floor(elapsed / 3));

            if (hideState.timeLeft <= 0) {
                hideState.phase = 'RESULT';
                hideState.timeLeft = 5;
            }
        } else if (hideState.phase === 'RESULT') {
            hideState.phase = 'VOTING';
            hideState.timeLeft = 10;
            hideState.roomCountVotes = { 4: 0, 8: 0, 12: 0 };
            hideState.bets = [];
            hideState.rooms = {};
            hideState.gameId = Math.random().toString(36).substring(2, 9);
        }
    }
}
setInterval(tickHide, 100);

app.get('/api/hide/status', auth, (req, res) => {
    res.secure({
        ...hideState,
        myBet: hideState.bets.find(b => b.telegramId === req.tgUser.id),
        myRoom: Object.keys(hideState.rooms).find(rId => hideState.rooms[rId].some(u => u.telegramId === req.tgUser.id))
    });
});

app.post('/api/hide/bet', auth, async (req, res) => {
    if (hideState.phase !== 'VOTING') return res.status(400).secure({ error: 'Voting already finished' });
    const u = req.tgUser;
    const existing = hideState.bets.find(b => b.telegramId === u.id);
    if (existing) return res.status(400).secure({ error: 'Already placed bet' });

    const { betAmount, giftInstanceId } = req.body;
    let amt = 0;

    if (giftInstanceId) {
        const inventory = inventoryOps.getByUser(u.id);
        const item = inventory.find(i => i.instance_id === giftInstanceId);
        if (!item) return res.status(404).secure({ error: 'Gift not found' });
        amt = item.price;
        inventoryOps.remove(giftInstanceId);
    } else {
        amt = parseFloat(betAmount);
        const user = userOps.get(u.id);
        if (user.balance < amt) return res.status(400).secure({ error: 'Insufficient balance' });
        userOps.updateBalance(u.id, -amt, 'hide_bet', 'Hide and seek bet');
    }

    hideState.bets.push({ telegramId: u.id, amount: amt, isGift: !!giftInstanceId, giftInstanceId });
    res.secure({ success: true });
});

app.post('/api/hide/vote', auth, (req, res) => {
    if (hideState.phase !== 'VOTING') return res.status(400).secure({ error: 'Not in voting phase' });
    const bet = hideState.bets.find(b => b.telegramId === req.tgUser.id);
    if (!bet) return res.status(403).secure({ error: 'Must place bet to vote' });

    const { count } = req.body;
    if (![4, 8, 12].includes(Number(count))) return res.status(400).secure({ error: 'Invalid count' });

    // One vote per person (update if already voted? let's stick to simple - increment)
    hideState.roomCountVotes[count]++;
    res.secure({ success: true });
});

app.post('/api/hide/select', auth, (req, res) => {
    if (hideState.phase !== 'SELECTION') return res.status(400).secure({ error: 'Not in selection phase' });
    const u = req.tgUser;
    const bet = hideState.bets.find(b => b.telegramId === u.id);
    if (!bet) return res.status(403).secure({ error: 'Must have bet to play' });

    const { roomId } = req.body;
    const rId = Number(roomId);
    if (!hideState.rooms[rId]) return res.status(400).secure({ error: 'Invalid room' });

    // Max 3 people
    if (hideState.rooms[rId].length >= 3) return res.status(400).secure({ error: 'Room is full' });

    // Remove from other rooms if any
    for (const id in hideState.rooms) {
        hideState.rooms[id] = hideState.rooms[id].filter(p => p.telegramId !== u.id);
    }

    hideState.rooms[rId].push({ telegramId: u.id });
    res.secure({ success: true });
});

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

app.post('/api/crash/bet', auth, async (req, res) => {
    if (crashState.phase !== 'WAITING') return res.status(400).secure({ error: 'Game already started' });

    const u = req.tgUser;
    const user = userOps.get(u.id);
    if (!user || user.is_banned) return res.status(403).secure({ error: 'Denied' });

    const existing = crashState.bets.find(b => b.telegramId === u.id);
    if (existing) return res.status(400).secure({ error: 'Bet already placed' });

    const { betAmount, giftInstanceId } = req.body;
    let amt = 0;

    if (giftInstanceId) {
        const inventory = inventoryOps.getByUser(u.id);
        const item = inventory.find(i => i.instance_id === giftInstanceId);
        if (!item) return res.status(404).secure({ error: 'Gift not found in inventory' });

        amt = item.price;
        const livePrice = await fetchNftFloorPrice(item.title);
        if (livePrice && livePrice.price > 0) amt = livePrice.price;
        if (amt < 0.01) return res.status(400).secure({ error: 'Gift has no market value' });

        inventoryOps.remove(giftInstanceId);
    } else {
        amt = Math.round(parseFloat(betAmount) * 1e9) / 1e9;
        const minBet = parseFloat(settingsOps.get('min_bet') || '0.1');
        const maxBet = parseFloat(settingsOps.get('max_bet') || '100');
        if (isNaN(amt) || amt < minBet || amt > maxBet) return res.status(400).secure({ error: `Min: ${minBet}, Max: ${maxBet}` });
        if (amt > user.balance + 0.000000001) return res.status(400).secure({ error: 'Insufficient balance' });
        userOps.updateBalance(u.id, -amt, 'crash_bet', 'Crash game bet');
    }

    crashState.bets.push({ telegramId: u.id, amount: amt, cashedOut: false, isGift: !!giftInstanceId });

    res.secure({ success: true, newBalance: user.balance - (giftInstanceId ? 0 : amt) });
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
    userOps.updateStats(u.id, bet.amount, true, profit, currentMultiplier);

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

    // Inventory addition
    inventoryOps.add(req.tgUser.id, giftId);

    // Очередь на передачу юзерботом
    giftOps.createTransfer(giftId, req.tgUser.id);
    giftOps.delete(giftId);

    const updated = userOps.get(req.tgUser.id);
    res.secure({ success: true, newBalance: updated.balance });
});

// --- MARKETPLACE & INVENTORY ---

app.get('/api/inventory', auth, (req, res) => {
    res.secure({ inventory: inventoryOps.getByUser(req.tgUser.id) });
});

app.post('/api/marketplace/list', auth, (req, res) => {
    const { instanceId, price } = req.body;
    if (!instanceId || !price) return res.status(400).secure({ error: 'Missing data' });
    try {
        marketplaceOps.list(req.tgUser.id, instanceId, parseFloat(price));
        res.secure({ success: true });
    } catch (e) { res.status(400).secure({ error: e.message }); }
});

app.get('/api/marketplace/items', auth, (req, res) => {
    res.secure({ listings: marketplaceOps.getActive() });
});

app.post('/api/marketplace/buy', auth, (req, res) => {
    const { listingId } = req.body;
    try {
        marketplaceOps.buy(req.tgUser.id, listingId);
        const updated = userOps.get(req.tgUser.id);
        res.secure({ success: true, newBalance: updated.balance });
    } catch (e) { res.status(400).secure({ error: e.message }); }
});

app.post('/api/marketplace/cancel', auth, (req, res) => {
    const { listingId } = req.body;
    try {
        marketplaceOps.cancel(req.tgUser.id, listingId);
        res.secure({ success: true });
    } catch (e) { res.status(400).secure({ error: e.message }); }
});

app.get('/api/inventory/combined', auth, (req, res) => {
    const inventory = inventoryOps.getByUser(req.tgUser.id);
    const listings = marketplaceOps.getByUser(req.tgUser.id);
    res.secure({ inventory, listings });
});

app.post('/api/inventory/withdraw', auth, async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).secure({ error: 'Missing instanceId' });

    try {
        const inventory = inventoryOps.getByUser(req.tgUser.id);
        const item = inventory.find(i => i.instance_id === Number(instanceId));
        if (!item) return res.status(404).secure({ error: 'Item not found in inventory' });

        // Add to transfer queue (using the actual gift_id from 'gifts' table)
        giftOps.createTransfer(item.id, req.tgUser.id);

        // Remove from inventory
        inventoryOps.remove(instanceId);

        res.secure({ success: true, message: 'Заявка на вывод создана. Напишите дилеру для получения подарка.' });
    } catch (e) {
        res.status(500).secure({ error: e.message });
    }
});

// --- DAILY SPIN ---

app.post('/api/daily-spin', auth, (req, res) => {
    const user = userOps.get(req.tgUser.id);
    const now = new Date();

    if (user.last_daily_spin) {
        const last = new Date(user.last_daily_spin);
        const diff = now - last;
        if (diff < 24 * 60 * 60 * 1000) {
            const rem = 24 * 60 * 60 * 1000 - diff;
            const h = Math.floor(rem / 3600000);
            const m = Math.floor((rem % 3600000) / 60000);
            return res.status(400).secure({ error: `Вернитесь через ${h}ч ${m}м` });
        }
    }

    // Prizes matching Frontend initWheelLabels
    // ['0.01', '💀', '0.05', '💀', '0.1', '💀', '0.5', '💀', '1.0', '💀', '10.0', '💀']
    const prizes = [0.01, 0, 0.05, 0, 0.1, 0, 0.5, 0, 1.0, 0, 10.0, 0];

    // Weighted probabilities (total 1000)
    // 0: 0.01 (300/1000), 1: 💀 (200/1000), 2: 0.05 (150/1000), 3: 💀 (100/1000), 
    // 4: 0.1 (80/1000), 5: 💀 (70/1000), 6: 0.5 (50/1000), 7: 💀 (30/1000),
    // 8: 1.0 (15/1000), 9: 💀 (4/1000), 10: 10.0 (1/1000), 11: 💀 (0/1000)
    const weights = [300, 200, 150, 100, 80, 70, 50, 30, 15, 4, 1, 0];
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const roll = Math.floor(Math.random() * totalWeight);

    let current = 0, index = 0;
    for (let i = 0; i < weights.length; i++) {
        current += weights[i];
        if (roll < current) {
            index = i;
            break;
        }
    }

    const prize = prizes[index];
    const win = prize > 0;

    if (win) userOps.updateBalance(req.tgUser.id, prize, 'daily_spin_win', 'Won on Wheel of Fortune');

    db.prepare("UPDATE users SET last_daily_spin = datetime('now') WHERE telegram_id = ?").run(req.tgUser.id);

    res.secure({ index, win, prize, newBalance: userOps.get(req.tgUser.id).balance });
});

app.post('/api/user/auto-cashout', auth, (req, res) => {
    const { multiplier } = req.body;
    const m = parseFloat(multiplier);
    if (isNaN(m) || m < 0) return res.status(400).secure({ error: 'Invalid multiplier' });
    db.prepare('UPDATE users SET auto_cashout = ? WHERE telegram_id = ?').run(m, req.tgUser.id);
    res.secure({ success: true });
});

app.post('/api/deposit/request', auth, (req, res) => {
    const { amount } = req.body;
    const amt = parseFloat(amount);
    let minDep = parseFloat(settingsOps.get('min_deposit') || 0.001);

    if (isNaN(amt) || amt < minDep) return res.status(400).secure({ error: `Минимум: ${minDep} TON` });

    const comment = 'deposit_' + Math.floor(100000 + Math.random() * 900000);
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

    const nano = Math.round(amt * 1e9).toString();
    const link = `ton://transfer/${wallet}?amount=${nano}&text=${encodeURIComponent(comment)}`;

    // Send BOT message for direct payment
    if (bot) {
        bot.sendMessage(req.tgUser.id,
            `💰 *Заявка на пополнение*\n\n` +
            `💵 Сумма: *${amt.toFixed(2)} TON*\n` +
            `📝 Комментарий: \`${comment}\`\n\n` +
            `Нажмите на кнопку ниже, чтобы перейти к оплате в TON кошельке.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💎 ОПЛАТИТЬ (Direct Link)', url: link }]
                    ]
                }
            }
        ).catch(e => console.error('[Bot] Send payment error:', e.message));
    }

    res.secure({ success: true, comment, address: wallet, link });
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
    if (typeof msg.message === 'string' && msg.message.trim()) return msg.message.trim();
    if (msg.msg_data) {
        if (typeof msg.msg_data.text === 'string' && msg.msg_data.text.trim()) return msg.msg_data.text.trim();
        if (msg.msg_data['@type'] === 'msg.dataRaw' && typeof msg.msg_data.body === 'string') {
            try {
                const body = Buffer.from(msg.msg_data.body, 'base64');
                if (body.length < 5) return null;
                const opcode = body.readUInt32BE(0);
                if (opcode === 0) return body.subarray(4).toString('utf8').replace(/\0+$/, '').trim();
                const plainText = body.toString('utf8').replace(/\0+$/, '').trim();
                if (/^[a-zA-Z0-9_-]+$/.test(plainText)) return plainText;
            } catch (e) { }
        }
    }
    return null;
}

async function checkTonTransactions() {
    try {
        const settings = settingsOps.getAll();
        let addr = settings.ton_wallet;
        if (!addr || addr.includes('...') || addr.includes('your-')) addr = process.env.TON_WALLET;
        if (!addr || !addr.trim() || addr.includes('...')) return;

        const apiKey = process.env.TONCENTER_API_KEY || '';
        const url = `https://toncenter.com/api/v2/getTransactions?address=${addr.trim()}&limit=30`;

        https.get(url, { headers: apiKey ? { 'X-API-Key': apiKey } : {} }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.ok) return;
                    const txs = data.result || [];

                    txs.forEach(tx => {
                        const txHash = tx.transaction_id.hash;
                        if (depositOps.isHashUsed(txHash)) return;

                        const msg = tx.in_msg;
                        if (!msg || !msg.value) return;

                        const comment = parseTonComment(msg);
                        const fromAddr = msg.source || msg.from;
                        const amountTON = Number(msg.value) / 1e9;

                        let matchFound = false;

                        // 1. Поиск по комментарию (Приоритет)
                        if (comment) {
                            const pending = depositOps.getByComment(comment);
                            if (pending && pending.status === 'pending' && amountTON >= pending.amount * 0.98) {
                                processSuccessDeposit(pending.telegram_id, amountTON, comment, txHash);
                                matchFound = true;
                            }
                        }

                        // 2. Поиск по адресу кошелька (Если комментарий не подошел)
                        if (!matchFound && fromAddr) {
                            const user = userOps.getByWallet(fromAddr);
                            if (user && amountTON >= 0.01) {
                                processSuccessDeposit(user.telegram_id, amountTON, `AddressMatch:${fromAddr.substring(0, 8)}`, txHash);
                            }
                        }
                    });
                } catch (e) { console.error('[TON Poller] Error:', e.message); }
            });
        }).on('error', () => { });
    } catch (e) { }
}

function processSuccessDeposit(tgId, amount, memo, txHash) {
    if (depositOps.isHashUsed(txHash)) return; // Защита от дублей
    userOps.updateBalance(tgId, amount, 'deposit', `TON Deposit (${memo})`);
    depositOps.markCompleted(memo, txHash);

    const logChannel = process.env.LOG_CHANNEL_ID || settingsOps.get('log_channel_id');
    if (logChannel && bot) {
        const user = userOps.get(tgId);
        const userLink = user.username ? `@${user.username}` : `[${user.first_name}](tg://user?id=${user.telegram_id})`;
        bot.sendMessage(logChannel,
            `💰 *АВТО-ПОПОЛНЕНИЕ*\n\n` +
            `👤 Игрок: ${userLink}\n` +
            `💵 Сумма: *${amount.toFixed(2)} TON*\n` +
            `📝 Тип: \`${memo}\`\n` +
            `🔗 [Транзакция](https://tonviewer.com/transaction/${txHash})`,
            { parse_mode: 'Markdown' }
        ).catch(() => { });
    }
}

// Одиночный интервал для мониторинга
setInterval(checkTonTransactions, 15000);

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

                                                // Log to channel
                                                const logChannel = process.env.LOG_CHANNEL_ID || settingsOps.get('log_channel_id');
                                                if (logChannel && bot) {
                                                    const userLink = user.username ? `@${user.username}` : `[${user.first_name}](tg://user?id=${user.telegram_id})`;
                                                    bot.sendMessage(logChannel,
                                                        `🎁 *ПРОДАЖА ПОДАРКА (ВЫВОД)*\n\n` +
                                                        `👤 Игрок: ${userLink}\n` +
                                                        `🏷 Название: *${nftName}*\n` +
                                                        `💰 Выплачено: *${dynamicPrice.toFixed(2)} TON*\n` +
                                                        `🔗 [Транзакция](https://tonviewer.com/transaction/${txHash})`,
                                                        { parse_mode: 'Markdown' }
                                                    ).catch(e => console.error('[Log] Failed to send gift_sell log:', e.message));
                                                }
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

app.get('/api/admin/monitor-logs', auth, adminOnly, (req, res) => {
    res.secure({ logs: monitoringLogs });
});

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
    const totalReferrals = db.prepare('SELECT COALESCE(SUM(referral_count), 0) as c FROM users').get().c;
    const totalRefEarned = db.prepare('SELECT COALESCE(SUM(referral_earned), 0) as s FROM users').get().s;
    res.secure({
        overall: gameOps.getStats(), today: gameOps.getTodayStats(),
        userCount: userOps.getCount(), settings: settingsOps.getAll(),
        totalReferrals, totalRefEarned
    });
});

app.post('/api/admin/stats/reset', auth, adminOnly, (req, res) => {
    gameOps.resetAllStats();
    res.secure({ success: true, message: 'Все статистические данные сброшены' });
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

// --- ADMIN: REFERRALS ---
app.get('/api/admin/referrals', auth, adminOnly, (req, res) => {
    try {
        // ULTIMATE SEARCH: Union of all possible referrer sources
        const referrers = db.prepare(`
            SELECT 
                u.telegram_id, 
                u.username, 
                u.first_name, 
                COALESCE(u.referral_count, 0) as referral_count, 
                COALESCE(u.referral_earned, 0) as referral_earned, 
                u.referral_code, 
                COALESCE(u.referral_bonus_claimed, 0) as referral_bonus_claimed,
                (
                    SELECT MAX(cnt) FROM (
                        SELECT COUNT(*) as cnt FROM users r 
                        WHERE TRIM(CAST(r.referred_by AS TEXT)) = TRIM(CAST(u.telegram_id AS TEXT))
                           OR (u.referral_code IS NOT NULL AND TRIM(CAST(r.referred_by AS TEXT)) = TRIM(CAST(u.referral_code AS TEXT)))
                        UNION ALL
                        SELECT COALESCE(u.referral_count, 0) as cnt
                    )
                ) as actual_refs
            FROM users u
            WHERE u.referral_count > 0 
               OR u.referral_earned > 0
               OR EXISTS (
                   SELECT 1 FROM users r 
                   WHERE TRIM(CAST(r.referred_by AS TEXT)) = TRIM(CAST(u.telegram_id AS TEXT))
                      OR (u.referral_code IS NOT NULL AND TRIM(CAST(r.referred_by AS TEXT)) = TRIM(CAST(u.referral_code AS TEXT)))
               )
            ORDER BY actual_refs DESC, u.referral_count DESC
        `).all();

        // Total count of unique referral links ever created
        const totalReferrals = db.prepare('SELECT COALESCE(SUM(referral_count), 0) as c FROM users').get().c;
        const totalRefEarned = db.prepare('SELECT COALESCE(SUM(referral_earned), 0) as s FROM users').get().s;

        console.log(`[Admin] Referrals Final Check: ${referrers.length} lines in table. Total refs in DB: ${totalReferrals}`);
        res.secure({ referrers, totalReferrals, totalRefEarned });
    } catch (e) {
        console.error('[Admin] Referrals error:', e.message);
        res.status(500).secure({ error: e.message });
    }
});

app.get('/api/admin/referrals/:id', auth, adminOnly, (req, res) => {
    try {
        const refIdStr = String(req.params.id);
        const referrer = db.prepare('SELECT * FROM users WHERE CAST(telegram_id AS TEXT) = CAST(? AS TEXT) OR referral_code = ? OR username = ? OR username = ?').get(refIdStr, refIdStr, refIdStr, refIdStr.replace('@', '')) || { telegram_id: refIdStr, first_name: 'Unknown' };

        const matches = [refIdStr];
        matches.push(String(referrer.telegram_id));
        if (referrer.referral_code) matches.push(referrer.referral_code);
        if (referrer.username) {
            matches.push(referrer.username);
            matches.push('@' + referrer.username);
        }

        const placeholders = matches.map(() => 'TRIM(CAST(u.referred_by AS TEXT)) = TRIM(CAST(? AS TEXT))').join(' OR ');

        const referrals = db.prepare(`
            SELECT u.telegram_id, u.username, u.first_name, u.balance,
                   u.total_wagered, u.total_won, u.total_lost, u.games_played,
                   COALESCE((SELECT SUM(amount) FROM transactions WHERE telegram_id = u.telegram_id AND type = 'deposit'), 0) as total_deposits,
                   COALESCE((SELECT SUM(amount) FROM transactions WHERE telegram_id = u.telegram_id AND type = 'withdrawal'), 0) as total_withdrawals,
                   u.created_at
            FROM users u
            WHERE ${placeholders}
            ORDER BY u.created_at DESC
        `).all(...matches);

        // Calculate net profit per referral (for the house)
        const detailedRefs = referrals.map(r => ({
            ...r,
            netProfit: (r.total_deposits || 0) - (r.total_withdrawals || 0) - r.balance,
            lostToHouse: r.total_wagered - r.total_won,
            commissionGenerated: Math.max(0, r.total_wagered - r.total_won) * 0.1
        }));

        res.secure({
            referrer: {
                telegram_id: referrer.telegram_id,
                username: referrer.username,
                first_name: referrer.first_name,
                referral_earned: referrer.referral_earned,
                referral_count: referrer.referral_count,
                referral_bonus_claimed: referrer.referral_bonus_claimed
            },
            referrals: detailedRefs
        });
    } catch (e) {
        console.error('[Admin] Referral details error:', e.message);
        res.status(500).secure({ error: e.message });
    }
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
