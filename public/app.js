// cuberoll frontend
window.demoMode = false;
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

window.confirmBetAction = null;
window.openStats = () => window.switchTab('invite');

window.switchTab = function (tab) {
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
    if (!s || typeof s !== 'string') return s;
    try {
        // Simple check if it's base64-ish
        if (!/^[A-Za-z0-9+/=]+$/.test(s)) return JSON.parse(s);
        const raw = atob(s);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            bytes[i] = raw.charCodeAt(i) ^ _SEC_KEY.charCodeAt(i % _SEC_KEY.length);
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        try { return JSON.parse(s); } catch (e2) { return { error: s }; }
    }
};

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
        const rawData = await res.text();

        if (!res.ok) {
            if (res.status === 403) {
                try {
                    const e = _0x_dec(rawData);
                    if (e.error === 'Account is banned') {
                        showBanScreen();
                        throw new Error('Banned');
                    }
                } catch (err) { if (err.message === 'Banned') throw err; }
            }
            let e = {};
            try {
                e = _0x_dec(rawData);
            } catch (err) {
                const errResult = new Error(`Server Error: ${res.status}`);
                errResult.status = res.status;
                throw errResult;
            }
            const errResult = new Error(e.error || `Error ${res.status}`);
            errResult.status = res.status;
            throw errResult;
        }
        if (rawData && rawData.trim()) {
            const decoded = _0x_dec(rawData);
            if (decoded && decoded.user) {
                window.user = decoded.user;
                user = decoded.user;
            }
            return decoded;
        }
        return {};
    } catch (err) {
        console.error('API Error:', err);
        throw err;
    }
}
window.api = api;
window.user = user;

function showBanScreen() {
    document.getElementById('ban-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('loading-screen').style.display = 'none';
}

// Global error handler for debugging
window.onerror = function (msg, url, line, col, error) {
    console.error('CRITICAL ERROR:', msg, 'at', url, line, col, error);
    let displayMsg = msg;
    if (msg === 'Script error.') {
        // Don't show confusing CORS message if everything is working
        return;
    }
    if (window.toast) toast('System Error: ' + displayMsg, 'error');
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
                    window.user = data.user;
                    user = data.user;
                    curSeeds = data.seeds;
                    window.appSettings = data.settings || {};

                    if (window.appSettings.minDeposit) {
                        const h = document.getElementById('dep-min-hint');
                        if (h) h.textContent = `Минимум: ${window.appSettings.minDeposit} TON`;
                    }


                    document.getElementById('user-name').textContent = user.username || user.firstName || 'Player';
                    document.getElementById('user-id').textContent = 'ID: ' + user.telegramId;

                    // Load user avatar from Telegram
                    const photoUrl = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url;
                    if (photoUrl) {
                        const avatarImg = document.getElementById('user-avatar-img');
                        const avatarFallback = document.getElementById('user-avatar-fallback');
                        if (avatarImg) {
                            avatarImg.src = photoUrl;
                            avatarImg.onload = () => {
                                avatarImg.style.display = 'block';
                                if (avatarFallback) avatarFallback.style.display = 'none';
                            };
                        }
                    }

                    setBalance(user.balance);

                    // Update Referral Info
                    const refCode = user.referralCode || user.telegramId;
                    const refLink = `https://t.me/cuberoll_robot?start=ref_${refCode}`;
                    const refLinkEl = document.getElementById('referral-link');
                    if (refLinkEl) refLinkEl.textContent = refLink;
                    const refEarnedEl = document.getElementById('ref-earned-value');
                    if (refEarnedEl) refEarnedEl.textContent = (user.referralEarned || 0).toFixed(2);

                    // Referral count
                    const refCount = user.referralCount || 0;
                    const refCountEl = document.getElementById('ref-count-value');
                    if (refCountEl) refCountEl.textContent = refCount;

                    // Referral promo
                    const promo = data.referralPromo;
                    if (promo && promo.active) {
                        const banner = document.getElementById('ref-promo-banner');
                        if (banner) banner.style.display = 'flex';

                        const progressWrap = document.getElementById('ref-progress-wrap');
                        if (progressWrap && !user.referralBonusClaimed) {
                            progressWrap.style.display = 'block';
                            const pct = Math.min(refCount / promo.requiredReferrals * 100, 100);
                            const bar = document.getElementById('ref-progress-bar');
                            if (bar) bar.style.width = pct + '%';
                            const label = document.getElementById('ref-progress-label');
                            if (label) label.textContent = `${Math.min(refCount, promo.requiredReferrals)}/${promo.requiredReferrals}`;
                        }
                        if (user.referralBonusClaimed) {
                            const banner2 = document.getElementById('ref-promo-banner');
                            if (banner2) {
                                banner2.querySelector('.promo-text b').textContent = '✅ Бонус 3 TON получен!';
                                banner2.querySelector('.promo-text span').textContent = 'Спасибо за приглашения';
                            }
                        }
                    }

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
    user.balance = val; // Always sync internal balance immediately
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

function copyReferralLink() {
    const link = document.getElementById('referral-link').textContent;
    navigator.clipboard.writeText(link).then(() => {
        toast('Ссылка скопирована!', 'success');
    });
}

function shareReferralLink() {
    const link = document.getElementById('referral-link').textContent;
    const text = '🎲 Играй в CubeRoll Casino и выигрывай TON! Присоединяйся по моей ссылке:';
    if (window.Telegram?.WebApp?.openTelegramLink) {
        window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
    } else {
        navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована!', 'success'));
    }
}

window.connectWallet = async function () {
    if (!window.TON_CONNECT_UI) return toast('Wallet UI not loaded', 'error');
    if (!tonConnectUI) return toast('Initializing wallet...', 'info');
    try {
        if (!tonConnectUI.connected) {
            await tonConnectUI.openModal();
        } else {
            await tonConnectUI.disconnect();
        }
    } catch (e) { console.error('Wallet error:', e); }
};

window.goToPayment = async function () {
    const valEl = document.getElementById('dep-amount');
    if (!valEl) return;
    const amount = parseFloat(valEl.value);
    const min = (settings && settings.minDeposit) || 0.001;
    if (isNaN(amount) || amount < min) return toast(`Минимум ${min} TON`, 'error');

    try {
        const btn = document.getElementById('deposit-link');
        if (btn) {
            btn.innerText = 'ПРОВЕРКА...';
            btn.style.pointerEvents = 'none';
        }

        const res = await api('/api/deposit/request', 'POST', { amount });

        if (res.link) {
            // Using window.location.href to avoid WEBAPP_TG_URL_INVALID with ton:// protocol
            window.location.href = res.link;

            // Redirect to bot chat while keeping webapp active in background
            if (tg && tg.openTelegramLink) {
                setTimeout(() => {
                    tg.openTelegramLink('https://t.me/cuberoll_robot');
                }, 500);
            }

            toast('Открываем кошелек...', 'info');
        } else {
            toast('Заявка создана. Проверьте сообщения в боте.', 'success');
        }
    } catch (e) {
        toast(e.message, 'error');
        const btn = document.getElementById('deposit-link');
        if (btn) {
            btn.innerText = 'ОПЛАТИТЬ';
            btn.style.pointerEvents = 'auto';
        }
    }
};


window.toggleHaptic = function () {
    hapticEnabled = document.getElementById('settings-haptic').checked;
    localStorage.setItem('settings_haptic', hapticEnabled);
    if (hapticEnabled) toast('Вибрация включена');
};


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
    document.querySelectorAll('.bet-type-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-bet') === t);
    });

    // Показ пикеров
    const exactPicker = document.getElementById('exact-picker');
    if (exactPicker) {
        if (t === 'exact') {
            exactPicker.style.display = 'block';
            buildExactPicker();
        } else {
            exactPicker.style.display = 'none';
        }
    }

    updatePayoutUI();
    if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
};

function updatePayoutUI() {
    let mult = 0;
    if (betType === 'high' || betType === 'low') mult = 1.95;
    if (betType === 'even' || betType === 'odd') mult = 1.95;
    if (betType === 'seven') mult = 5.0;
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
    const container = document.getElementById('dice-exact-numbers');
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
    // Removal of conflicting global listener - we use direct onclick now
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
        const activeBtn = document.querySelector('.bet-type-btn.active');
        const bType = activeBtn ? activeBtn.dataset.bet : 'high';

        // DEMO MODE: simulate locally
        if (window.demoMode) {
            const d1 = Math.floor(Math.random() * 6) + 1;
            const d2 = Math.floor(Math.random() * 6) + 1;
            const total = d1 + d2;
            let won = false;
            let mult = 1.95;
            if (bType === 'high') won = total >= 8;
            else if (bType === 'low') won = total <= 6;
            else if (bType === 'even') won = total % 2 === 0;
            else if (bType === 'odd') won = total % 2 !== 0;
            else if (bType === 'exact') {
                won = total === exactNum;
                const exactMults = { 2: 18, 3: 12, 4: 9, 5: 7.2, 6: 6, 7: 5.14, 8: 6, 9: 7.2, 10: 9, 11: 12, 12: 18 };
                mult = exactMults[exactNum] || 6;
            }
            const payout = won ? amt * mult : 0;

            if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
            animateDice([d1, d2]);

            setTimeout(() => {
                showResult({ won, betAmount: amt, payout, multiplier: won ? mult : 0, dice: [d1, d2] });
                toast('🎮 ДЕМО — баланс не изменён', 'info');
                rolling = false;
                if (rollBtn) rollBtn.disabled = false;
            }, 1200);
            return;
        }

        const payload = {
            betAmount: amt,
            betType: bType
        };
        if (bType === 'exact') payload.exactNumber = exactNum;
        if (betMode === 'gift' && selectedGift) {
            payload.giftInstanceId = selectedGift.instance_id;
            selectedGift = null;
        }

        const res = await api('/api/bet', 'POST', payload);
        if (window.haptic && hapticEnabled) haptic.impactOccurred('light');
        animateDice(res.result.dice);

        // Update balance immediately to prevent 'insufficient balance' on rapid bets
        user.balance = res.result.newBalance;

        // Show result and animate balance after dice animation
        setTimeout(() => {
            setBalance(res.result.newBalance, true);
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


function getGiftImg(model) {
    if (!model) return 'https://i.imgur.com/8YvYyZp.png';
    if (model.startsWith('http')) return model;
    return `models/${model}/photo.png`;
}

function getGiftLink(id, slug, fullLink) {
    if (fullLink && fullLink.startsWith('http')) return fullLink;
    if (slug && id && id !== 'undefined') return `https://t.me/nft/${slug}-${id}`;
    if (!id || id === 'undefined') return 'https://t.me/nft/gift';
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
                <a href="${getGiftLink(item.gift_id, item.slug, item.link)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
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
                <a href="${getGiftLink(item.gift_id, item.slug, item.link)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
                <div class="shop-item-icon"><img src="${getGiftImg(item.model)}" alt=""></div>
                <div class="shop-item-info" style="margin-bottom: 5px;">
                    <div class="shop-item-title">${item.title}</div>
                </div>
                <div class="item-actions" style="display: flex; gap: 5px; width: 100%;">
                    <button class="buy-btn" onclick="openListSale(${item.instance_id})" style="flex: 1; padding: 6px 0; font-size: 10px;">ПРОДАТЬ</button>
                    <button class="buy-btn" onclick="withdrawGift(${item.instance_id})" style="flex: 1; padding: 6px 0; font-size: 10px; background: rgba(0,136,204,0.2); border-color: #0088cc; color: #0088cc;">ВЫВЕСТИ</button>
                </div>
            </div>`).join('');

        // Items already listed
        html += listings.map(item => `
            <div class="shop-item glass-card listing-active">
                <a href="${getGiftLink(item.gift_id, item.slug, item.link)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
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

window.withdrawGift = async function (instanceId) {
    if (!confirm('Вы хотите вывести этот подарок в Telegram? \n\nПосле подтверждения подарок будет удален из игры и поставлен в очередь на отправку.')) return;
    try {
        const res = await api('/api/inventory/withdraw', 'POST', { instanceId });
        toast(res.message, 'success');
        openInventory(); // Refresh list
        // Show the dealer reminder
        if (localStorage.getItem('dealer_warned') !== '1') {
            document.getElementById('dealer-warning-modal').classList.remove('hidden');
        }
    } catch (e) {
        toast(e.message, 'error');
    }
};

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
        amt.textContent = '+' + (res.payout || 0).toFixed(2) + ' TON';
    } else {
        amt.textContent = '-' + (res.betAmount || 0).toFixed(2) + ' TON';
    }
    amt.className = 'result-amount ' + (res.won ? 'win' : 'loss');

    if (res.dice && res.dice.length) {
        const sum = res.total || res.dice.reduce((a, b) => a + b, 0);
        diceDisp.innerHTML = res.dice.map(v => `<div class="result-die-box">${v}</div>`).join('') +
            `<div style="width: 100%; margin-top: 10px; font-weight: 900; color: #fff; font-size: 16px;">СУММА: ${sum}</div>`;
    } else if (res.room) {
        diceDisp.innerHTML = `<div class="result-die-box" style="width: 80px; border-radius: 12px; font-size: 14px;">ДОМ ${res.room}</div>`;
    } else {
        diceDisp.innerHTML = '';
    }

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
                <a href="${getGiftLink(g.gift_id, g.slug, g.link)}" target="_blank" class="gift-info-link" onclick="event.stopPropagation()">?</a>
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


async function refreshBalance() {
    try {
        const data = await api('/api/auth', 'POST');
        user.balance = data.user.balance;
        setBalance(user.balance);
    } catch (e) { }
}

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
const PLINKO_ROWS = 10;
const PLINKO_MULTIS = [15, 6, 2.5, 1.3, 0.6, 0, 0.6, 1.3, 2.5, 6, 15];

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
        const colorMap = {
            0: '#ff3d00', // Center (0.3x)
            1: '#ff6d00', // 0.6x
            2: '#ff9100', // 1.3x
            3: '#ffcc00', // 2.5x
            4: '#aeea00', // 6x
            5: '#00e676', // 15x (Edge)
        };
        // Center of 11 slots is index 5
        const midIndex = Math.floor(PLINKO_MULTIS.length / 2);

        PLINKO_MULTIS.forEach((m, i) => {
            const slot = document.createElement('div');
            slot.className = 'plinko-multiplier-slot';
            slot.dataset.mult = m;

            // Distance from center
            const dist = Math.abs(i - midIndex);
            const color = colorMap[dist] || '#fff';
            let label = m + 'x';
            if (m === 0) label = '💀';

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

        // DEMO MODE: simulate locally
        if (window.demoMode) {
            const path = [];
            let currentSlot = Math.floor(dropX * PLINKO_ROWS);
            // Better slot calculation: bits are directions. 
            // 0 = left, 1 = right. 
            for (let i = 0; i < PLINKO_ROWS; i++) {
                const bit = Math.random() > 0.5 ? 1 : 0;
                path.push(bit);
            }

            // Calculate final slot based on path
            let slot = Math.floor(dropX * (PLINKO_ROWS + 1));
            path.forEach(dir => { if (dir === 1) slot++; else slot--; });
            // Clamp slot
            slot = Math.max(0, Math.min(PLINKO_ROWS, Math.floor(slot / 2) + Math.floor(PLINKO_ROWS / 2)));
            // Wait, standard plinko slot logic is simple: count of 'rights' (1s)
            let rights = 0;
            path.forEach(b => { if (b === 1) rights++; });
            slot = rights;

            const multiplier = PLINKO_MULTIS[slot] || 0;
            const amt = payload.betAmount || 0;
            const payout = amt * multiplier;

            plinkoBalls = plinkoBalls.filter(b => !b.landed);
            const ball = {
                x: plinkoCanvas.width * dropX,
                y: 20,
                path: path,
                targetSlot: slot,
                payout: payout,
                betAmount: amt,
                multiplier: multiplier,
                dieValue: Math.floor(Math.random() * 6) + 1,
                landed: false,
                isDemo: true
            };
            plinkoBalls.push(ball);
            toast('🎮 ДЕМО — баланс не изменён', 'info');
            return;
        }

        const res = await api('/api/plinko/bet', 'POST', { x: dropX, ...payload });

        // Update balance IMMEDIATELY to prevent 'insufficient balance' on rapid drops
        user.balance = res.result.newBalance;

        // Remove old landed balls to keep canvas clean
        plinkoBalls = plinkoBalls.filter(b => !b.landed);

        const ball = {
            x: plinkoCanvas.width * dropX,
            y: 20,
            path: res.result.path,
            targetSlot: res.result.slot,
            payout: res.result.payout,
            betAmount: payload.betAmount || (selectedGift ? selectedGift.price : 0),
            multiplier: res.result.multiplier,
            dieValue: Math.floor(Math.random() * 6) + 1,
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

        const topPad = 55;
        const rowGap = (h - 80) / (PLINKO_ROWS + 1);
        const colGap = w / (PLINKO_ROWS + 2);
        const slotWidth = w / PLINKO_MULTIS.length;

        // Helper: peg position for waypoint calc
        function pegPos(row, col) {
            const rowCols = row + 1;
            const startX = (w - (rowCols - 1) * colGap) / 2;
            return { x: startX + col * colGap, y: topPad + row * rowGap };
        }

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
            const rowY = topPad + r * rowGap;
            const rowCols = r + 1;
            const startX = (w - (rowCols - 1) * colGap) / 2;
            for (let c = 0; c < rowCols; c++) {
                plinkoCtx.beginPath();
                plinkoCtx.arc(startX + c * colGap, rowY, 3, 0, Math.PI * 2);
                plinkoCtx.fill();
            }
        }

        // Draw Slots Dividers
        plinkoCtx.strokeStyle = 'rgba(255,255,255,0.1)';
        plinkoCtx.lineWidth = 2;
        for (let i = 1; i < PLINKO_MULTIS.length; i++) {
            plinkoCtx.beginPath();
            plinkoCtx.moveTo(i * slotWidth, h - 30);
            plinkoCtx.lineTo(i * slotWidth, h);
            plinkoCtx.stroke();
        }

        // --- Ball animation (deterministic path interpolation) ---
        const now = performance.now();
        const STEP_MS = 250;
        const LAND_MS = 180;

        plinkoBalls = plinkoBalls.filter(ball => {
            // Build waypoints once on first frame
            if (!ball._startTime) {
                ball._startTime = now;
                ball._waypoints = [{ x: ball.x, y: topPad - 20 }];

                // Find nearest col in row 1
                let col = 0;
                const r1Cols = 2;
                const r1StartX = (w - (r1Cols - 1) * colGap) / 2;
                let best = Infinity;
                for (let c = 0; c < r1Cols; c++) {
                    const d = Math.abs(ball.x - (r1StartX + c * colGap));
                    if (d < best) { best = d; col = c; }
                }

                for (let i = 0; i < PLINKO_ROWS; i++) {
                    const pos = pegPos(i + 1, col);
                    // Ball deflects to the side of the peg, not through it
                    const dir = ball.path[i] === 1 ? 1 : -1;
                    const offsetX = dir * colGap * 0.35;
                    ball._waypoints.push({
                        x: pos.x + offsetX + (Math.random() - 0.5) * 2,
                        y: pos.y + rowGap * 0.25
                    });
                    if (ball.path[i] === 1) col++;
                }

                ball._waypoints.push({ x: (ball.targetSlot + 0.5) * slotWidth, y: h - 8 });
                ball._totalSteps = ball._waypoints.length - 1;
            }

            const elapsed = now - ball._startTime;
            const totalMs = ball._totalSteps * STEP_MS + LAND_MS;

            // Landing
            if (elapsed >= totalMs && !ball.landed) {
                ball.landed = true;
                const lp = ball._waypoints[ball._waypoints.length - 1];
                ball.x = lp.x; ball.y = lp.y;

                highlightSlot(ball.targetSlot);
                if (ball.payout > 0) {
                    triggerConfetti();
                    showResult({ won: true, payout: ball.payout, betAmount: ball.betAmount, dice: [ball.dieValue] });
                } else {
                    showResult({ won: false, payout: 0, betAmount: ball.betAmount, dice: [ball.dieValue] });
                }
                if (ball.newBalance !== undefined) setBalance(ball.newBalance, true);
                if (window.haptic && hapticEnabled) haptic.notificationOccurred('success');
            }

            // Smooth Catmull-Rom spline interpolation (no per-segment stops)
            if (!ball.landed) {
                const totalDur = ball._totalSteps * STEP_MS;
                // Slight gravity easing: starts slow, accelerates
                const rawP = Math.min(elapsed / totalDur, 1);
                const progress = rawP * (2 - rawP); // ease-out quadratic for gravity feel

                const segFloat = progress * ball._totalSteps;
                const si = Math.min(Math.floor(segFloat), ball._totalSteps - 1);
                const t = segFloat - si;

                // Catmull-Rom: use 4 surrounding waypoints for smooth curve
                const wp = ball._waypoints;
                const p0 = wp[Math.max(0, si - 1)];
                const p1 = wp[si];
                const p2 = wp[Math.min(si + 1, wp.length - 1)];
                const p3 = wp[Math.min(si + 2, wp.length - 1)];

                const t2 = t * t, t3 = t2 * t;
                ball.x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
                ball.y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
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

            plinkoCtx.shadowBlur = 0;
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

            if (ball.landed) {
                if (!ball._landTime) ball._landTime = now;
                return (now - ball._landTime) < 2000;
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
        // Calculate precise landing index
        // Each segment is 30 degrees. res.index is 0..11.
        // Rotation is clockwise. Arrow is at top (0 deg).
        // To land on index I, we need to rotate -(I * 30 + 15) degrees.
        const baseRotation = (res.index * 30 + 15);
        const fullSpins = 360 * 5;
        const finalRotation = fullSpins - baseRotation;

        wheel.style.transition = 'transform 4s cubic-bezier(0.15, 0, 0.15, 1)';
        wheel.style.transform = `rotate(${finalRotation}deg)`;

        setTimeout(() => {
            isSpinning = false;
            btn.disabled = false;
            btn.textContent = 'КРУТИТЬ';

            if (res.win) {
                toast(`ПОЗДРАВЛЯЕМ! Вы выиграли ${res.prize} TON!`, 'success');
                setBalance(res.newBalance, true);
                triggerConfetti();
            } else {
                toast('В этот раз не повезло. Попробуйте завтра!', 'info');
            }

            // Reset wheel after delay to be ready for next time (visually clean)
            setTimeout(() => {
                wheel.style.transition = 'none';
                wheel.style.transform = `rotate(${-baseRotation}deg)`; // Stay on the prize
            }, 1000);
        }, 4100);

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

/** Build TON BOC (Bag of Cells) for one cell: 32-bit 0 (comment opcode) + comment text. Fixes "payload 0 index" error. */
function buildCommentBoc(comment) {
    const commentBytes = new TextEncoder().encode(comment);
    const dataLen = 4 + commentBytes.length;
    const cellBytes = new Uint8Array(2 + dataLen);
    cellBytes[0] = 1;
    cellBytes[1] = (dataLen - 1) & 0xff;
    cellBytes[2] = 0;
    cellBytes[3] = 0;
    cellBytes[4] = 0;
    cellBytes[5] = 0;
    cellBytes.set(commentBytes, 6);
    const cellLen = cellBytes.length;
    const boc = new Uint8Array(4 + 8 + 1 + cellLen);
    boc[0] = 0xb5;
    boc[1] = 0xee;
    boc[2] = 0x9c;
    boc[3] = 0x72;
    boc[4] = 0xa1;
    boc[5] = 0x01;
    boc[6] = 0x01;
    boc[7] = 0x01;
    boc[8] = 0x00;
    boc[9] = cellLen;
    boc[10] = 0x00;
    boc[11] = 0x00;
    boc.set(cellBytes, 12);
    return bytesToBase64(boc);
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

    // Show/Hide demo toggle exclusively for Dice/Plinko
    const demoToggle = document.getElementById('demo-toggle-wrap');
    if (demoToggle) {
        if (game === 'dice' || game === 'plinko') demoToggle.style.display = 'flex';
        else demoToggle.style.display = 'none';
    }

    // Config modal for game
    const diceArea = document.getElementById('dice-options-area');
    if (diceArea) {
        if (game === 'dice') {
            diceArea.classList.remove('hidden');
        } else {
            diceArea.classList.add('hidden');
        }
    }

    // Hide/Show crash options
    const crashArea = document.getElementById('crash-auto-cashout-area');
    if (crashArea) {
        if (game === 'crash') crashArea.classList.remove('hidden');
        else crashArea.classList.add('hidden');
    }

    if (game === 'dice') {
        const bType = window.betType || 'high';
        document.querySelectorAll('.bet-type-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-bet') === bType);
        });
        const exactPicker = document.getElementById('exact-picker');
        if (exactPicker) {
            exactPicker.style.display = (bType === 'exact' ? 'block' : 'none');
            exactPicker.classList.remove('hidden');
        }
        if (typeof buildExactPicker === 'function') buildExactPicker();
        if (typeof updatePayoutUI === 'function') updatePayoutUI();
    } else {
        const exactPicker = document.getElementById('exact-picker');
        if (exactPicker) exactPicker.style.display = 'none';
    }

    window.confirmBetAction = function () {
        if (activeBetGame === 'dice') {
            closeModal('bet-modal');
            roll();
        }
        else if (activeBetGame === 'crash') {
            closeModal('bet-modal');
            crashPlaceBet();
        }
        else if (activeBetGame === 'plinko') {
            closeModal('bet-modal');
            plinkoDrop();
        }
        else if (activeBetGame === 'hide') {
            closeModal('bet-modal');
            placeHideBet();
        }
    };

    // Assign to button
    const confirmBtn = document.getElementById('bet-confirm-btn');
    if (confirmBtn) confirmBtn.onclick = window.confirmBetAction;
};




// --- HIDE AND SEEK (ПРЯТКИ) ---
let hideStatus = null;
let hidePolling = null;
let hideCanvas = null;
let hideCtx = null;
let hideAnimId = null;
let lastHidePhase = null;
let lastHideStatusUpdate = 0;

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
        const data = await api('/api/hide/status');
        hideStatus = data;
        lastHideStatusUpdate = Date.now();
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
        const isHit = hideStatus.myRoom && (hideStatus.killerTargets || []).some(t => t == hideStatus.myRoom);
        if (hideStatus.myRoom) {
            const hideRes = {
                won: !isHit,
                betAmount: hideStatus.myBet?.amount || 0,
                payout: isHit ? 0 : (hideStatus.myBet?.amount || 0) * (hideStatus.myBet?.mult || 2),
                room: hideStatus.myRoom
            };
            showResult(hideRes);
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
    const visited = hideStatus._visitedHouses || new Set();

    for (let i = 1; i <= roomCount; i++) {
        const r = hideStatus.rooms[i] || [];
        const isMy = hideStatus.myRoom == i;
        // House is hit if killer has visited it (real-time) or in RESULT phase
        const wereHit = (hideStatus.phase === 'RESULT' && targets.includes(i)) ||
            (hideStatus.phase === 'SEARCHING' && visited.has(i));

        h += `<div class="room-node ${isMy ? 'active' : ''} ${r.length >= 3 ? 'full' : ''} ${wereHit ? 'hit' : ''}" onclick="selectHideRoom(${i})">
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
            const visited = hideStatus._visitedHouses || new Set();
            const wasHit = (hideStatus.phase === 'RESULT' && (hideStatus.killerTargets || []).includes(i)) ||
                (hideStatus.phase === 'SEARCHING' && visited.has(i));
            const isUserRoom = hideStatus.myRoom === i;
            drawHouse(pos.x, pos.y, i, isUserRoom, wasHit);
        }

        if (hideStatus.phase === 'SEARCHING') {
            const totalDuration = 9;
            // Use client-side interpolation for smooth movement
            const timeSinceUpdate = (Date.now() - lastHideStatusUpdate) / 1000;
            const smoothRemainingTime = Math.max(0, hideStatus.timeLeft - timeSinceUpdate);
            const elapsed = totalDuration - smoothRemainingTime;
            const targets = hideStatus.killerTargets || [];
            if (targets.length === 0) { hideAnimId = requestAnimationFrame(renderHide); return; }

            // Build waypoints from killer targets
            const waypoints = targets.map(t => {
                const p = getHousePos(t, roomCount);
                return { x: p.x + 30, y: p.y + 50 };
            });

            // Mark visited houses immediately as killer passes them
            if (!hideStatus._visitedHouses) hideStatus._visitedHouses = new Set();
            const rawProgress = Math.min(elapsed / totalDuration, 1);
            // Ease-out for gravity feel
            const progress = rawProgress * (2 - rawProgress);
            const segFloat = progress * (waypoints.length - 1);
            const si = Math.min(Math.floor(segFloat), waypoints.length - 2);

            // Mark all houses up to current index as visited
            for (let vi = 0; vi <= si; vi++) {
                hideStatus._visitedHouses.add(targets[vi]);
            }
            // Also mark current if we're past 70% into the segment
            const localT = segFloat - si;
            if (localT > 0.7 && si + 1 < targets.length) {
                hideStatus._visitedHouses.add(targets[si + 1]);
            }

            // Re-render rooms with updated hit status
            renderRoomsList();

            // Catmull-Rom spline for smooth path
            const wp = waypoints;
            const t = localT;
            const p0 = wp[Math.max(0, si - 1)];
            const p1 = wp[si];
            const p2 = wp[Math.min(si + 1, wp.length - 1)];
            const p3 = wp[Math.min(si + 2, wp.length - 1)];

            const t2 = t * t, t3 = t2 * t;
            const kX = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
            const kY = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

            // Trail particles
            hideCtx.globalAlpha = 0.15;
            for (let tp = 0; tp < 5; tp++) {
                const trailT = Math.max(0, segFloat - tp * 0.08);
                const tsi = Math.min(Math.floor(trailT), wp.length - 2);
                const tt = trailT - tsi;
                const tp0 = wp[Math.max(0, tsi - 1)], tp1 = wp[tsi];
                const tp2 = wp[Math.min(tsi + 1, wp.length - 1)], tp3 = wp[Math.min(tsi + 2, wp.length - 1)];
                const tt2 = tt * tt, tt3 = tt2 * tt;
                const tx = 0.5 * ((2 * tp1.x) + (-tp0.x + tp2.x) * tt + (2 * tp0.x - 5 * tp1.x + 4 * tp2.x - tp3.x) * tt2 + (-tp0.x + 3 * tp1.x - 3 * tp2.x + tp3.x) * tt3);
                const ty = 0.5 * ((2 * tp1.y) + (-tp0.y + tp2.y) * tt + (2 * tp0.y - 5 * tp1.y + 4 * tp2.y - tp3.y) * tt2 + (-tp0.y + 3 * tp1.y - 3 * tp2.y + tp3.y) * tt3);
                hideCtx.beginPath();
                hideCtx.arc(tx, ty, 3 - tp * 0.4, 0, Math.PI * 2);
                hideCtx.fillStyle = '#e74c3c';
                hideCtx.fill();
            }
            hideCtx.globalAlpha = 1;

            // Draw KILLER as a DICE CUBE
            hideCtx.save();
            hideCtx.translate(kX, kY);

            // Floating animation
            const hover = Math.sin(Date.now() / 250) * 5;
            hideCtx.translate(0, hover - 15);

            // Rotation based on movement
            hideCtx.rotate(segFloat * 0.3);

            const dSize = 20, dr = 5;

            // Glow
            hideCtx.shadowBlur = 30;
            hideCtx.shadowColor = 'rgba(231, 76, 60, 0.7)';

            // White dice body
            hideCtx.fillStyle = '#fff';
            hideCtx.beginPath();
            hideCtx.roundRect(-dSize / 2, -dSize / 2, dSize, dSize, dr);
            hideCtx.fill();

            // Dots (random face)
            hideCtx.shadowBlur = 0;
            hideCtx.fillStyle = '#e74c3c';
            const dp = dSize / 4, dotR = 2.2;
            const drawDot = (dx, dy) => { hideCtx.beginPath(); hideCtx.arc(dx, dy, dotR, 0, Math.PI * 2); hideCtx.fill(); };
            // Show 6 (death dice)
            drawDot(-dp, -dp); drawDot(dp, -dp);
            drawDot(-dp, 0); drawDot(dp, 0);
            drawDot(-dp, dp); drawDot(dp, dp);

            hideCtx.restore();

            // "KILLER" label above dice
            hideCtx.fillStyle = '#e74c3c';
            hideCtx.font = '900 9px "Inter", sans-serif';
            hideCtx.textAlign = 'center';
            hideCtx.fillText('💀 KILLER', kX, kY + hover - 43);
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


// Start the app
init();
