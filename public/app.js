// cuberoll frontend

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

    // Auto-hide manual deposit info when leaving wallet tab
    if (tab !== 'wallet') {
        const details = document.getElementById('manual-deposit-details');
        if (details) details.classList.add('hidden');
    }
    const content = document.getElementById('content-' + tab);
    const navBtn = document.querySelector(`[data-tab="${tab}"]`);

    if (!content) {
        console.error('[Tab] Content not found for', tab);
        return;
    }

    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));

    content.classList.add('active');
    if (navBtn) navBtn.classList.add('active');

    if (tab === 'history') loadHistory();
    if (tab === 'shop') loadGifts();
    if (tab === 'leaderboard') loadLeaderboard();
    if (tab === 'settings') {
        const toggle = document.getElementById('settings-haptic');
        if (toggle) toggle.checked = hapticEnabled;
    }

    const scrollable = content.querySelector('.tab-scrollable') || content;
    if (scrollable) scrollable.scrollTop = 0;
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

window.api = api; // Explicitly expose api
window.user = user; // Explicitly expose user

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

                    tonConnectUI.onStatusChange(async wallet => {
                        if (wallet) {
                            userWalletAddress = wallet.account.address;
                            document.getElementById('ton-connect').classList.add('connected');
                            try {
                                await api('/api/user/wallet', 'POST', { address: userWalletAddress });
                            } catch (e) { }
                            if (!isInitializing) toast('Кошелёк подключен', 'success');
                        } else {
                            userWalletAddress = null;
                            document.getElementById('ton-connect').classList.remove('connected');
                        }
                        isInitializing = false;
                    });

                    console.log('[Init] Authenticating...');
                    const data = await api('/api/auth', 'POST');
                    user = data.user;
                    curSeeds = data.seeds;
                    window.appSettings = data.settings || {};

                    if (window.appSettings.minDeposit) {
                        const h = document.getElementById('dep-min-hint');
                        if (h) h.textContent = `Минимум: ${window.appSettings.minDeposit} TON`;
                    }

                    document.getElementById('user-name').textContent = user.username || user.firstName || 'Player';
                    document.getElementById('user-id').textContent = 'ID: ' + user.telegramId;
                    document.getElementById('user-initial').textContent = (user.firstName || user.username || 'P')[0].toUpperCase();

                    setBalance(user.balance);

                    // Initialize modules independently
                    try { await loadHistory(); } catch (e) { console.error('[Init] History failed', e); }
                    try { await loadGifts(); } catch (e) { console.error('[Init] Gifts failed', e); }
                    try { initEventListeners(); } catch (e) { console.error('[Init] Listeners failed', e); }
                    try { initPlinko(); } catch (e) { console.error('[Init] Plinko failed', e); }

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
    const betAmt = document.getElementById('bet-amount');
    if (betAmt) betAmt.oninput = updatePayoutUI;

    const pBetAmt = document.getElementById('plinko-bet-amount');
    if (pBetAmt) pBetAmt.oninput = updatePlinkoPreviews;

    // Seeds & Verify
    safeSetClick('btn-rotate-seed', rotateServerSeed);
    safeSetClick('btn-update-seed', updateClientSeed);
    safeSetClick('btn-verify', verifyGame);
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
    if (rolling) return;
    if (!tonConnectUI.connected) {
        toast('Сначала подключите кошелёк', 'info');
        await tonConnectUI.openModal();
        return;
    }

    const amt = parseFloat(document.getElementById('bet-amount').value);
    if (isNaN(amt) || amt < 0.1) return toast('Мин. ставка 0.1 TON', 'error');
    if (amt > user.balance) return toast('Недостаточно баланса', 'error');

    document.getElementById('bet-modal').classList.add('hidden');

    rolling = true;
    const rollBtn = document.getElementById('roll-btn-confirm');
    const originalBtnText = rollBtn.textContent;
    rollBtn.disabled = true;
    rollBtn.innerHTML = '<span class="loader-inline"></span> БРОСАЕМ...';
    if (window.haptic && hapticEnabled) haptic.impactOccurred('medium');

    try {
        const payload = { betAmount: amt, betType: betType };
        if (betType === 'exact') payload.exactNumber = exactNum;

        const res = await api('/api/bet', 'POST', payload);

        if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
        animateDice(res.result.dice);

        setTimeout(() => {
            user.balance = res.result.newBalance;
            setBalance(user.balance, true);
            showResult(res.result);
            rolling = false;
            rollBtn.disabled = false;
            rollBtn.textContent = originalBtnText;
            document.getElementById('open-bet-modal-btn').disabled = false;
        }, 1200);
    } catch (e) {
        rolling = false;
        const rb = document.getElementById('roll-btn-confirm');
        if (rb) {
            rb.disabled = false;
            rb.textContent = 'ОШИБКА. ЕЩЕ РАЗ?';
        }
        document.getElementById('open-bet-modal-btn').disabled = false;
        toast(e.message, 'error');
    }
};

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
    el.style.transform = rotations[val] || 'rotateX(0deg)';
}

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
                <div class="gift-img-wrap">
                    <img src="${g.model || 'https://i.imgur.com/8YvYyZp.png'}" class="gift-img">
                </div>
                <div class="gift-info">
                    <div class="gift-name">${g.title}</div>
                    <div class="gift-price">${g.price} TON</div>
                    <button class="gift-buy-btn" data-id="${g.id}" data-name="${g.title.replace(/'/g, "\\'")}" data-price="${g.price}">Купить</button>
                </div>
            `;
            card.querySelector('.gift-buy-btn').onclick = () => window.openBuyModal(g.id, g.title, g.price);
            list.appendChild(card);
        });
    } catch (e) { }
}
window.loadGifts = loadGifts;

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
        const list = document.getElementById('history-list');
        list.innerHTML = res.games.length ? res.games.map(g => {
            const date = new Date(g.created_at);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const amountStr = g.won ? `+${g.payout.toFixed(2)}` : `-${g.bet_amount.toFixed(2)}`;
            const statusLabel = g.won ? 'WIN' : 'LOSS';

            return `
                <div class="history-item animated-history">
                    <div class="hist-left">
                        <div class="hist-badge ${g.won ? 'badge-win' : 'badge-loss'}">${statusLabel}</div>
                        <div class="hist-meta">
                            <span class="hist-type">${g.player_choice.replace('exact_', 'TARGET: ').toUpperCase()}</span>
                            <span class="hist-time">${timeStr}</span>
                        </div>
                    </div>
                    <div class="hist-res ${g.won ? 'win' : 'loss'}">${amountStr} TON</div>
                </div>
            `;
        }).join('') : '<div class="empty-state">История пуста</div>';
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
    const bDice = document.getElementById('game-tab-dice');
    const bCrash = document.getElementById('game-tab-crash');
    const bPlinko = document.getElementById('game-tab-plinko');

    // Hide all views first
    [diceView, crashView, plinkoView].forEach(v => v?.classList.add('hidden'));
    [bDice, bCrash, bPlinko].forEach(b => b?.classList.remove('active'));

    currentGame = game;

    if (game === 'dice') {
        diceView?.classList.remove('hidden');
        bDice?.classList.add('active');
        stopCrashPolling();
    } else if (game === 'crash') {
        crashView?.classList.remove('hidden');
        bCrash?.classList.add('active');
        startCrashPolling();
        if (!window._crashInited) initCrashCanvas();
        else renderCrash(); // Restart loop if stopped
    } else if (game === 'plinko') {
        plinkoView?.classList.remove('hidden');
        bPlinko?.classList.add('active');
        stopCrashPolling();
        // Small delay to let browser show the element (needed for offsetWidth)
        setTimeout(() => {
            initPlinko();
        }, 10);
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
    if (currentGame !== 'crash') return;
    if (!crashCanvas || !crashCtx) return;

    // Direct loop control
    cancelAnimationFrame(crashAnimationId);
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

    const currentMult = isPlaying ? Math.pow(1.07, t) : (isCrashed ? (crashStatus.multiplier || 1) : 1);

    // 1. КОСМОС С УСКОРЕНИЕМ (WARP EFFECT)
    const speedFactor = isPlaying ? (1 + currentMult * 0.5) : (isCrashed ? 0 : 0.2);
    crashCtx.strokeStyle = '#ffffff';
    crashCtx.fillStyle = '#ffffff';

    stars.forEach(s => {
        const move = s.s * speedFactor * 10;
        s.y += move;
        if (s.y > h) { s.y = 0; s.x = Math.random() * w; }

        crashCtx.globalAlpha = s.o;
        if (currentMult > 3 && isPlaying) {
            // Линии скорости
            crashCtx.lineWidth = s.s;
            crashCtx.beginPath();
            crashCtx.moveTo(s.x, s.y);
            crashCtx.lineTo(s.x, s.y + move * 0.8);
            crashCtx.stroke();
        } else {
            // Обычные звезды
            crashCtx.beginPath();
            crashCtx.arc(s.x, s.y, s.s, 0, Math.PI * 2);
            crashCtx.fill();
        }
    });
    crashCtx.globalAlpha = 1;

    // РАКЕТА
    if (isPlaying || isCrashed || (crashStatus && crashStatus.phase === 'WAITING')) {
        const timeFactor = (isPlaying || isCrashed) ? t : (Date.now() / 1000);

        if (isPlaying) {
            const multEl = document.getElementById('crash-multiplier');
            if (multEl) multEl.textContent = currentMult.toFixed(2) + 'x';
        }

        // Позиция: Центр с нарастающей тряской
        const shakeAmp = isPlaying ? (1 + currentMult / 8) : 0;

        // Адаптивный масштаб для мелких экранов
        // Увеличиваем масштаб, чтобы на телефонах ракета была "на весь экран"
        // Stable scale for all devices
        const baseWidth = 360;
        const s = Math.min(1.8, Math.max(0.8, w / baseWidth));

        const rx = Math.round(w / 2) + Math.sin(timeFactor * 30) * shakeAmp;
        const ry = Math.round(h * 0.45);

        crashCtx.save();
        // Масштабируем всё относительно центра ракеты
        crashCtx.translate(rx, ry);
        crashCtx.scale(s, s);
        crashCtx.translate(-rx, -ry);

        // ПЛАМЯ (увеличивается и белеет при разгоне)
        if (isPlaying || (isCrashed && t > 0)) {
            const firePower = 1 + Math.min(2, currentMult / 15);
            // Уменьшаем длину пламени на 20%
            const fireLen = (40 + Math.random() * 30) * firePower;
            const fireGrad = crashCtx.createLinearGradient(rx, ry + 20, rx, ry + fireLen);
            fireGrad.addColorStop(0, '#ffffff'); // Очень горячее у сопла
            fireGrad.addColorStop(0.2, '#f1c40f');
            fireGrad.addColorStop(0.6, '#e67e22');
            fireGrad.addColorStop(1, 'transparent');

            crashCtx.fillStyle = fireGrad;
            crashCtx.beginPath();
            crashCtx.moveTo(rx - 12, ry + 15);
            crashCtx.quadraticCurveTo(rx, ry + fireLen + 20, rx + 12, ry + 15);
            crashCtx.fill();
        }

        // ЭФФЕКТ СВЕЧЕНИЯ (HEAT GLOW)
        if (isPlaying) {
            crashCtx.shadowBlur = 15 + currentMult * 3;
            crashCtx.shadowColor = currentMult > 10 ? '#ff4400' : '#f1c40f';
        }

        // КОРПУС - ЦЕЛЬНЫЙ МОНОЛИТНЫЙ ДИЗАЙН (без швов)
        const rocketGrad = crashCtx.createLinearGradient(rx - 15, ry, rx + 15, ry);
        rocketGrad.addColorStop(0, '#bdc3c7');
        rocketGrad.addColorStop(0.4, '#ffffff');
        rocketGrad.addColorStop(1, '#95a5a6');

        crashCtx.fillStyle = rocketGrad;
        crashCtx.beginPath();
        // Ракетный "купол" и тело одним контуром
        crashCtx.moveTo(rx - 16, ry + 30); // Низ лево
        crashCtx.lineTo(rx - 16, ry - 5);  // Левый борт
        crashCtx.bezierCurveTo(rx - 16, ry - 60, rx + 16, ry - 60, rx + 16, ry - 5); // Нос
        crashCtx.lineTo(rx + 16, ry + 30); // Правый борт
        crashCtx.quadraticCurveTo(rx, ry + 40, rx - 16, ry + 30); // Закругленное дно
        crashCtx.fill();

        // Иллюминатор (встроен в монолит)
        crashCtx.fillStyle = '#1a1a1a';
        crashCtx.beginPath();
        crashCtx.arc(rx, ry - 10, 7, 0, Math.PI * 2);
        crashCtx.fill();
        // Блик в иллюминаторе
        const glassGrad = crashCtx.createRadialGradient(rx - 2, ry - 12, 1, rx, ry - 10, 7);
        glassGrad.addColorStop(0, '#3498db');
        glassGrad.addColorStop(1, '#2980b9');
        crashCtx.fillStyle = glassGrad;
        crashCtx.beginPath();
        crashCtx.arc(rx, ry - 10, 5, 0, Math.PI * 2);
        crashCtx.fill();

        // Золотые элементы (плавники) - рисуем поверх, но без щелей
        crashCtx.fillStyle = '#c2a74d';
        // Левое крыло
        crashCtx.beginPath();
        crashCtx.moveTo(rx - 16, ry + 5);
        crashCtx.lineTo(rx - 35, ry + 35);
        crashCtx.lineTo(rx - 16, ry + 25);
        crashCtx.fill();
        // Правое крыло
        crashCtx.beginPath();
        crashCtx.moveTo(rx + 16, ry + 5);
        crashCtx.lineTo(rx + 35, ry + 35);
        crashCtx.lineTo(rx + 16, ry + 25);
        crashCtx.fill();

        // Финальная обводка для четкости
        crashCtx.strokeStyle = 'rgba(0,0,0,0.1)';
        crashCtx.lineWidth = 1;
        crashCtx.stroke();

        crashCtx.shadowBlur = 0;
        crashCtx.restore(); // Сбрасываем трансформации (scale)

        if (isPlaying && window.haptic && hapticEnabled && Math.random() > 0.96) {
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
    const amtStr = document.getElementById('crash-bet-amount').value;
    const amt = parseFloat(amtStr);

    if (isNaN(amt) || amt < 0.1) return toast('Минимум 0.1 TON', 'error');
    if (amt > user.balance) return toast('Недостаточно баланса', 'error');

    try {
        const res = await api('/api/crash/bet', 'POST', { betAmount: amt });
        setBalance(res.newBalance);
        toast('Ставка принята!', 'success');
        if (window.haptic && hapticEnabled) haptic.impactOccurred('medium');
        pollCrash();
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
const PLINKO_MULTIS = [3, 2, 1.2, 0.9, 0.7, 0.9, 1.2, 2, 3];

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
    }

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
    const amt = parseFloat(document.getElementById('plinko-bet-amount').value) || 0;
    document.querySelectorAll('.plinko-multiplier-slot').forEach(slot => {
        const m = parseFloat(slot.dataset.mult);
        const preview = slot.querySelector('.mult-payout-preview');
        if (preview) {
            preview.textContent = (amt * m).toFixed(2);
        }
    });
}

async function plinkoDrop() {
    const btn = document.getElementById('plinko-drop-btn');
    const amountVal = document.getElementById('plinko-bet-amount').value;

    if (btn.disabled) return;
    btn.disabled = true;

    try {
        const res = await api('/api/plinko/bet', 'POST', { betAmount: parseFloat(amountVal) });

        // Start animation
        const ball = {
            x: plinkoCanvas.width / 2 + (Math.random() - 0.5) * 10,
            y: 20,
            vx: (Math.random() - 0.5) * 0.5,
            vy: 1.0,
            radius: 10,
            path: res.result.path,
            step: 0,
            targetSlot: res.result.slot,
            payout: res.result.payout,
            multiplier: res.result.multiplier,
            color: '#ffffff',
            dieValue: Math.floor(Math.random() * 6) + 1,
            bounceCount: 0,
            newBalance: res.result.newBalance // Store balance here to sync on impact
        };
        plinkoBalls.push(ball);

    } catch (e) {
        toast(e.message, 'error');
    } finally {
        setTimeout(() => { btn.disabled = false; }, 500);
    }
}

function renderPlinko() {
    // If context is lost or wasn't ready, try to re-init
    if (!plinkoCanvas || !plinkoCtx) {
        plinkoCanvas = document.getElementById('plinko-canvas');
        if (plinkoCanvas) {
            plinkoCtx = plinkoCanvas.getContext('2d');
            console.log('[Plinko Renderer] Re-acquired canvas context');
        }
        return requestAnimationFrame(renderPlinko);
    }

    // Low-power mode when hidden
    if (activeTab !== 'game' || currentGame !== 'plinko') {
        return requestAnimationFrame(renderPlinko);
    }

    const curW = plinkoCanvas.offsetWidth;
    const curH = plinkoCanvas.offsetHeight;

    // Only draw and resize if visible
    if (curW > 10 && curH > 10) {
        if (plinkoCanvas.width !== curW) plinkoCanvas.width = curW;
        if (plinkoCanvas.height !== curH) plinkoCanvas.height = curH;

        const w = plinkoCanvas.width;
        const h = plinkoCanvas.height;
        plinkoCtx.clearRect(0, 0, w, h);

        // Draw Pegs
        const rowGap = (h - 60) / (PLINKO_ROWS + 1);
        const colGap = w / (PLINKO_ROWS + 2);

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

        // Update and Draw Balls
        const gravity = 0.05; // Even slower

        plinkoBalls = plinkoBalls.filter(ball => {
            ball.vy += gravity;
            ball.x += ball.vx;
            ball.y += ball.vy;

            // Wall bouncing
            if (ball.x < 15) {
                ball.x = 15;
                ball.vx *= -0.6;
            } else if (ball.x > w - 15) {
                ball.x = w - 15;
                ball.vx *= -0.6;
            }

            const currentRow = Math.floor((ball.y - 40) / rowGap);
            if (currentRow > ball.step && ball.step < PLINKO_ROWS) {
                const move = ball.path[ball.step];
                // Introduce some "bounce" logic
                ball.vx = (move === 1 ? 1 : -1) * (colGap / 18) + (Math.random() - 0.5) * 0.5;
                ball.vy = 1.2;
                ball.step++;
            }

            // Draw dice instead of square
            plinkoCtx.save();
            plinkoCtx.translate(ball.x, ball.y);
            plinkoCtx.rotate(ball.y / 15);

            // Dice body
            const size = 16;
            const r = 4;
            plinkoCtx.fillStyle = '#fff';
            plinkoCtx.shadowBlur = 15;
            plinkoCtx.shadowColor = 'rgba(255,255,255,0.5)';

            plinkoCtx.beginPath();
            plinkoCtx.roundRect(-size / 2, -size / 2, size, size, r);
            plinkoCtx.fill();

            // Dots
            plinkoCtx.fillStyle = '#000';
            const dotSize = 2;
            const p = size / 4;
            const drawDot = (dx, dy) => {
                plinkoCtx.beginPath();
                plinkoCtx.arc(dx, dy, dotSize, 0, Math.PI * 2);
                plinkoCtx.fill();
            };

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

            if (ball.y > h - 18) {
                // Precise landing inside the slot
                highlightSlot(ball.targetSlot);
                if (ball.payout > 0) toast(`Победа! ${ball.payout.toFixed(2)} TON`, 'success');
                if (ball.newBalance !== undefined) setBalance(ball.newBalance, true);
                return false;
            }
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
