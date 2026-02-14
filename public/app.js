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
    console.log(`[API Request] ${method} ${url}`, body);
    const h = { 'Content-Type': 'application/json' };
    if (initData) h['X-Telegram-Init-Data'] = initData;
    else h['X-Dev-User-Id'] = '12345';
    const opts = { method, headers: h };
    if (body) opts.body = JSON.stringify(body);
    try {
        const res = await fetch(API + url, opts);
        console.log(`[API Response] ${url} status: ${res.status}`);
        if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            console.error(`[API Error] ${url}:`, e);
            throw new Error(e.error || 'err');
        }
        return res.json();
    } catch (err) {
        console.error(`[API Fetch Error] ${url}:`, err);
        throw err;
    }
}

// инит
async function init() {
    initTg();
    buildExactPicker();

    // TonConnect
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
        manifestUrl: window.location.origin + '/tonconnect-manifest.json',
        buttonRootId: null
    });

    tonConnectUI.onStatusChange(wallet => {
        if (wallet) {
            const addr = wallet.account.address;
            const short = addr.slice(0, 6) + '...' + addr.slice(-4);
            document.getElementById('ton-connect').classList.add('connected');
            toast('Кошелёк подключен', 'success');
        } else {
            document.getElementById('ton-connect').classList.remove('connected');
        }
    });

    try {
        const data = await api('/api/auth', 'POST');
        user = data.user;
        curSeeds = data.seeds;

        // Показываем инфо юзера
        document.getElementById('user-name').textContent = user.username || user.firstName || 'Player';
        document.getElementById('user-id').textContent = 'ID: ' + user.telegramId;
        document.getElementById('user-initial').textContent = (user.firstName || user.username || 'P')[0].toUpperCase();

        setBalance(user.balance);

        loadHistory();
        loadGifts();

        // Инит обработчиков кнопок
        initEventListeners();

        // прячем лоадер
        setTimeout(() => {
            document.getElementById('loading-screen').classList.add('fade-out');
            setTimeout(() => {
                document.getElementById('loading-screen').style.display = 'none';
                document.getElementById('app').classList.remove('hidden');
            }, 800);
        }, 1500);

    } catch (e) {
        toast('Ошибка входа: ' + e.message, 'error');
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
};

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
    if (betType === 'high' || betType === 'low' || betType === 'even' || betType === 'odd') mult = 1.95;
    if (betType === 'seven') mult = 3.5;
    if (betType === 'doubles') mult = 5.0;
    if (betType === 'exact') mult = 11.0;
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

    // Кнопка подтверждения ставки (داخل модалки)
    const confirmBtn = document.getElementById('roll-btn-confirm');
    if (confirmBtn) confirmBtn.onclick = roll;

    // Инпуты
    document.getElementById('bet-amount').oninput = updatePayoutUI;

    // Seeds & Verify (Repairing broken functionality)
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

            // Прокрутка вниз, чтобы увидеть результат
            setTimeout(() => {
                revealBlock.scrollIntoView({ behavior: 'smooth', block: 'end' });
                const container = revealBlock.closest('.tab-scrollable');
                if (container) {
                    container.scrollTop = container.scrollHeight;
                } else {
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                }
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

    // Close modal to show animation
    document.getElementById('bet-modal').classList.add('hidden');

    rolling = true;
    document.getElementById('open-bet-modal-btn').disabled = true; // Disable main button
    if (window.haptic) haptic.impactOccurred('medium');

    try {
        const payload = { betAmount: amt, betType: betType };
        if (betType === 'exact') payload.exactNumber = exactNum;

        const res = await api('/api/bet', 'POST', payload);

        // анимация
        animateDice(res.result.dice);

        // Показ результата СТРОГО после анимации
        setTimeout(() => {
            user.balance = res.result.newBalance;
            setBalance(user.balance, true);
            showResult(res.result);
            rolling = false;
            document.getElementById('open-bet-modal-btn').disabled = false;

            // Update seeds display
            if (res.fairness) {
                document.getElementById('server-seed-hash').textContent = res.fairness.serverSeedHash;
                document.getElementById('nonce-value').textContent = res.fairness.nonce;
            }

        }, 1500); // 1.5s - sync with CSS transition + buffer

    } catch (e) {
        toast(e.message, 'error');
        rolling = false;
        document.getElementById('open-bet-modal-btn').disabled = false;
    }
};

function animateDice(vals) {
    const d1 = document.getElementById('die1');
    const d2 = document.getElementById('die2');

    // Сбрасываем предыдущее вращение (add some random for 'strange' effect)
    d1.style.transition = 'none';
    d2.style.transition = 'none';
    d1.style.transform = `rotateX(${Math.random() * 360}deg) rotateY(${Math.random() * 360}deg)`;
    d2.style.transform = `rotateX(${Math.random() * 360}deg) rotateY(${Math.random() * 360}deg)`;

    void d1.offsetWidth; // force reflow

    d1.style.transition = 'transform 1.2s cubic-bezier(0.15, 0.6, 0.3, 1)';
    d2.style.transition = 'transform 1.2s cubic-bezier(0.15, 0.6, 0.3, 1)';

    setDiceFace(d1, vals[0]);
    setDiceFace(d2, vals[1]);
}

function setDiceFace(el, val) {
    // Correct rotations based on index.html mapping
    const rotations = {
        1: 'rotateX(0deg) rotateY(0deg)',     // front
        2: 'rotateX(-90deg) rotateY(0deg)',   // top
        3: 'rotateX(0deg) rotateY(-90deg)',   // right
        4: 'rotateX(0deg) rotateY(90deg)',    // left
        5: 'rotateX(90deg) rotateY(0deg)',    // bottom
        6: 'rotateX(0deg) rotateY(180deg)'    // back
    };

    // Add small random offset for "real feel"
    const offX = (Math.random() - 0.5) * 4;
    const offY = (Math.random() - 0.5) * 4;

    el.style.transform = rotations[val] || 'rotateX(0deg)';
}

function showResult(res) {
    const ov = document.getElementById('result-overlay');
    const title = document.getElementById('result-title');
    const amt = document.getElementById('result-amount');
    const diceDisp = document.getElementById('result-dice-display');

    ov.classList.remove('hidden');
    title.textContent = res.won ? 'Победа!' : 'Проигрыш';
    title.className = 'result-title ' + (res.won ? 'win' : 'loss');
    amt.textContent = (res.won ? '+' : '-') + res.payout.toFixed(2) + ' TON';
    amt.className = 'result-amount ' + (res.won ? 'win' : 'loss');

    diceDisp.innerHTML = res.dice.map(v => `<div class="result-die-box">${v}</div>`).join('');

    if (res.won && window.haptic) haptic.notificationOccurred('success');

    document.getElementById('result-close').onclick = () => ov.classList.add('hidden');
}

// Подарки
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
            const buyBtn = card.querySelector('.gift-buy-btn');
            buyBtn.onclick = () => window.openBuyModal(g.id, g.title, g.price);
            list.appendChild(card);
        });
    } catch (e) {
        console.error('loadGifts error:', e);
    }
}
window.loadGifts = loadGifts;

let currentBuyId = null;
let currentBuyPrice = 0;

window.openBuyModal = function (id, name, price) {
    console.log('Opening buy modal for:', id, name, price);
    currentBuyId = id;
    currentBuyPrice = parseFloat(price);
    document.getElementById('modal-gift-name').textContent = name;
    document.getElementById('modal-gift-price').textContent = price;
    document.getElementById('purchase-modal').classList.remove('hidden');

    const confirmBtn = document.getElementById('modal-confirm-buy');
    confirmBtn.onclick = () => window.confirmPurchase(id);
};

async function confirmPurchase(id) {
    console.log('Confirming purchase for ID:', id);
    if (user.balance < currentBuyPrice) {
        console.warn('Insufficient balance:', user.balance, '<', currentBuyPrice);
        return toast('Недостаточно TON для покупки', 'error');
    }

    try {
        const btn = document.getElementById('modal-confirm-buy');
        btn.disabled = true;
        btn.textContent = '...';

        console.log('Sending purchase request to server...');
        const res = await api('/api/gifts/buy', 'POST', { giftId: id });
        console.log('Purchase response:', res);

        user.balance = res.newBalance;
        setBalance(user.balance, true);
        toast('Покупка успешна!', 'success');
        closeModal('purchase-modal');
        loadGifts();
    } catch (e) {
        console.error('Purchase error:', e);
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
        list.innerHTML = res.games.length ? res.games.map(g => `
            <div class="history-item">
                <div class="hist-left">
                    <div class="hist-type">${g.player_choice.toUpperCase()}</div>
                    <div class="hist-time">${new Date(g.created_at).toLocaleTimeString()}</div>
                </div>
                <div class="hist-res ${g.won ? 'win' : 'loss'}">${g.won ? '+' : ''}${g.payout.toFixed(2)}</div>
            </div>
        `).join('') : '<div class="empty-state">Нет игр</div>';
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

// Депозиты
window.depositRequest = async function () {
    console.log('Deposit request triggered');
    if (!tonConnectUI.connected) {
        console.warn('Wallet not connected');
        toast('Сначала подключите кошелёк', 'info');
        await tonConnectUI.openModal();
        return;
    }

    const amountEl = document.getElementById('dep-amount');
    const amountVal = amountEl ? amountEl.value : null;

    if (!amountVal || parseFloat(amountVal) < 0.1) {
        console.warn('Invalid amount:', amountVal);
        return toast('Мин. сумма 0.1 TON', 'error');
    }

    try {
        const btn = document.getElementById('dep-btn-go');
        btn.disabled = true;
        btn.textContent = '...';

        console.log('Requesting deposit from server for amount:', amountVal);
        const res = await api('/api/deposit/request', 'POST', { amount: parseFloat(amountVal) });
        console.log('Server deposit response:', res);

        if (!res.address || res.address.includes('...')) {
            throw new Error('Адрес кошелька для приема платежа не настроен в .env! (TON_WALLET)');
        }

        const depositComment = (res.comment || '').trim();
        if (!depositComment) {
            throw new Error('Сервер не вернул комментарий депозита. Попробуйте снова.');
        }

        toast('Заявка создана. Подтвердите в кошельке!', 'success');

        // Вызываем транзакцию через TonConnect
        try {
            console.log('Preparing TON transaction payload...');
            let payload = null;
            if (typeof TonWeb !== 'undefined') {
                const cell = new TonWeb.boc.Cell();
                cell.bits.writeUint(0, 32);
                cell.bits.writeString(depositComment);
                const boc = await cell.toBoc();
                payload = TonWeb.utils.bytesToBase64(boc);
                console.log('Generated payload BOC:', payload);
            }

            const nanoAmount = (BigInt(Math.round(parseFloat(amountVal) * 1e9))).toString();
            const message = {
                address: res.address,
                amount: nanoAmount
            };

            if (!payload) {
                throw new Error('Не удалось сформировать комментарий для TonConnect оплаты');
            }
            message.payload = payload;

            const transaction = {
                validUntil: Math.floor(Date.now() / 1000) + 360,
                messages: [message]
            };

            // Если мы в Telegram, пробуем сначала через sendTransaction
            const txResult = await tonConnectUI.sendTransaction(transaction);
            console.log('Transaction sent successfully!', txResult);
            toast('Транзакция отправлена! Ожидаем подтверждение сети...', 'success');

            const waitDeposit = async () => {
                for (let i = 0; i < 15; i++) {
                    await new Promise((r) => setTimeout(r, 4000));
                    const check = await api('/api/deposit/check');
                    const hasPending = Array.isArray(check.pending) && check.pending.some((d) => d.comment === depositComment);
                    if (!hasPending) {
                        const authState = await api('/api/auth', 'POST');
                        user = authState.user;
                        setBalance(user.balance, true);
                        toast('Пополнение подтверждено и зачислено!', 'success');
                        return;
                    }
                }
                toast('Платёж отправлен. Начисление может занять до 1-2 минут.', 'info');
            };

            waitDeposit().catch((err) => {
                console.error('Deposit status check failed:', err);
            });
        } catch (txErr) {
            console.error('TonConnect TX Error:', txErr);

            // Резервный вариант: Deep Link (прямая ссылка для оплаты)
            const nanoAmount = (BigInt(Math.round(parseFloat(amountVal) * 1e9))).toString();
            const deepLink = `ton://transfer/${res.address}?amount=${nanoAmount}&text=${encodeURIComponent(depositComment)}`;
            console.log('Generated deep link:', deepLink);

            // Показываем кнопку-ссылку, если авто-платеж не сработал
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal-box">
                    <h3 class="modal-title">Не удалось открыть кошелёк автоматически</h3>
                    <p class="modal-desc">Нажмите кнопку ниже, чтобы оплатить через мобильный кошелёк (Tonkeeper и др.)</p>
                    <a href="${deepLink}" class="roll-button main-action" style="text-decoration:none; display:block; margin-bottom:12px;">ОПЛАТИТЬ ЧЕРЕЗ ССЫЛКУ</a>
                    <button class="modal-btn cancel" onclick="this.closest('.modal-overlay').remove()">Закрыть</button>
                </div>
            `;
            document.body.appendChild(modal);
            toast('Используйте ссылку для оплаты', 'info');
        }

    } catch (e) {
        console.error('Deposit request failed:', e);
        toast(e.message, 'error');
    } finally {
        const btn = document.getElementById('dep-btn-go');
        btn.disabled = false;
        btn.textContent = 'ПОПОЛНИТЬ';
    }
};

window.copyText = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    const txt = el.textContent || el.innerText;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(() => {
            toast('Скопировано!', 'success');
        });
    } else {
        const textArea = document.createElement("textarea");
        textArea.value = txt;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            toast('Скопировано!', 'success');
        } catch (err) { }
        document.body.removeChild(textArea);
    }
};

document.addEventListener('DOMContentLoaded', init);
