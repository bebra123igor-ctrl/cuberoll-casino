// cuberoll frontend

const API = '';
let tg = null, initData = '';
var user = null; // var makes it window.user
let settings = {}, curSeeds = {};
let betType = 'high';
let exactNum = 7;
let rangeMin = 2, rangeMax = 6;
let rolling = false;
let streak = 0;
let dailyClaimed = false;
let tonConnectUI = null;
let isInitializing = true;
let soundEnabled = localStorage.getItem('settings_sound') !== 'false';

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
        tg.expand(); tg.ready();
        try { tg.setHeaderColor('#0d0d0d'); tg.setBackgroundColor('#0d0d0d'); } catch (e) { }
        initData = tg.initData;
        if (tg.HapticFeedback) window.haptic = tg.HapticFeedback;
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

// инит
async function init() {
    console.log('[Init] Starting...');
    initTg();

    // SECURITY: Telegram only check
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    // Fallback check if initData is somehow missing but we are definitely in TG
    if (!initData && window.Telegram?.WebApp?.initDataUnsafe?.user) {
        console.log('[Init] Using initDataUnsafe fallback');
        initData = 'UNSAFE_MODE'; // Note: Server might reject this if it expects HMAC
    }

    if (!initData && !isDev) {
        console.warn('Telegram initData not found. Application locked.');
        // Show something on lock screen for debug
        const lockMsg = document.querySelector('#tg-lock p');
        if (lockMsg) lockMsg.innerHTML += '<br><small style="opacity:0.5">(Error: No Init Data)</small>';
        return;
    }

    // Remove lock and show loader
    document.getElementById('tg-lock')?.remove();
    const loader = document.getElementById('loading-screen');
    if (loader) loader.classList.remove('hidden');

    try {
        buildExactPicker();

        // TonConnect
        tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
            manifestUrl: window.location.origin + '/tonconnect-manifest.json',
            buttonRootId: null
        });

        tonConnectUI.onStatusChange(async wallet => {
            if (wallet) {
                const addr = wallet.account.address;
                document.getElementById('ton-connect').classList.add('connected');
                try {
                    await api('/api/user/wallet', 'POST', { address: addr });
                } catch (e) { }
                if (!isInitializing) toast('Кошелёк подключен', 'success');
            } else {
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
            const inp = document.getElementById('dep-amount');
            if (inp) inp.setAttribute('min', window.appSettings.minDeposit);
        }

        document.getElementById('user-name').textContent = user.username || user.firstName || 'Player';
        document.getElementById('user-id').textContent = 'ID: ' + user.telegramId;
        document.getElementById('user-initial').textContent = (user.firstName || user.username || 'P')[0].toUpperCase();

        setBalance(user.balance);
        loadHistory();
        loadGifts();
        initEventListeners();

        // Hide loader
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
        setInterval(refreshBalance, 15000);

    } catch (e) {
        console.error('INIT ERROR:', e);
        const ldr = document.getElementById('loading-screen');
        if (ldr) ldr.innerHTML = `<div style="padding:40px;text-align:center;color:white"><h3>Ошибка запуска</h3><p>${e.message}</p><button onclick="location.reload()" style="margin-top:10px;background:var(--gold);border:none;padding:10px 20px;border-radius:10px">Перезагрузить</button></div>`;
        toast('Ошибка: ' + e.message, 'error');
    }
}

function toast(txt, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = txt;
    t.className = 'toast show ' + type;
    setTimeout(() => t.classList.remove('show'), 3000);
}

function setBalance(val, anim = false) {
    const el = document.getElementById('balance-amount');
    const old = parseFloat(el.textContent);
    el.textContent = val.toFixed(2);
    if (anim) {
        const p = document.getElementById('balance-display');
        p.classList.remove('pulse', 'pulse-loss');
        void p.offsetWidth;
        p.classList.add(val > old ? 'pulse' : 'pulse-loss');
    }
}

window.switchTab = function (tab) {
    document.querySelectorAll('.tab-content, .nav-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('content-' + tab).classList.add('active');
    document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
    if (tab === 'history') loadHistory();
    if (tab === 'shop') loadGifts();
    if (tab === 'leaderboard') loadLeaderboard();
    if (tab === 'settings') {
        document.getElementById('settings-sound').checked = soundEnabled;
    }
};

window.toggleSound = function () {
    soundEnabled = document.getElementById('settings-sound').checked;
    localStorage.setItem('settings_sound', soundEnabled);
    if (soundEnabled) toast('Звук включен');
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
    // Вкладки
    document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab);
    });

    // Типы ставок (в модалке)
    document.querySelectorAll('.bet-type-btn').forEach(btn => {
        btn.onclick = () => getBetType(btn.getAttribute('data-bet'));
    });

    // Суммы (в модалке)
    document.getElementById('btn-half').onclick = () => adjustBet('half');
    document.getElementById('btn-double').onclick = () => adjustBet('double');
    document.querySelectorAll('.quick-bet').forEach(btn => {
        btn.onclick = () => {
            const val = btn.getAttribute('data-amount');
            if (val === 'max') document.getElementById('bet-amount').value = user.balance.toFixed(1);
            else document.getElementById('bet-amount').value = parseFloat(val).toFixed(1);
            document.querySelectorAll('.quick-bet').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePayoutUI();
        };
    });

    // Кнопки открытия/закрытия модалки
    const openBtn = document.getElementById('open-bet-modal-btn');
    if (openBtn) openBtn.onclick = () => {
        document.getElementById('bet-modal').classList.remove('hidden');
        updatePayoutUI();
    };

    // Кнопка подтверждения ставки (внутри модалки)
    const confirmBtn = document.getElementById('roll-btn-confirm');
    if (confirmBtn) confirmBtn.onclick = roll;

    // Инпуты
    document.getElementById('bet-amount').oninput = updatePayoutUI;

    // Seeds & Verify
    const rotateBtn = document.getElementById('btn-rotate-seed');
    if (rotateBtn) rotateBtn.onclick = rotateServerSeed;

    const updateSeedBtn = document.getElementById('btn-update-seed');
    if (updateSeedBtn) updateSeedBtn.onclick = updateClientSeed;

    const verifyBtn = document.getElementById('btn-verify');
    if (verifyBtn) verifyBtn.onclick = verifyGame;
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
    document.getElementById('open-bet-modal-btn').disabled = true;
    if (window.haptic) haptic.impactOccurred('medium');

    try {
        const payload = { betAmount: amt, betType: betType };
        if (betType === 'exact') payload.exactNumber = exactNum;

        const res = await api('/api/bet', 'POST', payload);

        playSound('roll');
        animateDice(res.result.dice);

        setTimeout(() => {
            user.balance = res.result.newBalance;
            setBalance(user.balance, true);
            showResult(res.result);
            rolling = false;
            document.getElementById('open-bet-modal-btn').disabled = false;

            if (res.fairness) {
                document.getElementById('server-seed-hash').textContent = res.fairness.serverSeedHash;
                document.getElementById('nonce-value').textContent = res.fairness.nonce;
            }

        }, 1500);

    } catch (e) {
        toast(e.message, 'error');
        rolling = false;
        document.getElementById('open-bet-modal-btn').disabled = false;
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
        playSound('win');
    } else {
        amt.textContent = '-' + res.betAmount.toFixed(2) + ' TON';
        playSound('loss');
    }
    amt.className = 'result-amount ' + (res.won ? 'win' : 'loss');

    diceDisp.innerHTML = res.dice.map(v => `<div class="result-die-box">${v}</div>`).join('');

    if (window.haptic) {
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
    if (!tonConnectUI.connected) {
        toast('Сначала подключите кошелёк', 'info');
        await tonConnectUI.openModal();
        return;
    }

    const amountEl = document.getElementById('dep-amount');
    let amountValRaw = amountEl ? amountEl.value : '';

    // Заменяем запятую на точку для поддержки всех раскладок (особенно на iOS)
    amountValRaw = amountValRaw.replace(',', '.');
    const amountVal = parseFloat(amountValRaw);

    const minD = window.appSettings?.minDeposit || 0.1;

    if (isNaN(amountVal) || amountVal < minD) return toast(`Мин. сумма ${minD} TON`, 'error');

    const btn = document.getElementById('dep-btn-go');
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const res = await api('/api/deposit/request', 'POST', { amount: parseFloat(amountVal) });

        if (!res.address || res.address.includes('...')) {
            throw new Error('Адрес не настроен. Попробуйте позже.');
        }

        const depositComment = (res.comment || '').trim();

        // Показываем мемо в UI
        const memoCard = document.getElementById('memo-display-card');
        const activeMemo = document.getElementById('active-memo');
        if (memoCard && activeMemo) {
            activeMemo.textContent = depositComment;
            memoCard.classList.remove('hidden');
        }

        toast('Заявка создана. Подтвердите в кошельке!', 'success');

        // Generate BOC payload as a robust fallback
        let payload = null;
        try {
            if (window.TonWeb) {
                const cell = new window.TonWeb.boc.Cell();
                cell.bits.writeUint(0, 32); // Opcode 0 for text comment
                cell.bits.writeBytes(window.TonWeb.utils.stringToBytes(depositComment));
                // Generate BOC without index, but with CRC32 (standard for comments)
                const bocBytes = await cell.toBoc(false);
                payload = window.TonWeb.utils.bytesToBase64(bocBytes);
                console.log('[Deposit] Generated BOC payload:', payload);
            }
        } catch (e) {
            console.error('[Deposit] Payload generation error:', e);
        }

        const message = {
            address: res.address.trim(),
            amount: (BigInt(Math.round(parseFloat(amountVal) * 1e9))).toString(),
            payload: payload, // Binary BOC fallback
            comment: depositComment // Modern SDK text comment field
        };

        const transaction = {
            validUntil: Math.floor(Date.now() / 1000) + 600, // 10 minutes
            messages: [message]
        };

        await tonConnectUI.sendTransaction(transaction);

        // Теперь вместо мгновенного зачисления ждем подтверждения от блокчейна
        toast('Ждём подтверждения в сети TON...', 'info');
        btn.textContent = 'ОЖИДАНИЕ...';

        const checkDeposit = async () => {
            for (let i = 0; i < 30; i++) { // Проверяем 5 минут
                await new Promise(r => setTimeout(r, 10000));
                try {
                    const status = await api('/api/deposit/check');
                    if (status.completed && status.completed.some(d => d.comment === depositComment)) {
                        toast('Пополнение подтверждено!', 'success');
                        triggerConfetti();
                        refreshBalance();
                        return true;
                    }
                } catch (e) { }
            }
            toast('Платеж все еще не найден. Он зачислится автоматически позже.', 'info');
            return false;
        };
        checkDeposit();

    } catch (e) {
        console.error('Deposit flow failed:', e);
        const errMsg = e.message || 'Cancelled';
        if (errMsg.includes('User reject')) toast('Транзакция отменена', 'info');
        else toast(`Ошибка: ${errMsg}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'ПОПОЛНИТЬ';
    }
}

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


// --- CROSSROAD LOGIC ---
let crActive = false;
let crStep = 0;
let crMult = 1.0;
let crBet = 0;

window.selectGame = function (game) {
    document.getElementById('game-view-dice').classList.toggle('hidden', game !== 'dice');
    document.getElementById('game-view-crossroad').classList.toggle('hidden', game !== 'crossroad');
    document.getElementById('game-tab-dice').classList.toggle('active', game === 'dice');
    document.getElementById('game-tab-crossroad').classList.toggle('active', game === 'crossroad');
    if (game === 'crossroad') initCrLanes();
}

function initCrLanes() {
    const container = document.getElementById('cr-lanes-container');
    if (container.children.length > 0) return;
    for (let i = 0; i < 25; i++) {
        const lane = document.createElement('div');
        lane.className = 'cr-lane ' + (i % 3 === 0 ? 'safe' : 'road');
        lane.id = `cr-lane-${i}`;
        if (i > 0 && i % 3 !== 0) {
            addCar(lane);
        }
        container.appendChild(lane);
    }
    updateChickenPosition();
}

function addCar(lane) {
    const count = 1;
    for (let i = 0; i < count; i++) {
        const car = document.createElement('div');
        car.className = 'cr-obstacle';
        car.style.animationDuration = (2 + Math.random() * 2) + 's';
        car.style.animationDelay = (Math.random() * 4) + 's';
        if (Math.random() > 0.5) {
            car.style.animationDirection = 'reverse';
        }
        lane.appendChild(car);
    }
}

function updateChickenPosition() {
    const player = document.getElementById('cr-player');
    const container = document.getElementById('cr-lanes-container');

    // Прыжок
    player.classList.remove('jumping');
    void player.offsetWidth;
    player.classList.add('jumping');

    // Куб остается внизу, дорога едет вниз
    const laneHeight = 80;
    container.style.transform = `translateY(${crStep * laneHeight}px)`;

    // Остановка машин в текущем ряду и возобновление в прошлом
    stopCarsInLane(crStep);
    if (crStep > 0) resumeCarsInLane(crStep - 1);
}

function stopCarsInLane(step) {
    const lane = document.getElementById(`cr-lane-${step}`);
    if (!lane) return;
    lane.querySelectorAll('.cr-obstacle').forEach(car => car.classList.add('braking'));
}

function resumeCarsInLane(step) {
    const lane = document.getElementById(`cr-lane-${step}`);
    if (!lane) return;
    lane.querySelectorAll('.cr-obstacle').forEach(car => car.classList.remove('braking'));
}

window.crossroadStart = async function () {
    if (crActive) return;
    const amtStr = document.getElementById('cr-bet-amount').value.replace(',', '.');
    const amt = parseFloat(amtStr);
    if (isNaN(amt) || amt < 0.1) return toast('Мин. ставка 0.1 TON', 'error');
    if (amt > user.balance) return toast('Недостаточно баланса', 'error');

    try {
        const res = await api('/api/crossroad/start', 'POST', { betAmount: amt });
        crActive = true;
        crBet = amt;
        crStep = 0;
        crMult = 1.0;
        setBalance(res.newBalance);

        document.getElementById('cr-setup-ui').classList.add('hidden');
        document.getElementById('cr-play-ui').classList.remove('hidden');
        document.getElementById('cr-overlay').classList.add('hidden');

        updateCrUI();
        updateChickenPosition();
        if (window.haptic) haptic.impactOccurred('medium');
    } catch (e) { toast(e.message, 'error'); }
}

window.crossroadStep = async function () {
    if (!crActive) return;
    try {
        const res = await api('/api/crossroad/step', 'POST');

        if (res.crash) {
            crActive = false;
            // Анимация смерти: сначала спавним быструю машину
            await animateCrash(res.step);

            document.getElementById('cr-status-text').textContent = 'СБИТ ТЕХНИКОЙ! 💥';
            document.getElementById('cr-overlay').classList.remove('hidden');

            setTimeout(() => {
                document.getElementById('cr-setup-ui').classList.remove('manual-hidden');
                document.getElementById('cr-setup-ui').classList.remove('hidden');
                document.getElementById('cr-play-ui').classList.add('hidden');
            }, 1500);

            if (window.haptic) haptic.notificationOccurred('error');
        } else {
            crStep = res.step;
            crMult = res.multiplier;
            updateCrUI();
            updateChickenPosition();
            if (window.haptic) haptic.impactOccurred('light');
        }
    } catch (e) { toast(e.message, 'error'); }
}

async function animateCrash(targetStep) {
    const lane = document.getElementById(`cr-lane-${targetStep}`);
    if (!lane) return;

    const player = document.getElementById('cr-player');
    const container = document.getElementById('cr-lanes-container');
    const laneHeight = 80;

    // 1. Прыжок в ловушку
    player.classList.add('jumping');
    container.style.transform = `translateY(${targetStep * laneHeight}px)`;

    // Возобновляем движение в прошлом ряду, чтобы сзади был трафик
    if (crStep >= 0) resumeCarsInLane(crStep);

    // 2. Спавним "Скрытую Ламборгини"
    const killer = document.createElement('div');
    killer.className = 'cr-obstacle lamborghini killer';
    const exitRight = Math.random() > 0.5;
    killer.style.left = exitRight ? '-200px' : '150%';
    killer.style.transition = 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    lane.appendChild(killer);

    // 3. Резкий вылет и раскрытие (желтый цвет) прямо перед хитом
    await new Promise(r => setTimeout(r, 50));
    killer.style.left = '50%';
    setTimeout(() => killer.classList.add('revealed'), 100);

    // Удар
    await new Promise(r => setTimeout(r, 200));
    player.style.filter = 'hue-rotate(90deg) brightness(2)';
    player.style.transform = 'translateX(-50%) scale(0.6) rotate(45deg)';

    // Машина едет дальше, не останавливаясь
    killer.style.left = exitRight ? '200%' : '-200%';

    await new Promise(r => setTimeout(r, 300));
    player.style.filter = '';
    player.style.transform = '';
}

window.crossroadCashout = async function () {
    if (!crActive) return;
    try {
        const res = await api('/api/crossroad/cashout', 'POST');
        crActive = false;
        setBalance(res.newBalance);
        triggerConfetti();
        toast(`Вы выиграли ${res.payout.toFixed(2)} TON!`, 'success');

        document.getElementById('cr-setup-ui').classList.remove('hidden');
        document.getElementById('cr-play-ui').classList.add('hidden');
        updateCrUI();
    } catch (e) { toast(e.message, 'error'); }
}

function updateCrUI() {
    document.getElementById('cr-current-multiplier').textContent = crMult.toFixed(2) + 'x';
    document.getElementById('cr-current-win').textContent = (crBet * crMult).toFixed(2);
}

document.addEventListener('DOMContentLoaded', init);
