// cuberoll frontend
// TonWeb Safety Helper - Ensure library is available
function getTonWeb() {
    if (window.tonweb) return window.tonweb;
    if (window.TonWeb) {
        window.tonweb = new window.TonWeb();
        return window.tonweb;
    }
    return null;
}
window.getTonWeb = getTonWeb;

const API = '';
let tg = null, initData = '';
var user = null;
let settings = {}, curSeeds = {};
let betType = 'high';
let exactNum = 7;
let rangeMin = 2, rangeMax = 6;
let rolling = false;
let streak = 0;
let dailyClaimed = false;
let tonConnectUI = null;
let isInitializing = true;
let hapticEnabled = localStorage.getItem('settings_haptic') !== 'false';
let plinkoCanvas = null;
let plinkoCtx = null;
let plinkoBalls = [];
let activeTab = 'game';
let currentGame = 'dice';
let userWalletAddress = null;

// Глобальные UI функции должны быть доступны СРАЗУ
window.closeModal = (id) => {
    const m = document.getElementById(id);
    if (m) m.classList.add('hidden');
};

window.switchTab = function (tab) {
    console.log('[Tab] Switching to', tab);
    activeTab = tab;

    if (tab === 'leaderboard') { openLeaderboard(); return; }
    if (tab === 'history') { openHistory(); return; }

    const content = document.getElementById('content-' + tab);
    const navBtn = document.querySelector(`[data-tab="${tab}"]`);

    if (!content) return;

    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));

    content.classList.add('active');
    if (navBtn) navBtn.classList.add('active');

    if (tab === 'shop') loadGifts();
    if (tab === 'settings') {
        const toggle = document.getElementById('settings-haptic');
        if (toggle) toggle.checked = hapticEnabled;
    }
};

window.openLeaderboard = function () {
    document.getElementById('leaderboard-modal').classList.remove('hidden');
    loadLeaderboard();
};

window.openHistory = function () {
    document.getElementById('history-modal').classList.remove('hidden');
    loadHistory();
};

// Game selection logic is consolidated below in the logic sections

// "Шифрование" для "обычных смертных"
const _SEC_KEY = 'cuberoll';
const _0x_dec = (s) => {
    try {
        const raw = atob(s);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            bytes[i] = raw.charCodeAt(i) ^ _SEC_KEY.charCodeAt(i % _SEC_KEY.length);
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        console.error('Decryption failed:', e, s);
        // Если это уже JSON, пытаемся вернуть как есть (на случай если сервер прислал не маскированное)
        try { return JSON.parse(s); } catch (e2) { throw e; }
    }
};
window.api = api;
window.user = user;

// тг
function initTg() {
    if (window.Telegram && window.Telegram.WebApp) {
        tg = window.Telegram.WebApp;
        try {
            tg.ready();
            tg.expand();
            tg.setHeaderColor('#0d0d0d');
            tg.setBackgroundColor('#0d0d0d');
        } catch (e) { console.warn('[TG] UI setup partially failed'); }
        initData = tg.initData || '';
        if (tg.HapticFeedback) window.haptic = tg.HapticFeedback;
        console.log('[TG] Bridge connected, initData length:', initData.length);
    }
}

async function api(url, method = 'GET', body = null) {
    const h = { 'Content-Type': 'application/json' };
    if (initData) h['X-Telegram-Init-Data'] = initData;
    else h['X-Dev-User-Id'] = '12345';
    const opts = { method, headers: h };
    if (body) opts.body = JSON.stringify(body);
    try {
        const res = await fetch(API + url, opts);

        if (res.status === 403) {
            const raw = await res.text();
            try {
                const e = _0x_dec(raw);
                if (e.error === 'Account is banned') {
                    showBanScreen();
                    throw new Error('Banned');
                }
            } catch (err) { }
        }

        const rawData = await res.text();
        if (!res.ok) {
            let e = {};
            try {
                e = _0x_dec(rawData);
            } catch (err) {
                // Если не смогли расшифровать - значит сервер прислал обычную ошибку (например 502)
                const errResult = new Error(`Server Error: ${res.status}`);
                errResult.status = res.status;
                throw errResult;
            }
            const errResult = new Error(e.error || `Error ${res.status}`);
            errResult.status = res.status;
            throw errResult;
        }

        return _0x_dec(rawData);
    } catch (err) {
        console.error('API Error:', err);
        throw err;
    }
}

function showBanScreen() {
    document.getElementById('ban-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'none';
}

// Global error handler for debugging
window.onerror = function (msg, url, line) {
    console.error('CRITICAL:', msg, 'at', line);
    if (window.toast) toast('System Error: ' + msg, 'error');
};

// Manual retry for lock screen
window.retryTgAuth = function () {
    console.log('[Lock] Manual retry triggered');
    init();
};

// инит
async function init() {
    console.log('[Init] Starting robust entry sequence...');

    const lockMsg = document.querySelector('#tg-lock p');
    const updateDebug = (msg) => {
        if (lockMsg) lockMsg.innerHTML = `Это приложение доступно только внутри бота CubeRoll.<br><small style="opacity:0.5; font-size:10px;">Debug: ${msg}</small>`;
    };

    // Polling loop for the bridge
    let attempts = 0;
    const maxAttempts = 25; // 5 seconds total

    return new Promise((resolve) => {
        const checkInterval = setInterval(async () => {
            attempts++;
            initTg();

            const hasBridge = !!(window.Telegram && window.Telegram.WebApp);
            const hasData = !!(initData || window.Telegram?.WebApp?.initDataUnsafe?.user);
            const isDev = window.location.hostname === 'localhost' ||
                window.location.hostname === '127.0.0.1' ||
                window.location.hostname.includes('.local');

            updateDebug(`Bridge: ${hasBridge ? 'OK' : 'No'} | Data: ${hasData ? 'OK' : 'No'} | Atmt: ${attempts}`);

            if (hasBridge || isDev) {
                clearInterval(checkInterval);
                console.log('[Init] Environment verified. Opening app...');
                document.getElementById('tg-lock')?.remove();

                // Continue with actual loading
                try {
                    const loader = document.getElementById('loading-screen');
                    if (loader) loader.classList.remove('hidden');

                    buildExactPicker();

                    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
                        manifestUrl: window.location.origin + '/tonconnect-manifest.json',
                        buttonRootId: null
                    });

                    // Initialize TonWeb IMMEDIATELY global scope
                    if (window.TonWeb && !window.tonweb) {
                        try { window.tonweb = new window.TonWeb(); } catch (e) { console.error('TonWeb init failed', e); }
                    }

                    tonConnectUI.onStatusChange(async wallet => {
                        if (wallet) {
                            userWalletAddress = wallet.account.address;
                            document.getElementById('ton-connect').classList.add('connected');

                            // Initialize global TonWeb if needed by legacy modules
                            if (window.TonWeb && !window.tonweb) {
                                window.tonweb = new window.TonWeb();
                            }

                            try {
                                await api('/api/user/wallet', 'POST', { address: userWalletAddress });
                            } catch (e) { }
                            if (!window.isInitializing) toast('Кошелёк подключен', 'success');
                        } else {
                            userWalletAddress = null;
                            document.getElementById('ton-connect').classList.remove('connected');
                        }
                        isInitializing = false;
                    });

                    console.log('[Init] Authenticating...');
                    const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
                    const data = await api('/api/auth', 'POST', { start_param: startParam });
                    user = data.user;
                    curSeeds = data.seeds;
                    window.appSettings = data.settings || {};

                    if (window.appSettings.minDeposit) {
                        const h = document.getElementById('dep-min-hint');
                        if (h) h.textContent = `Минимум: ${window.appSettings.minDeposit} TON`;
                    }

                    // Direct Pay Helper
                    // Direct Pay Helper
                    window.directPay = function () {
                        const amount = document.getElementById('dep-amount').value;
                        if (!amount || amount < 0.1) return toast('Минимум 0.1 TON', 'error');

                        // Fallback address if settings missing (from user context)
                        const address = window.appSettings.walletAddress || 'UQBAKsT_w4C6C26KxGv3sE5g7nQ8y_d4X5z1V2b3N4m5K6L7';

                        // Random 9 digit number
                        const rnd = Math.floor(100000000 + Math.random() * 900000000);
                        const comment = `deposit_${rnd}`;

                        if (!address) return toast('Ошибка адреса системы', 'error');

                        const nano = Math.floor(amount * 1000000000);
                        const link = `ton://transfer/${address}?amount=${nano}&text=${comment}`;

                        // Open deep link
                        window.location.href = link;
                    };

                    document.getElementById('user-name').textContent = user.username || user.firstName || 'Player';
                    document.getElementById('user-id').textContent = 'ID: ' + user.telegramId;

                    setBalance(user.balance);

                    // Update Referral Info
                    const refLink = `https://t.me/CubeRollBot/play?startapp=${user.telegramId}`;
                    const refLinkEl = document.getElementById('referral-link');
                    if (refLinkEl) refLinkEl.textContent = refLink;
                    const refEarnedEl = document.getElementById('ref-earned-value');
                    if (refEarnedEl) refEarnedEl.textContent = (user.referralEarned || 0).toFixed(2) + ' TON';

                    // Update UI for Auto Cashout
                    const autoEl = document.getElementById('crash-auto-cashout');
                    if (autoEl && user.autoCashout) autoEl.value = user.autoCashout;

                    // Initialize modules independently
                    try { await loadHistory(); } catch (e) { console.error('[Init] History failed', e); }
                    try { await loadGifts(); } catch (e) { console.error('[Init] Gifts failed', e); }
                    try { initEventListeners(); } catch (e) { console.error('[Init] Listeners failed', e); }
                    try { initPlinko(); } catch (e) { console.error('[Init] Plinko failed', e); }
                    try { initWheelLabels(); } catch (e) { }

                    finishLoading();
                    resolve();
                } catch (err) {
                    console.error('[Init] Fatal error:', err);
                    if (err.message !== 'Banned') toast('Error: ' + err.message, 'error');
                }
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                updateDebug('Telegram bridge not detected. Please open from the official bot.');
                console.error('[Init] Timeout waiting for Telegram bridge.');
            }
        }, 200);
    });
}

function finishLoading() {
    setTimeout(() => {
        const ldr = document.getElementById('loading-screen');
        if (ldr) {
            ldr.classList.add('fade-out');
            setTimeout(() => {
                ldr.style.display = 'none';
                document.getElementById('app').classList.remove('hidden');
                if (!localStorage.getItem('onboarding_shown')) {
                    document.getElementById('onboarding-modal').classList.remove('hidden');
                    localStorage.setItem('onboarding_shown', 'true');
                }
            }, 800);
        }
    }, 1200);

    // BG Sync
    setInterval(refreshBalance, 30000); // 30s balance check
}

function toast(txt, type = 'info') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = txt;
    t.className = 'toast show ' + type;
    setTimeout(() => t.classList.remove('show'), 3000);
}

function setBalance(val, anim = false) {
    const el = document.getElementById('balance-amount');
    if (!el) return;
    const old = parseFloat(el.textContent) || 0;
    el.textContent = val.toFixed(2);
    if (anim) {
        const p = document.getElementById('balance-display');
        if (!p) return;
        p.classList.remove('pulse', 'pulse-loss');
        void p.offsetWidth;
        p.classList.add(val > old ? 'pulse' : 'pulse-loss');
    }
}

function openStats() {
    if (!user) return;
    document.getElementById('stat-wagered').textContent = (user.totalWagered || 0).toFixed(2);
    document.getElementById('stat-won').textContent = (user.totalWon || 0).toFixed(2);
    document.getElementById('stat-lost').textContent = (user.totalLost || 0).toFixed(2);
    document.getElementById('stat-max-mult').textContent = (user.biggestWinMult || 0).toFixed(2) + 'x';
    document.getElementById('stats-modal').classList.remove('hidden');
}

function copyReferralLink() {
    const link = document.getElementById('referral-link').textContent;
    navigator.clipboard.writeText(link).then(() => {
        toast('Ссылка скопирована!', 'success');
    });
}


window.toggleHaptic = function () {
    hapticEnabled = document.getElementById('settings-haptic').checked;
    localStorage.setItem('settings_haptic', hapticEnabled);
    if (hapticEnabled) toast('Вибрация включена');
};

window.redeemPromo = async function () {
    const input = document.getElementById('promo-input');
    const code = input.value.trim();
    if (!code) return toast('Введите промокод');

    try {
        const res = await api('/api/promocodes/redeem', 'POST', { code });
        toast('✅ ' + res.message);
        input.value = '';
        if (res.newBalance !== undefined) setBalance(res.newBalance, true);
        auth();
    } catch (e) {
        toast('❌ ' + e.message);
    }
}

const sounds = {
    roll: new Audio('https://assets.mixkit.co/active_storage/sfx/2005/2005-preview.mp3'), // Короткий звук
    win: new Audio('https://cdn.pixabay.com/audio/2021/08/04/audio_0625c1399c.mp3'),   // Успех, колокольчик
    loss: new Audio('https://cdn.pixabay.com/audio/2022/03/10/audio_c3527a2333.mp3')   // Неудача, низкий тон
};

function playSound(type) {
    // Звуки отключены по просьбе пользователя
    return;
}

// Игра
window.getBetType = (t) => {
    betType = t;
    document.querySelectorAll('.bet-type-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-bet="${t}"]`)?.classList.add('active');

    // Показ пикеров
    document.getElementById('exact-picker').style.display = (t === 'exact') ? 'block' : 'none';

    updatePayoutUI();
};

function updatePayoutUI() {
    let mult = 0;
    if (betType === 'high' || betType === 'low') mult = 1.75;
    if (betType === 'even' || betType === 'odd') mult = 1.7;
    if (betType === 'seven') mult = 3.2;
    if (betType === 'doubles') mult = 4.5;
    if (betType === 'exact') {
        const mults = { 2: 32, 3: 15, 4: 10, 5: 7.7, 6: 6.3, 7: 5.2, 8: 6.3, 9: 7.7, 10: 10, 11: 15, 12: 32 };
        mult = mults[exactNum] || 0;
    }
    const amt = parseFloat(document.getElementById('bet-amount').value) || 0;
    document.getElementById('potential-amount').textContent = (amt * mult).toFixed(2);
}

window.onBetInput = updatePayoutUI;

window.adjustBet = (act) => {
    let val = parseFloat(document.getElementById('bet-amount').value) || 1.0;
    if (act === 'half') val /= 2;
    if (act === 'double') val *= 2;
    if (val < 0.1) val = 0.1;
    document.getElementById('bet-amount').value = val.toFixed(1);
    updatePayoutUI();
};

window.quickBet = (val) => {
    document.getElementById('bet-amount').value = val.toFixed(1);
    updatePayoutUI();
};

function buildExactPicker() {
    const container = document.getElementById('exact-nums');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 2; i <= 12; i++) {
        const d = document.createElement('div');
        d.className = 'exact-num' + (i === exactNum ? ' active' : '');
        d.textContent = i;
        d.onclick = () => {
            exactNum = i;
            document.querySelectorAll('.exact-num').forEach(x => x.classList.remove('active'));
            d.classList.add('active');
            updatePayoutUI();
        };
        container.appendChild(d);
    }
}

function initEventListeners() {
    console.log('[Init] Setting up listeners...');

    // Вкладки
    document.querySelectorAll('.nav-tab').forEach(btn => {
        if (btn) btn.onclick = () => switchTab(btn.dataset.tab);
    });

    // Безопасное назначение обработчиков
    const safeSetClick = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.onclick = fn;
    };

    // Суммы (в модалке)
    safeSetClick('btn-half', () => adjustBet('half'));
    safeSetClick('btn-double', () => adjustBet('double'));

    document.querySelectorAll('.quick-bet').forEach(btn => {
        btn.onclick = () => {
            const val = btn.getAttribute('data-amount');
            const inp = document.getElementById('bet-amount');
            if (inp && user) {
                if (val === 'max') inp.value = user.balance.toFixed(1);
                else inp.value = parseFloat(val).toFixed(1);
            }
            document.querySelectorAll('.quick-bet').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePayoutUI();
        };
    });

    // Типы ставок (в модалке)
    document.querySelectorAll('.bet-type-btn').forEach(btn => {
        btn.onclick = () => getBetType(btn.getAttribute('data-bet'));
    });

    // Модалка открытия ставки
    safeSetClick('open-bet-modal-btn', () => {
        const m = document.getElementById('bet-modal');
        if (m) {
            m.classList.remove('hidden');
            updatePayoutUI();
        }
    });

    // Подтверждение
    safeSetClick('roll-btn-confirm', roll);

    // Инпуты
    const pBetAmt = document.getElementById('plinko-bet-amount');
    if (pBetAmt) pBetAmt.oninput = updatePlinkoPreviews;

    // Seeds & Verify
    safeSetClick('btn-rotate-seed', rotateServerSeed);
    safeSetClick('btn-update-seed', updateClientSeed);
    safeSetClick('btn-verify', verifyGame);

    // Delegated listener for bet confirm — works even if modal was opened dynamically (dice/plinko/crash/hide)
    document.addEventListener('click', function betConfirmHandler(e) {
        const btn = e.target && (e.target.closest ? e.target.closest('#bet-confirm-btn') : (e.target.id === 'bet-confirm-btn' ? e.target : null));
        if (!btn || !document.getElementById('bet-modal') || document.getElementById('bet-modal').classList.contains('hidden')) return;
        e.preventDefault();
        e.stopPropagation();
        if (activeBetGame === 'dice') roll();
        else if (activeBetGame === 'crash') crashPlaceBet();
        else if (activeBetGame === 'plinko') { closeModal('bet-modal'); plinkoDrop(); }
        else if (activeBetGame === 'hide') { closeModal('bet-modal'); placeHideBet(); }
    }, true);
}

window.rotateServerSeed = async function () {
    try {
        const res = await api('/api/seeds/rotate', 'POST');
        document.getElementById('server-seed-hash').textContent = res.newServerSeedHash;
        document.getElementById('nonce-value').textContent = res.nonce;
        if (res.oldServerSeed) {
            const revealBlock = document.getElementById('old-seed-reveal');
            revealBlock.style.display = 'block';
            document.getElementById('old-server-seed').textContent = res.oldServerSeed;
            document.getElementById('old-server-hash').textContent = res.oldServerSeedHash;

            setTimeout(() => {
                revealBlock.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }, 120);
        }
        toast('Server Seed обновлён', 'success');
    } catch (e) { toast(e.message, 'error'); }
};

window.updateClientSeed = async function () {
    const val = document.getElementById('client-seed-input').value;
    if (!val) return toast('Введите сид', 'error');
    try {
        await api('/api/seeds/client', 'POST', { clientSeed: val });
        toast('Client Seed обновлён', 'success');
    } catch (e) { toast(e.message, 'error'); }
};

window.verifyGame = async function () {
    const ss = document.getElementById('verify-server-seed').value;
    const cs = document.getElementById('verify-client-seed').value;
    const n = document.getElementById('verify-nonce').value;
    if (!ss || !cs || !n) return toast('Заполните все поля', 'error');

    try {
        const res = await api('/api/verify', 'POST', { serverSeed: ss, clientSeed: cs, nonce: n });
        document.getElementById('verify-result').style.display = 'block';
        document.getElementById('verify-dice').textContent = res.dice.join(' - ');
        document.getElementById('verify-total').textContent = res.total;
        document.getElementById('verify-hash').textContent = res.serverSeedHash.substring(0, 16) + '...';
    } catch (e) { toast(e.message, 'error'); }
};

window.roll = async function () {
    // FORCE RESET if stuck (more than 2s since last attempt)
    const now = Date.now();
    if (rolling && (now - (window.lastRollAttempt || 0) > 2000)) {
        console.warn('Force resetting stuck dice roll');
        rolling = false;
    }
    if (rolling) return;
    window.lastRollAttempt = now;

    const betEl = document.getElementById('bet-amount');
    if (!betEl) return toast('Interface error', 'error');

    const amt = parseFloat(betEl.value);
    if (betMode === 'ton') {
        if (isNaN(amt) || amt < 0.1) return toast('Мин. ставка 0.1 TON', 'error');
        if (amt > user.balance) return toast('Недостаточно баланса', 'error');
    } else {
        if (!selectedGift) return toast('Выберите подарок', 'error');
    }

    closeModal('bet-modal');
    rolling = true;
    const rollBtn = document.getElementById('open-bet-modal-btn');
    if (rollBtn) rollBtn.disabled = true;

    try {
        const payload = {
            betAmount: amt,
            betType: document.querySelector('.bet-type-btn.active')?.dataset.bet || 'high'
        };
        if (betMode === 'gift' && selectedGift) {
            payload.giftInstanceId = selectedGift.instance_id;
            selectedGift = null;
        }

        const res = await api('/api/bet', 'POST', payload);
        if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
        animateDice(res.result.dice);

        // Reset rolling flag after animation
        setTimeout(() => {
            user.balance = res.result.newBalance;
            setBalance(user.balance, true);
            showResult(res.result);
            rolling = false;
            if (rollBtn) rollBtn.disabled = false;
        }, 1200);
    } catch (e) {
        rolling = false;
        if (rollBtn) rollBtn.disabled = false;
        toast(e.message, 'error');
    }
};

window.lastRollAttempt = 0; // Global tracking for stuck state

function animateDice(vals) {
    const d1 = document.getElementById('die1');
    const d2 = document.getElementById('die2');

    d1.style.transition = 'none';
    d2.style.transition = 'none';
    d1.style.transform = `rotateX(${Math.random() * 360}deg) rotateY(${Math.random() * 360}deg)`;
    d2.style.transform = `rotateX(${Math.random() * 360}deg) rotateY(${Math.random() * 360}deg)`;

    void d1.offsetWidth;

    d1.style.transition = 'transform 1.2s cubic-bezier(0.15, 0.6, 0.3, 1)';
    d2.style.transition = 'transform 1.2s cubic-bezier(0.15, 0.6, 0.3, 1)';

    setDiceFace(d1, vals[0]);
    setDiceFace(d2, vals[1]);
}

function setDiceFace(el, val) {
    const rotations = {
        1: 'rotateX(0deg) rotateY(0deg)',
        2: 'rotateX(-90deg) rotateY(0deg)',
        3: 'rotateX(0deg) rotateY(-90deg)',
        4: 'rotateX(0deg) rotateY(90deg)',
        5: 'rotateX(90deg) rotateY(0deg)',
        6: 'rotateX(0deg) rotateY(180deg)'
    };
    el.style.transform = rotations[val] || rotations[1];
}

// --- GIFT BETTING LOGIC ---
let selectedGiftForBet = null;

window.setBetMode = function (mode) {
    const tonBtn = document.getElementById('bet-mode-ton');
    const giftBtn = document.getElementById('bet-mode-gifts');
    const tonArea = document.getElementById('bet-ton-input-area');
    const giftArea = document.getElementById('bet-gift-input-area');
    const betInput = document.getElementById('bet-amount');

    if (mode === 'ton') {
        tonBtn.classList.add('active');
        giftBtn.classList.remove('active');
        tonArea.classList.remove('hidden');
        giftArea.classList.add('hidden');
        selectedGiftForBet = null;
        betInput.disabled = false;
        betInput.style.color = '';
    } else {
        tonBtn.classList.remove('active');
        giftBtn.classList.add('active');
        tonArea.classList.add('hidden');
        giftArea.classList.remove('hidden');
        loadInventoryForBet();
    }
};

async function loadInventoryForBet() {
    const list = document.getElementById('gift-selection-list');
    list.innerHTML = '<div class="empty-state">...</div>';

    try {
        const { inventory } = await api('/api/inventory');
        if (!inventory || inventory.length === 0) {
            list.innerHTML = '<div style="grid-column: 1/-1; padding: 20px; text-align: center; font-size: 11px; opacity: 0.5;">Инвентарь пуст</div>';
            return;
        }

        list.innerHTML = inventory.map(item => `
            <div class="gift-select-card" onclick="setBetGift(${item.instance_id}, '${item.title.replace(/'/g, "\\'")}', ${item.price}, this)">
                <div class="gift-avatar"><img src="${getGiftImg(item.model)}" alt=""></div>
                <div class="gift-title">${item.title}</div>
                <div class="gift-cost">${item.price} TON</div>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = '<div class="empty-state">Ошибка</div>';
    }
}

window.setBetGift = function (instanceId, title, price, el) {
    document.querySelectorAll('.gift-select-card').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');

    selectedGiftForBet = { instanceId, title, price };
    const betInput = document.getElementById('bet-amount');
    if (betInput) {
        betInput.value = price;
        betInput.disabled = true;
        betInput.style.color = 'var(--gold)';
    }
    toast(`Выбран: ${title}`, 'success');
};

function getGiftImg(model) {
    if (!model) return 'https://i.imgur.com/8YvYyZp.png';
    if (model.startsWith('http')) return model;
    return `models/${model}/photo.png`;
}

function getGiftLink(id) {
    // If ID is missing or looks like a placeholder, link to general collection
    if (!id || id === 'undefined') return 'https://t.me/nft/gift';
    // If ID is numeric, it might need a slug prefix, but for now we fallback/direct
    return `https://t.me/nft/gift/${id}`;
}

// --- SHOP TAB LOGIC ---
function switchShopTab(tab) {
    document.querySelectorAll('.shop-tab-btn').forEach(b => b.classList.remove('active'));
    if (event) event.target.classList.add('active');

    if (tab === 'official') {
        document.getElementById('shop-official-section').classList.remove('hidden');
        document.getElementById('shop-marketplace-section').classList.add('hidden');
    } else {
        document.getElementById('shop-official-section').classList.add('hidden');
        document.getElementById('shop-marketplace-section').classList.remove('hidden');
        loadMarketplace();
    }
}

async function loadMarketplace() {
    const list = document.getElementById('marketplace-list');
    if (!list) return;
    list.innerHTML = '<div class="empty-state">Загрузка товаров...</div>';

    try {
        const { listings } = await api('/api/marketplace/items');
        if (!listings || listings.length === 0) {
            list.innerHTML = '<div class="premium-empty"><div class="empty-glow"></div><div class="empty-icon-wrap"><svg viewBox="0 0 24 24"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-14L4 7m8 4v10M4 7v10l8 4"/></svg></div><p>Товары не найдены</p></div>';
            return;
        }

        list.innerHTML = listings.map(item => `
            <div class="shop-item glass-card">
                <a href="${getGiftLink(item.gift_id)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
                <div class="marketplace-badge">PLAYER</div>
                <div class="shop-item-icon"><img src="${getGiftImg(item.model)}" alt=""></div>
                <div class="shop-item-info">
                    <div class="shop-item-title">${item.title}</div>
                    <div class="shop-item-price">${item.price.toFixed(2)} TON</div>
                    <div class="shop-item-seller" style="font-size: 8px; opacity: 0.5;">@${item.seller_name || 'Anonymous'}</div>
                </div>
                <button class="buy-btn" onclick="buyFromMarket(${item.id})" style="margin-top: 5px;">КУПИТЬ</button>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = `<div class="empty-state" style="color:var(--red)">Ошибка: ${e.message}</div>`;
    }
}

async function buyFromMarket(listingId) {
    try {
        const res = await api('/api/marketplace/buy', 'POST', { listingId });
        toast('Подарок куплен!', 'success');
        setBalance(res.newBalance, true);
        loadMarketplace();
    } catch (e) { toast(e.message, 'error'); }
}

// --- INVENTORY LOGIC ---
async function openInventory() {
    const list = document.getElementById('inventory-list');
    if (!list) return;
    list.innerHTML = '<p class="empty-state">Загрузка предметов...</p>';
    document.getElementById('inventory-modal').classList.remove('hidden');

    try {
        const { inventory, listings } = await api('/api/inventory/combined');

        if (inventory.length === 0 && listings.length === 0) {
            list.innerHTML = `
                <div class="premium-empty" style="grid-column: 1/-1; padding: 40px 0;">
                    <div class="empty-glow"></div>
                    <div class="empty-icon-wrap" style="margin: 0 auto 15px;">
                        <svg viewBox="0 0 24 24"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-14L4 7m8 4v10M4 7v10l8 4"/></svg>
                    </div>
                    <p style="text-align: center;">У вас пока нет подарков</p>
                </div>
            `;
            return;
        }

        let html = '';

        // Items in inventory
        html += inventory.map(item => `
            <div class="shop-item glass-card">
                <a href="${getGiftLink(item.gift_id)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
                <div class="shop-item-icon"><img src="${getGiftImg(item.model)}" alt=""></div>
                <div class="shop-item-info">
                    <div class="shop-item-title">${item.title}</div>
                </div>
                <button class="buy-btn" onclick="openListSale(${item.instance_id})">ПРОДАТЬ</button>
            </div>
        `).join('');

        // Items already listed
        html += listings.map(item => `
            <div class="shop-item glass-card listing-active">
                <a href="${getGiftLink(item.gift_id)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
                <div class="marketplace-badge" style="background:var(--red)">LISTED</div>
                <div class="shop-item-icon" style="opacity: 0.5;"><img src="${getGiftImg(item.model)}" alt=""></div>
                <div class="shop-item-info">
                    <div class="shop-item-title">${item.title}</div>
                    <div class="shop-item-price" style="font-size: 10px;">На продаже: ${item.price} TON</div>
                </div>
                <button class="buy-btn danger" onclick="cancelListing(${item.id})" style="background:rgba(255,59,48,0.2); border-color:var(--red); color:var(--red)">СНЯТЬ</button>
            </div>
        `).join('');

        list.innerHTML = html;
    } catch (e) {
        list.innerHTML = `<p class="empty-state" style="color:var(--red)">Ошибка: ${e.message}</p>`;
    }
}

async function cancelListing(listingId) {
    if (!confirm('Вы уверены, что хотите снять предмет с продажи?')) return;
    try {
        await api('/api/marketplace/cancel', 'POST', { listingId });
        toast('Предмет снят с продажи', 'success');
        openInventory(); // Refresh
        if (activeTab === 'shop') loadMarketplace(); // Also refresh markteplace if on that tab
    } catch (e) { toast(e.message, 'error'); }
}

function openListSale(instanceId) {
    document.getElementById('sale-instance-id').value = instanceId;
    document.getElementById('list-sale-modal').classList.remove('hidden');
}

async function confirmListSale() {
    const instanceId = document.getElementById('sale-instance-id').value;
    const price = document.getElementById('sale-price').value;

    try {
        await api('/api/marketplace/list', 'POST', { instanceId, price });
        toast('Товар выставлен на продажу!', 'success');
        closeModal('list-sale-modal');
        closeModal('inventory-modal');
    } catch (e) { toast(e.message, 'error'); }
}

function getGiftEmoji(model) {
    if (model?.includes('perfume')) return '🧪';
    if (model?.includes('ring')) return '💍';
    if (model?.includes('cake')) return '🎂';
    return '🎁';
}

// Auto Cashout Persist
document.getElementById('crash-auto-cashout')?.addEventListener('change', async (e) => {
    const val = parseFloat(e.target.value) || 0;
    try {
        await api('/api/user/auto-cashout', 'POST', { multiplier: val });
        toast('Авто-вывод сохранен', 'success');
    } catch (e) { }
});

function showResult(res) {
    const ov = document.getElementById('result-overlay');
    const title = document.getElementById('result-title');
    const amt = document.getElementById('result-amount');
    const diceDisp = document.getElementById('result-dice-display');

    ov.classList.remove('hidden');
    title.textContent = res.won ? 'ПОБЕДА' : 'ПРОИГРЫШ';
    title.className = 'result-title ' + (res.won ? 'win' : 'loss');

    if (res.won) {
        amt.textContent = '+' + res.payout.toFixed(2) + ' TON';
    } else {
        amt.textContent = '-' + res.betAmount.toFixed(2) + ' TON';
    }
    amt.className = 'result-amount ' + (res.won ? 'win' : 'loss');

    diceDisp.innerHTML = res.dice.map(v => `<div class="result-die-box">${v}</div>`).join('');

    if (window.haptic && hapticEnabled) {
        if (res.won) haptic.notificationOccurred('success');
        else haptic.notificationOccurred('error');
    }

    document.getElementById('result-close').onclick = () => ov.classList.add('hidden');
}

async function loadGifts() {
    try {
        const res = await api('/api/gifts');
        const list = document.getElementById('shop-list');
        list.innerHTML = '';

        if (!res.gifts || res.gifts.length === 0) {
            list.innerHTML = '<div class="premium-empty"><p>Магазин пуст</p></div>';
            return;
        }

        res.gifts.forEach(g => {
            const card = document.createElement('div');
            card.className = 'gift-card';
            card.innerHTML = `
                <a href="${getGiftLink(g.id)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
                <div class="gift-img-wrap">
                    <img src="${getGiftImg(g.model)}" class="gift-img">
                </div>
                <div class="gift-info">
                    <div class="gift-name">${g.title}</div>
                    <div class="gift-price">${g.price} TON</div>
                    <button class="gift-buy-btn" data-id="${g.id}">Купить</button>
                </div>
            `;
            card.querySelector('.gift-buy-btn').onclick = () => window.openBuyModal(g.id, g.title, g.price);
            list.appendChild(card);
        });
    } catch (e) { }
}
window.loadGifts = loadGifts;

function getGiftLink(id) {
    return `https://t.me/nft/gift/${id}`; // Simplified link format as requested
}

let currentBuyId = null;
let currentBuyPrice = 0;

window.openBuyModal = function (id, name, price) {
    currentBuyId = id;
    currentBuyPrice = parseFloat(price);
    document.getElementById('modal-gift-name').textContent = name;
    document.getElementById('modal-gift-price').textContent = price;
    document.getElementById('purchase-modal').classList.remove('hidden');

    const confirmBtn = document.getElementById('modal-confirm-buy');
    confirmBtn.onclick = () => window.confirmPurchase(id);
};

async function confirmPurchase(id) {
    if (user.balance < currentBuyPrice) return toast('Недостаточно TON', 'error');

    // Проверка первого вывода (предупреждение про дилера)
    if (!localStorage.getItem('dealer_warned')) {
        document.getElementById('dealer-warning-modal').classList.remove('hidden');
        closeModal('purchase-modal');
        return;
    }

    try {
        const btn = document.getElementById('modal-confirm-buy');
        btn.disabled = true;
        btn.textContent = '...';

        const res = await api('/api/gifts/buy', 'POST', { giftId: id });
        user.balance = res.newBalance;
        setBalance(user.balance, true);
        toast('Покупка успешна!', 'success');
        closeModal('purchase-modal');
        loadGifts();
    } catch (e) {
        toast(e.message || 'Ошибка покупки', 'error');
    } finally {
        const btn = document.getElementById('modal-confirm-buy');
        btn.disabled = false;
        btn.textContent = 'Купить';
    }
}
window.confirmPurchase = confirmPurchase;

window.closeModal = function (id) {
    document.getElementById(id).classList.add('hidden');
};

async function refreshBalance() {
    try {
        const data = await api('/api/auth', 'POST');
        user.balance = data.user.balance;
        setBalance(user.balance);
    } catch (e) { }
}

window.connectWallet = async function () {
    try {
        if (tonConnectUI.connected) await tonConnectUI.disconnect();
        else await tonConnectUI.openModal();
    } catch (e) { toast('Ошибка привязки', 'error'); }
};

async function loadHistory() {
    try {
        const res = await api('/api/history');
        const list = document.getElementById('history-modal-list');
        if (!list) return;
        list.innerHTML = res.games.length ? res.games.map(g => {
            const date = new Date(g.created_at);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const amountStr = (g.payout > 0) ? `+${g.payout.toFixed(2)}` : `-${g.bet_amount.toFixed(2)}`;
            const statusLabel = (g.payout > 0) ? 'ВЫИГРЫШ' : 'ПРОИГРЫШ';
            const gameNames = { dice: 'Кубики', crash: 'Ракета', plinko: 'Плинко', hide: 'Прятки' };
            const gameTitle = gameNames[g.game_type] || g.game_type.toUpperCase();

            return `
                <div class="history-item animated-history">
                    <div class="hist-left">
                        <div class="hist-badge ${(g.payout > 0) ? 'badge-win' : 'badge-loss'}">${statusLabel}</div>
                        <div class="hist-meta">
                            <span class="hist-type">${gameTitle}</span>
                            <span class="hist-time">${timeStr}</span>
                        </div>
                    </div>
                    <div class="hist-res ${(g.payout > 0) ? 'win' : 'loss'}">${amountStr} TON</div>
                </div>
            `;
        }).join('') : '<div class="premium-empty"><p>История пуста</p></div>';
    } catch (e) { }
}

async function loadLeaderboard() {
    try {
        const res = await api('/api/leaderboard');
        const list = document.getElementById('leaderboard-list');
        list.innerHTML = res.players.map((p, i) => `
            <div class="leaderboard-item ${i < 3 ? 'top-3' : ''}">
                <div class="leaderboard-rank">${i + 1}</div>
                <div class="leaderboard-info">
                    <div class="leaderboard-name">${p.username}</div>
                    <div class="leaderboard-stats">${p.gamesPlayed} игр • ${p.gamesWon} побед</div>
                </div>
                <div class="leaderboard-balance">${p.balance.toFixed(2)} TON</div>
            </div>
        `).join('');
    } catch (e) { }
}

window.depositRequest = async function () {
    const amountEl = document.getElementById('dep-amount');
    let amountValRaw = amountEl ? amountEl.value : '';
    amountValRaw = amountValRaw.replace(',', '.');
    const amountVal = parseFloat(amountValRaw);
    const minD = window.appSettings?.minDeposit || 0.1;

    if (isNaN(amountVal) || amountVal < minD) return toast(`Мин. сумма ${minD} TON`, 'error');

    const btn = document.getElementById('dep-btn-go');
    btn.disabled = true;
    btn.textContent = 'ГЕНЕРАЦИЯ...';

    try {
        const res = await api('/api/deposit/request', 'POST', { amount: parseFloat(amountVal) });
        if (!res.address) throw new Error('Адрес не настроен.');

        const depositComment = (res.comment || '').trim();
        const address = res.address.trim();

        // Construct Direct Transfer Links 
        // 1. Universal tonkeeper link (very reliable on mobile)
        const tonkeeperLink = `https://app.tonkeeper.com/transfer/${address}?text=${encodeURIComponent(depositComment)}&amount=${BigInt(Math.round(amountVal * 1e9))}`;
        // 2. Protocol link
        const protoLink = `ton://transfer/${address}?text=${encodeURIComponent(depositComment)}&amount=${BigInt(Math.round(amountVal * 1e9))}`;

        // Show the elegant link button
        const linkBtn = document.getElementById('direct-transfer-link');
        const linkContainer = document.querySelector('.direct-link-container');
        if (linkBtn && linkContainer) {
            linkBtn.href = tonkeeperLink;
            linkContainer.classList.remove('hidden');
        }

        // Try to open protocol link first, then fallback to tonkeeper link
        setTimeout(() => { window.location.href = protoLink; }, 100);

        toast('Заявка создана! Перенаправляем в кошелек...', 'success');

        // Monitoring poller
        const checkDeposit = async () => {
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 10000));
                try {
                    const status = await api('/api/deposit/check');
                    if (status.completed && status.completed.some(d => d.comment === depositComment)) {
                        toast('Пополнение зачислено!', 'success');
                        triggerConfetti();
                        refreshBalance();
                        return;
                    }
                } catch (e) { }
            }
        };
        checkDeposit();

    } catch (e) {
        toast(`Ошибка: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'ОПЛАТИТЬ';
    }
}

window.copyToClipboard = function (id) {
    const text = document.getElementById(id).textContent;
    navigator.clipboard.writeText(text).then(() => {
        toast('Скопировано!', 'success');
    }).catch(() => {
        toast('Не удалось скопировать', 'error');
    });
};

// --- АНИМАЦИИ И ЭФФЕКТЫ ---

function triggerConfetti() {
    for (let i = 0; i < 30; i++) {
        const c = document.createElement('div');
        c.className = 'confetti';
        c.style.left = Math.random() * 100 + 'vw';
        c.style.backgroundColor = ['#ffcf40', '#0088cc', '#ffffff'][Math.floor(Math.random() * 3)];
        c.style.animationDuration = (Math.random() * 2 + 1) + 's';
        c.style.opacity = Math.random();
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 3000);
    }
}

// Перехватываем победу для конфетти (в логике showResult)
const originalShowResult = window.showResult;
window.showResult = function (res) {
    if (res.won) triggerConfetti();
    if (typeof originalShowResult === 'function') originalShowResult(res);
};

window.copyText = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const txt = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : el.textContent;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(() => toast('Скопировано!', 'success'));
    } else {
        toast('Браузер не поддерживает копирование', 'error');
    }
};

window.copyMemo = function () {
    const memo = document.getElementById('active-memo')?.textContent;
    if (memo && navigator.clipboard) {
        navigator.clipboard.writeText(memo).then(() => toast('Комментарий скопирован!', 'success'));
    }
};


// --- CRASH LOGIC ---
let crashStatus = null;
let crashPolling = null;
let crashCanvas = null;
let crashCtx = null;
let crashAnimationId = null;
let crashLastUpdate = 0;

// Consolidated game selection logic
window.selectGame = function (game) {
    const diceView = document.getElementById('game-view-dice');
    const crashView = document.getElementById('game-view-crash');
    const plinkoView = document.getElementById('game-view-plinko');
    const hideView = document.getElementById('game-view-hide');
    const bDice = document.getElementById('game-tab-dice');
    const bCrash = document.getElementById('game-tab-crash');
    const bPlinko = document.getElementById('game-tab-plinko');
    const bHide = document.getElementById('game-tab-hide');

    // Hide all views first
    [diceView, crashView, plinkoView, hideView].forEach(v => v?.classList.add('hidden'));
    [bDice, bCrash, bPlinko, bHide].forEach(b => b?.classList.remove('active'));

    currentGame = game;

    if (game === 'dice') {
        diceView?.classList.remove('hidden');
        bDice?.classList.add('active');
        stopCrashPolling();
        stopHidePolling();
    } else if (game === 'crash') {
        crashView?.classList.remove('hidden');
        bCrash?.classList.add('active');
        stopHidePolling();
        startCrashPolling();
        if (!window._crashInited) initCrashCanvas();
        else if (!crashAnimationId) renderCrash();
    } else if (game === 'plinko') {
        plinkoView?.classList.remove('hidden');
        bPlinko?.classList.add('active');
        stopCrashPolling();
        stopHidePolling();
        setTimeout(() => initPlinko(), 10);
    } else if (game === 'hide') {
        hideView?.classList.remove('hidden');
        bHide?.classList.add('active');
        stopCrashPolling();
        startHidePolling();
        setTimeout(() => initHide(), 10);
    }
}

function startCrashPolling() {
    if (crashPolling) return;
    crashPolling = setInterval(pollCrash, 500); // Faster polling for better sync
    pollCrash();
}

function stopCrashPolling() {
    clearInterval(crashPolling);
    crashPolling = null;
    cancelAnimationFrame(crashAnimationId);
}

let timeOffset = 0;

async function pollCrash() {
    try {
        const status = await api('/api/crash/status');
        if (status.serverTime) {
            timeOffset = Date.now() - status.serverTime;
        }
        crashStatus = status;
        updateCrashUI();
    } catch (e) { console.error('Crash poll failed:', e); }
}

function updateCrashUI() {
    if (!crashStatus) return;

    const multEl = document.getElementById('crash-multiplier');
    const statusEl = document.getElementById('crash-status-text');
    const waitingUI = document.getElementById('crash-waiting-ui');
    const betBtn = document.getElementById('crash-bet-btn');
    const cashoutBtn = document.getElementById('crash-cashout-btn');
    const historyBar = document.getElementById('crash-history-bar');

    if (crashStatus.phase === 'FLYING') {
        waitingUI.classList.add('hidden');
        statusEl.textContent = 'ПОЛЁТ...';
        multEl.classList.add('vibrating', 'flying');
        document.querySelector('.crash-info').classList.remove('crashed');
        document.querySelector('.crash-main').style.backdropFilter = 'none';

        // AUTO CASHOUT LOGIC
        const autoInput = document.getElementById('bet-auto-cashout');
        const autoMult = autoInput ? parseFloat(autoInput.value) : 0;
        if (autoMult > 1 && crashStatus.multiplier >= autoMult && crashStatus.myBet && !crashStatus.myBet.cashedOut) {
            crashCashout(); // Trigger local cashout which calls API
        }

        if (crashStatus.myBet && !crashStatus.myBet.cashedOut) {
            betBtn.classList.add('hidden');
            cashoutBtn.classList.remove('hidden');

            // Show real-time payout on button
            const currentPayout = (crashStatus.myBet.amount * crashStatus.multiplier).toFixed(2);
            cashoutBtn.innerHTML = `ЗАБРАТЬ <span style="display:block; font-size: 11px; opacity: 0.8;">(+${currentPayout} TON)</span>`;
        } else {
            betBtn.classList.remove('hidden');
            betBtn.disabled = true;
            betBtn.textContent = crashStatus.myBet?.cashedOut ? 'СТАВКА ЗАБРАНА' : 'РАУНД ИДЕТ';
            cashoutBtn.classList.add('hidden');
        }
    } else if (crashStatus.phase === 'WAITING') {
        waitingUI.classList.remove('hidden');
        statusEl.textContent = 'ОЖИДАНИЕ...';
        multEl.textContent = '1.00x';
        multEl.classList.remove('vibrating', 'flying');
        document.querySelector('.crash-info').classList.remove('crashed');
        document.querySelector('.crash-main').style.backdropFilter = 'none';

        const totalWait = 10000;
        const remaining = crashStatus.timeLeft;
        const progress = (1 - (remaining / totalWait)) * 100;
        document.getElementById('timer-progress-bar').style.width = Math.min(100, progress) + '%';
        document.getElementById('timer-seconds').textContent = Math.max(0, remaining / 1000).toFixed(1) + 's';

        betBtn.classList.remove('hidden');
        betBtn.disabled = !!crashStatus.myBet;
        betBtn.textContent = crashStatus.myBet ? 'СТАВКА ПРИНЯТА' : 'ПОСТАВИТЬ';
        cashoutBtn.classList.add('hidden');
    } else if (crashStatus.phase === 'CRASHED') {
        waitingUI.classList.add('hidden');
        statusEl.textContent = 'КРАШ! 💥';
        multEl.textContent = crashStatus.multiplier.toFixed(2) + 'x';
        multEl.classList.remove('vibrating', 'flying');
        document.querySelector('.crash-info').classList.add('crashed');
    }

    if (historyBar) {
        historyBar.innerHTML = crashStatus.history.map(h => `
                <div class="crash-history-item ${h >= 2 ? 'win' : 'loss'}">${h.toFixed(2)}x</div>
            `).join('');
    }
}

function initCrashCanvas() {
    if (window._crashInited) return;
    window._crashInited = true;

    crashCanvas = document.getElementById('crash-canvas');
    if (!crashCanvas) return;
    crashCtx = crashCanvas.getContext('2d');

    const resize = () => {
        if (currentGame !== 'crash') return;
        const dpr = window.devicePixelRatio || 1;
        crashCanvas.width = crashCanvas.clientWidth * dpr;
        crashCanvas.height = crashCanvas.clientHeight * dpr;
        // Transform is reset on width/height change
        crashCtx.scale(dpr, dpr);
    };

    window.removeEventListener('resize', resize); // Small safety
    window.addEventListener('resize', resize);
    resize();
    renderCrash();
}

const stars = [];
function initStars() {
    stars.length = 0;
    const w = crashCanvas ? crashCanvas.clientWidth : window.innerWidth;
    const h = crashCanvas ? crashCanvas.clientHeight : 400;
    // Even fewer stars (8) for a natural, deep-space look
    for (let i = 0; i < 8; i++) {
        stars.push({
            x: Math.random() * w,
            y: Math.random() * h,
            s: 0.4 + Math.random() * 1.2,
            o: 0.3 + Math.random() * 0.5
        });
    }
}
initStars();

function renderCrash() {
    if (currentGame !== 'crash') {
        crashAnimationId = null; // Mark as stopped
        return;
    }
    if (!crashCanvas || !crashCtx) {
        crashAnimationId = requestAnimationFrame(renderCrash);
        return;
    }

    const w = crashCanvas.width / (window.devicePixelRatio || 1);
    const h = crashCanvas.height / (window.devicePixelRatio || 1);

    crashCtx.clearRect(0, 0, w, h);

    const now = Date.now() - timeOffset;
    let t = (now - (crashStatus?.startTime || 0)) / 1000;
    const isPlaying = crashStatus && crashStatus.phase === 'FLYING';
    const isCrashed = crashStatus && crashStatus.phase === 'CRASHED';

    if (isCrashed) {
        t = Math.log(crashStatus.multiplier || 1) / Math.log(1.07);
    }
    if (t < 0) t = 0;

    const currentMult = isPlaying ? Math.pow(1.07, t) : (isCrashed ? (crashStatus.multiplier || 1) : 1);

    // 1. STARFIELD (Optimization: reduce count for mobile speed)
    const speedFactor = isPlaying ? (0.2 + Math.log(currentMult) * 0.5) : (isCrashed ? 0 : 0.05);

    stars.forEach(s => {
        const move = s.s * speedFactor * 15;
        s.y += move;
        if (s.y > h) { s.y = 0; s.x = Math.random() * w; }

        crashCtx.globalAlpha = s.o;
        crashCtx.fillStyle = '#fff';
        crashCtx.beginPath();
        crashCtx.arc(s.x, s.y, s.s, 0, Math.PI * 2);
        crashCtx.fill();
    });
    crashCtx.globalAlpha = 1;

    // ROCKET
    if (isPlaying || isCrashed || (crashStatus && crashStatus.phase === 'WAITING')) {
        const timeFactor = (isPlaying || isCrashed) ? t : (Date.now() / 1000);

        if (isPlaying) {
            const multEl = document.getElementById('crash-multiplier');
            if (multEl) multEl.textContent = currentMult.toFixed(2) + 'x';
        }

        const s = Math.min(1.2, Math.max(0.7, h / 500));
        const rx = w / 2;
        // Cap vertical movement to avoid "infinite" feel
        const ry = h * 0.65 - Math.min(h * 0.3, Math.pow(currentMult - 1, 0.7) * 15);

        crashCtx.save();
        crashCtx.translate(rx, ry);
        crashCtx.scale(s, s);

        // Dynamic Flame (High Quality)
        if (isPlaying || (isCrashed && t > 0)) {
            const fireLen = (40 + Math.random() * 30);
            const fireW = 16 + Math.random() * 4;

            // Core white heat
            const coreGrad = crashCtx.createRadialGradient(0, 25, 0, 0, 25, fireLen * 0.4);
            coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
            coreGrad.addColorStop(1, 'rgba(255, 255, 0, 0)');
            crashCtx.fillStyle = coreGrad;
            crashCtx.beginPath();
            crashCtx.ellipse(0, 25, 6, fireLen * 0.3, 0, 0, Math.PI * 2);
            crashCtx.fill();

            // Outer flame
            const fireGrad = crashCtx.createLinearGradient(0, 20, 0, 20 + fireLen);
            fireGrad.addColorStop(0, '#f1c40f'); // Yellow
            fireGrad.addColorStop(0.4, '#e67e22'); // Orange
            fireGrad.addColorStop(0.8, '#c0392b'); // Red
            fireGrad.addColorStop(1, 'transparent');

            crashCtx.fillStyle = fireGrad;
            crashCtx.beginPath();
            crashCtx.moveTo(-fireW / 2, 22);
            crashCtx.quadraticCurveTo(-fireW / 4, 22 + fireLen * 0.5, 0, 22 + fireLen);
            crashCtx.quadraticCurveTo(fireW / 4, 22 + fireLen * 0.5, fireW / 2, 22);
            crashCtx.fill();
        }

        // --- PREMIUM ROCKET BODY ---

        // 1. Shadows for depth (fins)
        crashCtx.fillStyle = 'rgba(0,0,0,0.3)';
        // Left Fin Shadow
        crashCtx.beginPath(); crashCtx.moveTo(-16, 12); crashCtx.lineTo(-32, 32); crashCtx.lineTo(-16, 26); crashCtx.fill();
        // Right Fin Shadow
        crashCtx.beginPath(); crashCtx.moveTo(16, 12); crashCtx.lineTo(32, 32); crashCtx.lineTo(16, 26); crashCtx.fill();

        // 2. Fins (Aerodynamic)
        const finGrad = crashCtx.createLinearGradient(-30, 0, 30, 0);
        finGrad.addColorStop(0, '#c0392b'); // Dark Red
        finGrad.addColorStop(0.5, '#e74c3c'); // Bright Red
        finGrad.addColorStop(1, '#c0392b');
        crashCtx.fillStyle = finGrad;

        // Left Fin
        crashCtx.beginPath();
        crashCtx.moveTo(-12, 5);
        crashCtx.quadraticCurveTo(-35, 25, -35, 35);
        crashCtx.lineTo(-12, 25);
        crashCtx.fill();

        // Right Fin
        crashCtx.beginPath();
        crashCtx.moveTo(12, 5);
        crashCtx.quadraticCurveTo(35, 25, 35, 35);
        crashCtx.lineTo(12, 25);
        crashCtx.fill();

        // Center Tail Fin
        crashCtx.beginPath();
        crashCtx.moveTo(0, 10);
        crashCtx.lineTo(-4, 28);
        crashCtx.lineTo(4, 28);
        crashCtx.fill();

        // 3. Main Hull (Metallic Capsule)
        const bodyGrad = crashCtx.createLinearGradient(-15, 0, 15, 0);
        bodyGrad.addColorStop(0, '#95a5a6');   // Dark Grey
        bodyGrad.addColorStop(0.2, '#ecf0f1'); // White Highlight
        bodyGrad.addColorStop(0.5, '#ffffff'); // Pure White Center
        bodyGrad.addColorStop(0.8, '#bdc3c7'); // Grey
        bodyGrad.addColorStop(1, '#7f8c8d');   // Darker Shadow

        crashCtx.fillStyle = bodyGrad;
        crashCtx.beginPath();
        // Sleek teardrop-ish capsule
        crashCtx.moveTo(-14, 20);
        crashCtx.quadraticCurveTo(-15, -10, 0, -45); // Nose cone curve left
        crashCtx.quadraticCurveTo(15, -10, 14, 20);  // Nose cone curve right
        crashCtx.quadraticCurveTo(0, 24, -14, 20);   // Bottom curve
        crashCtx.fill();

        // 4. Cockpit / Window (Glass effect)
        const winGrad = crashCtx.createLinearGradient(-5, -20, 10, -5);
        winGrad.addColorStop(0, '#3498db'); // Blue
        winGrad.addColorStop(1, '#2980b9'); // Darker Blue
        crashCtx.fillStyle = winGrad;
        crashCtx.beginPath();
        crashCtx.arc(0, -12, 8, 0, Math.PI * 2);
        crashCtx.fill();

        // Glare/Reflection
        crashCtx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        crashCtx.beginPath();
        crashCtx.ellipse(-3, -15, 3, 2, Math.PI / 4, 0, Math.PI * 2);
        crashCtx.fill();

        // Window Rim
        crashCtx.strokeStyle = '#ecf0f1';
        crashCtx.lineWidth = 1.5;
        crashCtx.stroke();

        // 5. Red Nose Tip (Stylistic)
        crashCtx.fillStyle = '#e74c3c';
        crashCtx.beginPath();
        crashCtx.moveTo(-5, -34);
        crashCtx.quadraticCurveTo(0, -45, 5, -34);
        crashCtx.quadraticCurveTo(0, -32, -5, -34);
        crashCtx.fill();

        crashCtx.restore();

        if (isPlaying && window.haptic && hapticEnabled && Math.random() > 0.98) {
            haptic.impactOccurred('light');
        }
    }

    const mainWrap = document.querySelector('.crash-main');
    if (mainWrap) {
        if (isCrashed) {
            mainWrap.style.backdropFilter = 'blur(10px) brightness(0.7)';
        } else {
            mainWrap.style.backdropFilter = 'none';
        }
    }

    crashAnimationId = requestAnimationFrame(renderCrash);
}

window.crashPlaceBet = async function () {
    const payload = {};
    if (betMode === 'gift') {
        if (!selectedGift) return toast('Выберите подарок', 'error');
        payload.giftInstanceId = selectedGift.instance_id;
    } else {
        const amt = parseFloat(document.getElementById('bet-amount').value);
        if (isNaN(amt) || amt < 0.1) return toast('Минимум 0.1 TON', 'error');
        if (amt > user.balance) return toast('Недостаточно баланса', 'error');
        payload.betAmount = amt;
    }

    const auto = parseFloat(document.getElementById('bet-auto-cashout').value);
    if (!isNaN(auto) && auto > 1.1) payload.autoCashout = auto;

    closeModal('bet-modal');

    try {
        const res = await api('/api/crash/bet', 'POST', payload);
        if (res.newBalance !== undefined) setBalance(res.newBalance);
        toast('Ставка принята!', 'success');
        if (window.haptic && hapticEnabled) haptic.impactOccurred('medium');
        pollCrash();
        if (betMode === 'gift') selectedGift = null;
    } catch (e) { toast(e.message, 'error'); }
};

window.crashCashout = async function () {
    try {
        const res = await api('/api/crash/cashout', 'POST');
        setBalance(res.newBalance);
        triggerConfetti();
        toast(`Вы забрали ${res.payout.toFixed(2)} TON! (${res.multiplier}x)`, 'success');
        if (window.haptic && hapticEnabled) haptic.notificationOccurred('success');
        pollCrash();
    } catch (e) { toast(e.message, 'error'); }
};

window.setMaxCrashBet = function () {
    document.getElementById('crash-bet-amount').value = Math.floor(user.balance);
};

document.addEventListener('DOMContentLoaded', init);
// --- PLINKO GAME LOGIC ---
const PLINKO_ROWS = 8;
const PLINKO_MULTIS = [5, 2, 1.2, 0.5, 0, 0.5, 1.2, 2, 5];

function initPlinko() {
    console.log('[Plinko] Initializing...');
    plinkoCanvas = document.getElementById('plinko-canvas');
    if (!plinkoCanvas) return console.warn('[Plinko] Canvas not found in DOM');

    plinkoCtx = plinkoCanvas.getContext('2d');
    if (!plinkoCtx) return console.error('[Plinko] Could not get 2D context');

    // Fill multipliers UI
    const multsDiv = document.getElementById('plinko-mults');
    if (multsDiv) {
        multsDiv.innerHTML = '';
        PLINKO_MULTIS.forEach(m => {
            const slot = document.createElement('div');
            slot.className = 'plinko-multiplier-slot';
            slot.dataset.mult = m;

            // Color logic
            let color = '#fff';
            let label = m + 'x';
            if (m < 0.8) { color = '#ff3333'; label = '💀'; }
            else if (m < 1.0) { color = '#ff9100'; }
            else if (m < 1.5) { color = '#76ff03'; }
            else { color = '#00e676'; }

            slot.style.borderColor = color;
            slot.style.color = color;

            slot.innerHTML = `
                <div class="mult-val">${label}</div>
                <div class="mult-payout-preview" style="font-size: 8px; opacity: 0.6; font-weight: 500;">0.00</div>
            `;
            multsDiv.appendChild(slot);
        });
        updatePlinkoPreviews();
        // Sync with bet amount input
        document.getElementById('bet-amount')?.addEventListener('input', updatePlinkoPreviews);
    }

    initPlinkoDropZone();
    if (!window._pRunning) {
        window._pRunning = true;
        console.log('[Plinko] Loop started successfully');
        requestAnimationFrame(renderPlinko);
    } else {
        console.log('[Plinko] Loop already running, skipping restart');
    }
}

window.addEventListener('resize', () => {
    if (currentGame === 'plinko') {
        plinkoCanvas.width = plinkoCanvas.offsetWidth;
        plinkoCanvas.height = plinkoCanvas.offsetHeight;
    }
});

function updatePlinkoPreviews() {
    let amt = 0;
    if (betMode === 'gift' && selectedGift) {
        amt = selectedGift.price;
    } else {
        const bInput = document.getElementById('bet-amount');
        amt = bInput ? parseFloat(bInput.value) : 0;
    }

    document.querySelectorAll('.plinko-multiplier-slot').forEach(slot => {
        const m = parseFloat(slot.dataset.mult);
        const preview = slot.querySelector('.mult-payout-preview');
        if (preview) {
            preview.textContent = (amt * m).toFixed(2);
        }
    });
}

async function plinkoDrop() {
    const payload = {};
    if (betMode === 'gift') {
        if (!selectedGift) return toast('Выберите подарок', 'error');
        payload.giftInstanceId = selectedGift.instance_id;
    } else {
        const amt = parseFloat(document.getElementById('bet-amount').value);
        if (isNaN(amt) || amt < 0.1) return toast('Минимум 0.1 TON', 'error');
        if (amt > user.balance) return toast('Недостаточно баланса', 'error');
        payload.betAmount = amt;
    }

    try {
        const dropX = window.plinkoDropX || 0.5;
        const res = await api('/api/plinko/bet', 'POST', { x: dropX, ...payload });

        plinkoBalls = plinkoBalls.filter(b => !b.landed);

        const ball = {
            x: (plinkoCanvas.width * dropX),
            y: 20,
            vx: (Math.random() - 0.5) * 0.3,
            vy: 0.3,
            radius: 10,
            path: res.result.path,
            step: 0,
            targetSlot: res.result.slot,
            payout: res.result.payout,
            multiplier: res.result.multiplier,
            color: '#ffffff',
            dieValue: Math.floor(Math.random() * 6) + 1,
            bounceCount: 0,
            landed: false,
            newBalance: res.result.newBalance
        };
        plinkoBalls.push(ball);
        if (betMode === 'gift') selectedGift = null;
    } catch (e) {
        toast(e.message, 'error');
    }
}

function initPlinkoDropZone() {
    const zone = document.getElementById('plinko-drop-zone');
    if (!zone) return;

    const handleMove = (e) => {
        const rect = zone.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        let x = (clientX - rect.left) / rect.width;
        x = Math.max(0.1, Math.min(0.9, x));
        window.plinkoDropX = x;
    };

    zone.addEventListener('mousemove', handleMove);
    zone.addEventListener('touchstart', handleMove);
    zone.addEventListener('touchmove', handleMove);
}

function renderPlinko() {
    if (!plinkoCanvas || !plinkoCtx) {
        plinkoCanvas = document.getElementById('plinko-canvas');
        if (plinkoCanvas) plinkoCtx = plinkoCanvas.getContext('2d');
        return requestAnimationFrame(renderPlinko);
    }

    if (activeTab !== 'game' || currentGame !== 'plinko') {
        return requestAnimationFrame(renderPlinko);
    }

    const curW = plinkoCanvas.offsetWidth;
    const curH = plinkoCanvas.offsetHeight;

    if (curW > 10 && curH > 10) {
        if (plinkoCanvas.width !== curW) plinkoCanvas.width = curW;
        if (plinkoCanvas.height !== curH) plinkoCanvas.height = curH;

        const w = plinkoCanvas.width;
        const h = plinkoCanvas.height;
        plinkoCtx.clearRect(0, 0, w, h);

        const rowGap = (h - 60) / (PLINKO_ROWS + 1);
        const colGap = w / (PLINKO_ROWS + 2);

        // Draw drop indicator
        if (window.plinkoDropX) {
            plinkoCtx.fillStyle = 'rgba(255,255,255,0.1)';
            plinkoCtx.fillRect(w * window.plinkoDropX - 10, 5, 20, 10);
            plinkoCtx.strokeStyle = 'rgba(255,255,255,0.2)';
            plinkoCtx.strokeRect(w * window.plinkoDropX - 10, 5, 20, 10);
        }

        // Draw Pegs
        plinkoCtx.fillStyle = 'rgba(255,255,255,0.2)';
        for (let r = 1; r <= PLINKO_ROWS; r++) {
            const rowY = 40 + r * rowGap;
            const rowCols = r + 1;
            const startX = (w - (rowCols - 1) * colGap) / 2;
            for (let c = 0; c < rowCols; c++) {
                plinkoCtx.beginPath();
                plinkoCtx.arc(startX + c * colGap, rowY, 3, 0, Math.PI * 2);
                plinkoCtx.fill();
            }
        }

        // Draw Slots Dividers
        const slotWidth = w / PLINKO_MULTIS.length;
        plinkoCtx.strokeStyle = 'rgba(255,255,255,0.1)';
        plinkoCtx.lineWidth = 2;
        for (let i = 1; i < PLINKO_MULTIS.length; i++) {
            plinkoCtx.beginPath();
            plinkoCtx.moveTo(i * slotWidth, h - 30);
            plinkoCtx.lineTo(i * slotWidth, h);
            plinkoCtx.stroke();
        }

        // Update and Draw Balls
        const gravity = 0.05;
        plinkoBalls = plinkoBalls.filter(ball => {
            if (!ball.landed) {
                ball.vy += gravity;
                ball.x += ball.vx;
                ball.y += ball.vy;

                // Wall bouncing
                if (ball.x < 15) { ball.x = 15; ball.vx *= -0.6; }
                else if (ball.x > w - 15) { ball.x = w - 15; ball.vx *= -0.6; }

                const currentRow = Math.floor((ball.y - 40) / rowGap);
                if (currentRow > ball.step && ball.step < PLINKO_ROWS) {
                    const move = ball.path[ball.step];
                    // STRICTLY follow the path with minimal physics noise
                    const direction = (move === 1 ? 0.5 : -0.5); // 0.5 unit right or left

                    // We need to nudge velocity towards the target column center
                    const currentMapX = (ball.step + 1) * colGap; // Rough center

                    ball.vx = direction * (colGap * 0.15); // Consistent push
                    ball.vy = 2.0; // Reset vertical speed slightly on impact
                    ball.step++;
                }

                if (ball.step >= PLINKO_ROWS) {
                    // Final descent: guide to exact slot center
                    const targetX = (ball.targetSlot + 0.5) * slotWidth;
                    const diff = targetX - ball.x;
                    ball.vx += diff * 0.1; // Stronger guidance at very end
                }

                if (ball.y >= h - 18) {
                    ball.landed = true;
                    ball.y = h - 20;
                    ball.vx = 0; ball.vy = 0;
                    // Snap x to target slot so it visually lands in correct hole (no teleport during fall)
                    ball.x = (ball.targetSlot + 0.5) * slotWidth;
                    highlightSlot(ball.targetSlot);
                    if (ball.payout > 0) { toast(`Победа! ${ball.payout.toFixed(2)} TON`, 'success'); triggerConfetti(); }
                    if (ball.newBalance !== undefined) setBalance(ball.newBalance, true);
                    if (window.haptic && hapticEnabled) haptic.notificationOccurred('success');
                }
            }

            // Draw dice
            plinkoCtx.save();
            plinkoCtx.translate(ball.x, ball.y);
            plinkoCtx.rotate(ball.y / 15);
            const size = 16, r = 4;
            plinkoCtx.fillStyle = '#fff';
            plinkoCtx.shadowBlur = ball.landed ? 20 : 15;
            plinkoCtx.shadowColor = ball.landed ? 'rgba(255, 215, 0, 0.6)' : 'rgba(255,255,255,0.5)';
            plinkoCtx.beginPath();
            plinkoCtx.roundRect(-size / 2, -size / 2, size, size, r);
            plinkoCtx.fill();

            plinkoCtx.fillStyle = '#000';
            const p = size / 4, dotSize = 2;
            const drawDot = (dx, dy) => { plinkoCtx.beginPath(); plinkoCtx.arc(dx, dy, dotSize, 0, Math.PI * 2); plinkoCtx.fill(); };
            const dots = {
                1: [[0, 0]],
                2: [[-p, -p], [p, p]],
                3: [[-p, -p], [0, 0], [p, p]],
                4: [[-p, -p], [p, -p], [-p, p], [p, p]],
                5: [[-p, -p], [p, -p], [0, 0], [-p, p], [p, p]],
                6: [[-p, -p], [p, -p], [-p, 0], [p, 0], [-p, p], [p, p]]
            };
            (dots[ball.dieValue] || []).forEach(d => drawDot(d[0], d[1]));
            plinkoCtx.restore();
            return true;
        });
    }
    requestAnimationFrame(renderPlinko);
}

function highlightSlot(idx) {
    const slots = document.querySelectorAll('.plinko-multiplier-slot');
    if (slots[idx]) {
        slots[idx].classList.add('win');
        setTimeout(() => slots[idx].classList.remove('win'), 1500);
    }
}
// --- DAILY SPIN LOGIC ---
let isSpinning = false;
function openDailySpin() {
    document.getElementById('daily-spin-modal').classList.remove('hidden');
}

async function startDailySpin() {
    if (isSpinning) return;

    try {
        const res = await api('/api/daily-spin', 'POST');
        isSpinning = true;
        const btn = document.getElementById('spin-start-btn');
        btn.disabled = true;
        btn.textContent = 'КРУТИМ...';

        const wheel = document.getElementById('wheel');
        // Random rotations + target angle
        const extraDegrees = (res.win ? 360 * 7 + 77 : 360 * 5 + Math.random() * 360);
        wheel.style.transform = `rotate(${extraDegrees}deg)`;

        setTimeout(() => {
            isSpinning = false;
            btn.disabled = false;
            btn.textContent = 'КРУТИТЬ';

            if (res.win) {
                toast(`ПОЗДРАВЛЯЕМ! Вы выиграли ${res.prize} TON!`, 'success');
                setBalance(res.newBalance, true);
            } else {
                toast('В этот раз не повезло. Попробуйте завтра!', 'info');
            }

            // Reset wheel after delay
            setTimeout(() => {
                wheel.style.transition = 'none';
                wheel.style.transform = 'rotate(0deg)';
                void wheel.offsetWidth;
                wheel.style.transition = 'transform 4s cubic-bezier(0.15, 0, 0.15, 1)';
            }, 2000);
        }, 4500);

    } catch (e) {
        toast(e.message, 'error');
    }
}

async function redeemPromo() {
    const input = document.getElementById('promo-code-input');
    const code = input.value.trim();
    if (!code) return toast('Введите промокод', 'error');

    try {
        const res = await api('/api/promocodes/redeem', 'POST', { code });
        toast(res.message, 'success');
        setBalance(res.newBalance, true);
        input.value = '';
    } catch (e) {
        toast(e.message, 'error');
    }
}

function initWheelLabels() {
    const wrap = document.getElementById('wheel-labels');
    if (!wrap) return;
    wrap.innerHTML = '';
    const prizes = ['0.01', '💀', '0.05', '💀', '0.1', '💀', '0.5', '💀', '1.0', '💀', '10.0', '💀'];
    prizes.forEach((p, i) => {
        const lbl = document.createElement('div');
        lbl.className = 'wheel-segment-label';
        // Precise center of each 30-degree segment
        lbl.style.transform = `rotate(${i * 30 + 15}deg)`;
        // Simple span without fighting double-rotations
        lbl.innerHTML = `<span>${p}</span>`;
        wrap.appendChild(lbl);
    });
}

function bytesToBase64(u8) {
    let binary = '';
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
    return typeof btoa !== 'undefined' ? btoa(binary) : '';
}

async function tonDeposit() {
    if (!tonConnectUI || !tonConnectUI.connected) {
        toast('Сначала подключите кошелек!', 'error');
        if (tonConnectUI) tonConnectUI.openModal();
        return;
    }

    const amt = parseFloat(document.getElementById('dep-amount').value) || 0;
    const btn = document.getElementById('start-deposit-btn');
    if (btn.disabled) return;
    btn.disabled = true;

    try {
        const req = await api('/api/deposit/request', 'POST', { amount: amt });
        const commentBytes = new TextEncoder().encode(req.comment);
        const payloadBytes = new Uint8Array(4 + commentBytes.length);
        payloadBytes[0] = 0; payloadBytes[1] = 0; payloadBytes[2] = 0; payloadBytes[3] = 0;
        payloadBytes.set(commentBytes, 4);
        const payloadB64 = bytesToBase64(payloadBytes);

        const tx = {
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: [{
                address: req.address,
                amount: (amt * 1e9).toString(),
                payload: payloadB64
            }]
        };

        await tonConnectUI.sendTransaction(tx);
        toast('Запрос отправлен! Ожидайте зачисления.', 'success');
    } catch (e) {
        toast(e.message || 'Ошибка оплаты', 'error');
    } finally {
        btn.disabled = false;
    }
}

// Final helper for gift icons
function getGiftEmoji(model) {
    if (!model) return '🎁';
    const m = model.toLowerCase();
    if (m.includes('star')) return '⭐';
    if (m.includes('heart')) return '❤️';
    if (m.includes('fire')) return '🔥';
    if (m.includes('crystal') || m.includes('diamond')) return '💎';
    if (m.includes('crown')) return '👑';
    if (m.includes('bag') || m.includes('money')) return '💰';
    if (m.includes('dice')) return '🎲';
    if (m.includes('rocket')) return '🚀';
    return '🎁';
}

// Stats listener to user Avatar
document.querySelector('.header-left').onclick = openStats;

// Consolidated Gift Betting Logic
let betMode = 'ton';
let selectedGift = null;
let activeBetGame = null;

window.setBetMode = function (mode) {
    betMode = mode;
    const btnTon = document.getElementById('bet-tab-ton');
    const btnGift = document.getElementById('bet-tab-gift');
    const areaTon = document.getElementById('bet-ton-area');
    const areaGift = document.getElementById('bet-gift-area');

    if (mode === 'ton') {
        btnTon?.classList.add('active');
        btnGift?.classList.remove('active');
        areaTon?.classList.remove('hidden');
        areaGift?.classList.add('hidden');
    } else {
        btnTon?.classList.remove('active');
        btnGift?.classList.add('active');
        areaTon?.classList.add('hidden');
        areaGift?.classList.remove('hidden');
        loadGiftsForBet();
    }
};

async function loadGiftsForBet() {
    const list = document.getElementById('gift-selection-list');
    if (!list) return;
    list.innerHTML = '<div class="premium-empty"><p>Загрузка...</p></div>';
    try {
        const { inventory } = await api('/api/inventory/combined');
        if (inventory.length === 0) {
            list.innerHTML = '<div class="premium-empty"><p>Нет подарков</p></div>';
            return;
        }
        list.innerHTML = inventory.map(item => `
            <div class="gift-select-card ${selectedGift?.instance_id === item.instance_id ? 'active' : ''}" onclick="selectGiftForBet(${JSON.stringify(item).replace(/"/g, '&quot;')})">
                <div class="gift-avatar"><img src="${getGiftImg(item.model)}" alt=""></div>
                <div class="gift-title">${item.title}</div>
                <div class="gift-cost">${item.price} TON</div>
            </div>`).join('');
    } catch (e) { list.innerHTML = '<p>Ошибка</p>'; }
}

window.selectGiftForBet = function (item) {
    selectedGift = item;
    if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
    loadGiftsForBet();
};

window.openBetModal = function (game) {
    activeBetGame = game;
    const modal = document.getElementById('bet-modal');
    if (!modal) return;

    modal.classList.remove('hidden');

    // Config modal for game
    document.getElementById('dice-options-area').classList.toggle('hidden', game !== 'dice');
    document.getElementById('crash-auto-cashout-area').classList.toggle('hidden', game !== 'crash');

    const title = { dice: 'Dice', crash: 'Rocket', plinko: 'Plinko', hide: 'Прятки' }[game] || 'Ставка';
    document.getElementById('bet-modal-title').textContent = title;

    // RESTORED CONFIRM LOGIC
    const confirmBtn = document.getElementById('bet-confirm-btn');
    confirmBtn.onclick = () => {
        if (activeBetGame === 'dice') {
            console.log('Confirm clicked for DICE');
            closeModal('bet-modal');
            roll();
        } else if (activeBetGame === 'crash') {
            closeModal('bet-modal');
            crashPlaceBet();
        } else if (activeBetGame === 'plinko') {
            closeModal('bet-modal');
            plinkoDrop();
        } else if (activeBetGame === 'hide') {
            closeModal('bet-modal');
            placeHideBet();
        }
    };
};

// Local listener for bet types
const betBtns = document.querySelectorAll('.bet-type-btn');
betBtns.forEach(btn => {
    btn.onclick = (e) => {
        document.querySelectorAll('.bet-type-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
    };
});


// --- HIDE AND SEEK (ПРЯТКИ) ---
let hideStatus = null;
let hidePolling = null;
let hideCanvas = null;
let hideCtx = null;
let hideAnimId = null;
let lastHidePhase = null;

function startHidePolling() {
    if (hidePolling) return;
    hidePolling = setInterval(pollHide, 1000);
    pollHide();
}

function stopHidePolling() {
    clearInterval(hidePolling);
    hidePolling = null;
    cancelAnimationFrame(hideAnimId);
}

async function pollHide() {
    try {
        hideStatus = await api('/api/hide/status');
        updateHideUI();
    } catch (e) { }
}

function updateHideUI() {
    if (!hideStatus) return;
    const timer = document.getElementById('hide-timer-display');
    const phaseText = document.getElementById('hide-phase-text');
    const voteControls = document.getElementById('hide-voting-controls');
    const selectControls = document.getElementById('hide-selection-controls');

    const btn = document.getElementById('hide-place-bet-btn');
    if (btn) {
        const canBet = hideStatus.phase === 'VOTING' && !hideStatus.myBet;
        btn.disabled = !canBet;
        btn.style.opacity = canBet ? '1' : '0.5';
    }

    if (timer) timer.textContent = Math.ceil(hideStatus.timeLeft || 0);
    if (phaseText) {
        const texts = { 'VOTING': 'ГОЛОСОВАНИЕ', 'SELECTION': 'ВЫБОР ДОМА', 'SEARCHING': 'УБИЙЦА В ПУТИ...', 'RESULT': 'ФИНАЛ' };
        phaseText.textContent = texts[hideStatus.phase] || hideStatus.phase;
    }

    if (hideStatus.phase === 'VOTING') {
        voteControls?.classList.remove('hidden');
        selectControls?.classList.add('hidden');
    } else if (hideStatus.phase === 'SELECTION' || hideStatus.phase === 'SEARCHING' || hideStatus.phase === 'RESULT') {
        voteControls?.classList.add('hidden');
        selectControls?.classList.remove('hidden');

        const multLabel = document.getElementById('hide-mult-label');
        const multMap = { 4: 2.5, 8: 2.0, 12: 1.2 };
        if (multLabel) multLabel.textContent = `ВЫБЕРИТЕ ДОМ (${multMap[hideStatus.finalRoomCount] || 2.5}x Win)`;

        renderRoomsList();
    }

    // Feedback on result
    if (hideStatus.phase === 'RESULT' && lastHidePhase === 'SEARCHING') {
        const isHit = hideStatus.myRoom && hideStatus.killerTargets.includes(hideStatus.myRoom);
        if (hideStatus.myRoom) {
            if (isHit) {
                toast('ТЫ УМЕР!', 'error');
                if (window.haptic) haptic.notificationOccurred('error');
            } else {
                toast('ТЫ ВЫЖИЛ! ПОБЕДА!', 'success');
                if (window.haptic) haptic.notificationOccurred('success');
            }
        }
    }
    lastHidePhase = hideStatus.phase;
}

function renderRoomsList() {
    const cont = document.getElementById('hide-rooms-container');
    if (!cont) return;
    let h = '';
    const roomCount = hideStatus.finalRoomCount || 4;
    const targets = hideStatus.killerTargets || [];
    const activeTarget = targets[hideStatus.currentSearchingIdx];

    for (let i = 1; i <= roomCount; i++) {
        const r = hideStatus.rooms[i] || [];
        const isMy = hideStatus.myRoom == i;
        const killerInside = hideStatus.phase === 'SEARCHING' && activeTarget == i;
        const wereHit = (hideStatus.phase === 'RESULT' || hideStatus.phase === 'SEARCHING') && targets.slice(0, hideStatus.phase === 'RESULT' ? 3 : hideStatus.currentSearchingIdx + 1).includes(i);

        h += `<div class="room-node ${isMy ? 'active' : ''} ${r.length >= 3 ? 'full' : ''} ${killerInside ? 'killer-inside' : ''} ${wereHit ? 'hit' : ''}" onclick="selectHideRoom(${i})">
                <span class="room-num">${i}</span>
                <span class="room-p-count">${wereHit ? '💀' : r.length + '/3'}</span>
              </div>`;
    }
    cont.innerHTML = h;
}

window.voteHide = async (count) => {
    try {
        await api('/api/hide/vote', 'POST', { count });
        toast('Голос за ' + count + ' комнат!');
        if (window.haptic) haptic.impactOccurred('medium');
    } catch (e) { toast(e.message, 'error'); }
};

window.selectHideRoom = async (roomId) => {
    if (hideStatus?.phase !== 'SELECTION') return;
    try {
        await api('/api/hide/select', 'POST', { roomId });
        if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
    } catch (e) { toast(e.message, 'error'); }
};

window.placeHideBet = async () => {
    const amt = parseFloat(document.getElementById('bet-amount').value);
    const body = { betAmount: amt };
    if (betMode === 'gift') {
        if (!selectedGift) return toast('Выберите подарок', 'error');
        body.giftInstanceId = selectedGift.instance_id;
    }
    try {
        await api('/api/hide/bet', 'POST', body);
        toast('Вы в игре!', 'success');
        selectedGift = null;
        pollHide();
    } catch (e) { toast(e.message, 'error'); }
};

function initHide() {
    hideCanvas = document.getElementById('hide-canvas');
    if (!hideCanvas) return;
    hideCtx = hideCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = hideCanvas.getBoundingClientRect();
    hideCanvas.width = rect.width * dpr;
    hideCanvas.height = rect.height * dpr;
    hideCtx.scale(dpr, dpr);
    if (!hideAnimId) renderHide();
}

function renderHide() {
    if (!hideCtx || currentGame !== 'hide') {
        hideAnimId = null;
        return;
    }
    hideAnimId = requestAnimationFrame(renderHide);

    const dpr = window.devicePixelRatio || 1;
    const w = hideCanvas.width / dpr;
    const h = hideCanvas.height / dpr;
    hideCtx.clearRect(0, 0, w, h);

    if (!hideStatus) return;

    // Draw grid environment
    hideCtx.strokeStyle = 'rgba(255,255,255,0.02)';
    for (let x = 0; x < w; x += 40) { hideCtx.beginPath(); hideCtx.moveTo(x, 0); hideCtx.lineTo(x, h); hideCtx.stroke(); }
    for (let y = 0; y < h; y += 40) { hideCtx.beginPath(); hideCtx.moveTo(0, y); hideCtx.lineTo(w, y); hideCtx.stroke(); }

    if (hideStatus.phase === 'SEARCHING' || hideStatus.phase === 'RESULT' || hideStatus.phase === 'SELECTION') {
        const roomCount = hideStatus.finalRoomCount || 4;
        // Helper to get house position with MAX SEPARATION
        const getHousePos = (idx, total) => {
            // FORCE EXTREME CORNERS for 4 players (using percentages for responsiveness)
            if (total <= 4) {
                const xPad = w * 0.15; // 15% padding from sides
                const yPad = h * 0.15; // 15% padding from top/bottom

                // 1: Top-Left, 2: Top-Right, 3: Bottom-Left, 4: Bottom-Right
                if (idx === 1) return { x: xPad, y: yPad };
                if (idx === 2) return { x: w - xPad - 40, y: yPad };
                if (idx === 3) return { x: xPad, y: h - yPad - 40 };
                if (idx === 4) return { x: w - xPad - 40, y: h - yPad - 40 };
            }
            // Fallback grid
            const cols = 4;
            const rows = Math.ceil(total / cols);
            const canvasPad = 80;
            const gridW = w - canvasPad * 2;
            const gridH = h - canvasPad * 2;
            const cellW = gridW / cols;
            const cellH = gridH / rows;
            const ix = (idx - 1) % cols;
            const iy = Math.floor((idx - 1) / cols);
            return {
                x: canvasPad + ix * cellW + cellW / 2 - 30,
                y: canvasPad + iy * cellH + cellH / 2 - 40
            };
        };

        for (let i = 1; i <= roomCount; i++) {
            const pos = getHousePos(i, roomCount);
            const wasHit = (hideStatus.phase === 'RESULT' || hideStatus.phase === 'SEARCHING') && (hideStatus.killerTargets || []).slice(0, hideStatus.phase === 'RESULT' ? 3 : hideStatus.currentSearchingIdx + 1).includes(i);
            const isUserRoom = hideStatus.myRoom === i;
            drawHouse(pos.x, pos.y, i, isUserRoom, wasHit);
        }

        if (hideStatus.phase === 'SEARCHING') {
            // Killer moves ONLY between houses that will die (killerTargets)
            const totalDuration = 9;
            const elapsed = totalDuration - hideStatus.timeLeft;
            const targets = hideStatus.killerTargets || [];
            const pathLength = targets.length > 0 ? targets.length : roomCount;
            const progress = (elapsed / totalDuration) * pathLength;
            const currentRoomIdx = Math.min(Math.floor(progress), pathLength - 1);

            const t = progress % 1;
            const smoothT = t < 0.2 ? 0 : (t > 0.8 ? 1 : (t - 0.2) / 0.6);
            const easeT = smoothT * smoothT * (3 - 2 * smoothT);

            let p1, p2;
            if (targets.length > 0) {
                const idx1 = Math.min(currentRoomIdx, targets.length - 1);
                const idx2 = Math.min(currentRoomIdx + 1, targets.length - 1);
                p1 = getHousePos(targets[idx1], roomCount);
                p2 = idx2 > idx1 ? getHousePos(targets[idx2], roomCount) : p1;
            } else {
                const p1Idx = (currentRoomIdx % roomCount) + 1;
                const p2Idx = ((currentRoomIdx + 1) % roomCount) + 1;
                p1 = getHousePos(p1Idx, roomCount);
                p2 = getHousePos(p2Idx, roomCount);
            }

            const startX = p1.x + 30; const startY = p1.y + 60;
            const endX = p2.x + 30; const endY = p2.y + 60;

            const kX = startX + (endX - startX) * easeT;
            const kY = startY + (endY - startY) * easeT - 10;
            const isWalking = (t > 0.2 && t < 0.8);

            // Draw "THE KILLER" (CUBE FORM)
            hideCtx.save();
            hideCtx.translate(kX, kY);

            // Glow and Shadow
            hideCtx.shadowBlur = 35;
            hideCtx.shadowColor = '#e74c3c';

            // Bobbing animation for the cube
            const hover = Math.sin(Date.now() / 200) * 8;
            hideCtx.translate(0, hover);

            // Isometric Cube Draw
            const kSize = 16;

            // Top Face
            hideCtx.fillStyle = '#ff0000'; // Bright red top
            hideCtx.beginPath();
            hideCtx.moveTo(0, -kSize);
            hideCtx.lineTo(kSize, -kSize / 2);
            hideCtx.lineTo(0, 0);
            hideCtx.lineTo(-kSize, -kSize / 2);
            hideCtx.closePath(); hideCtx.fill();

            // Right Face
            hideCtx.fillStyle = '#8b0000'; // Dark red side
            hideCtx.beginPath();
            hideCtx.moveTo(0, 0);
            hideCtx.lineTo(kSize, -kSize / 2);
            hideCtx.lineTo(kSize, kSize / 2);
            hideCtx.lineTo(0, kSize);
            hideCtx.closePath(); hideCtx.fill();

            // Left Face
            hideCtx.fillStyle = '#c00000'; // Mid red side
            hideCtx.beginPath();
            hideCtx.moveTo(0, 0);
            hideCtx.lineTo(-kSize, -kSize / 2);
            hideCtx.lineTo(-kSize, kSize / 2);
            hideCtx.lineTo(0, kSize);
            hideCtx.closePath(); hideCtx.fill();

            hideCtx.restore();
        }
    }
}

function drawHouse(hx, hy, id, active, hit) {
    hideCtx.save();
    hideCtx.translate(hx, hy);

    // Geometry
    const size = 32;
    const h = 42;

    // 1. CHIMNEY
    hideCtx.fillStyle = hit ? '#441111' : '#34495e';
    hideCtx.fillRect(size * 1.5, -10, 8, 20);

    // 2. ROOF (With Shingles Effect)
    hideCtx.fillStyle = hit ? '#441111' : '#2c3e50';
    hideCtx.beginPath();
    hideCtx.moveTo(size, 0); hideCtx.lineTo(size * 2, size * 0.5); hideCtx.lineTo(size, size); hideCtx.lineTo(0, size * 0.5);
    hideCtx.closePath(); hideCtx.fill();

    // Shingles lines
    hideCtx.strokeStyle = 'rgba(255,255,255,0.05)';
    hideCtx.lineWidth = 1;
    for (let sy = 0; sy < size; sy += 4) {
        hideCtx.beginPath();
        hideCtx.moveTo(size - sy, sy * 0.5); hideCtx.lineTo(size * 2 - sy, (sy + size) * 0.5 - 15);
        hideCtx.stroke();
    }

    // 3. WALLS
    // Left Face (Main Face)
    hideCtx.fillStyle = hit ? '#330000' : '#3d546d';
    hideCtx.beginPath();
    hideCtx.moveTo(0, size * 0.5); hideCtx.lineTo(size, size); hideCtx.lineTo(size, size + h); hideCtx.lineTo(0, size * 0.5 + h);
    hideCtx.closePath(); hideCtx.fill();

    // Right Face (Shadow Face)
    hideCtx.fillStyle = hit ? '#220000' : '#243447';
    hideCtx.beginPath();
    hideCtx.moveTo(size * 2, size * 0.5); hideCtx.lineTo(size, size); hideCtx.lineTo(size, size + h); hideCtx.lineTo(size * 2, size * 0.5 + h);
    hideCtx.closePath(); hideCtx.fill();

    // 4. DOOR (On Left Face)
    hideCtx.fillStyle = '#1a1a1a';
    hideCtx.beginPath();
    hideCtx.moveTo(12, 45); hideCtx.lineTo(24, 51); hideCtx.lineTo(24, 75); hideCtx.lineTo(12, 69);
    hideCtx.closePath(); hideCtx.fill();
    // Doorknob
    hideCtx.fillStyle = '#ffcc00';
    hideCtx.beginPath(); hideCtx.arc(22, 63, 1.5, 0, Math.PI * 2); hideCtx.fill();

    // Glow Effect for Active/Hit
    if (active) {
        hideCtx.shadowBlur = 25; hideCtx.shadowColor = 'rgba(231, 76, 60, 0.4)';
        hideCtx.strokeStyle = '#e74c3c';
        hideCtx.lineWidth = 2;
        hideCtx.stroke();
    }

    // Window Lights
    hideCtx.fillStyle = active ? '#e74c3c' : (hit ? '#ff3d00' : '#f1c40f');
    hideCtx.globalAlpha = active ? (0.7 + Math.sin(Date.now() / 150) * 0.3) : 0.4;
    // Window on Right
    hideCtx.fillRect(45, 38, 8, 12);
    hideCtx.globalAlpha = 1.0;

    // UI Labels
    hideCtx.fillStyle = hit ? '#e74c3c' : '#ffffff';
    hideCtx.font = '900 13px "Outfit", sans-serif';
    hideCtx.textAlign = 'center';

    if (hit) {
        hideCtx.font = '24px "Outfit"';
        hideCtx.fillText('💥', size, size + 20);
    } else {
        hideCtx.fillText('DOM ' + id, size, size + h + 22);
    }

    if (active && !hit) {
        hideCtx.fillStyle = '#2ecc71';
        hideCtx.font = '900 10px "Outfit"';
        hideCtx.fillText('ВЫ ЗДЕСЬ', size, -15);
    }

    hideCtx.restore();
}


