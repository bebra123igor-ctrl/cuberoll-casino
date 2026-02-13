// cuberoll frontend

const API = '';
let tg = null, initData = '';
let user = null, settings = {}, curSeeds = {};
let betType = 'high';
let exactNum = 7;
let rangeMin = 2, rangeMax = 6;
let rolling = false;
let streak = 0;
let dailyClaimed = false;

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
    const res = await fetch(API + url, opts);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'err'); }
    return res.json();
}

// инит
async function init() {
    initTg();
    buildExactPicker();

    try {
        const d = await api('/api/auth', 'POST');
        user = d.user;
        settings = d.settings;
        curSeeds = d.seeds;
        checkDaily();
        render();

        setTimeout(() => {
            document.getElementById('loading-screen').classList.add('fade-out');
            setTimeout(() => {
                document.getElementById('loading-screen').style.display = 'none';
                document.getElementById('app').classList.remove('hidden');
            }, 800);
        }, 2200);
    } catch (e) {
        console.error(e);
        document.querySelector('.loading-sub').textContent = 'ошибка подключения';
    }
}

function render() {
    if (!user) return;
    document.getElementById('user-name').textContent = user.firstName || user.username || 'Player';
    document.getElementById('user-id').textContent = 'ID: ' + user.telegramId;
    document.getElementById('user-initial').textContent = (user.firstName || user.username || '?')[0].toUpperCase();
    setBalance(user.balance);

    if (curSeeds) {
        document.getElementById('server-seed-hash').textContent = curSeeds.serverSeedHash || '—';
        document.getElementById('client-seed-input').value = curSeeds.clientSeed || '';
        document.getElementById('nonce-value').textContent = curSeeds.nonce || '0';
    }
    updateStreak();
    calcWin();
}

function setBalance(val, anim) {
    const el = document.getElementById('balance-amount');
    const wrap = document.getElementById('balance-display');
    if (anim) {
        const old = parseFloat(el.textContent);
        animNum(el, old, val, 800);
        wrap.classList.add(val > old ? 'pulse' : 'pulse-loss');
        setTimeout(() => wrap.classList.remove('pulse', 'pulse-loss'), 500);
    } else {
        el.textContent = val.toFixed(2);
    }
}

function animNum(el, from, to, dur) {
    const start = performance.now();
    const diff = to - from;
    (function tick(now) {
        const t = Math.min((now - start) / dur, 1);
        const ease = 1 - Math.pow(1 - t, 4);
        el.textContent = (from + diff * ease).toFixed(2);
        if (t < 1) requestAnimationFrame(tick);
    })(performance.now());
}

// стрик
function updateStreak() {
    const badge = document.getElementById('streak-badge');
    const mult = document.getElementById('streak-mult');
    document.getElementById('streak-count').textContent = streak;

    if (streak >= 2) {
        badge.classList.add('visible');
        const m = 1 + streak * 0.05;
        mult.textContent = '×' + m.toFixed(2);
        mult.classList.add('visible');
    } else {
        badge.classList.remove('visible');
        mult.classList.remove('visible');
    }
}

// дейли бонус
function checkDaily() {
    const last = localStorage.getItem('cuberoll_daily');
    const today = new Date().toDateString();
    if (last === today) {
        dailyClaimed = true;
        document.getElementById('daily-bonus').classList.add('claimed');
        document.getElementById('daily-label').textContent = 'Бонус получен';
        document.getElementById('daily-desc').textContent = 'Приходи завтра';
        document.getElementById('daily-amount').textContent = '✓';
    }
}

window.claimDaily = async function () {
    if (dailyClaimed) return;
    try {
        const bonus = parseInt(settings.dailyBonus) || 500;
        // клиентский бонус (на сервере тоже нужно поддержать)
        user.balance += bonus;
        setBalance(user.balance, true);
        dailyClaimed = true;
        localStorage.setItem('cuberoll_daily', new Date().toDateString());
        document.getElementById('daily-bonus').classList.add('claimed');
        document.getElementById('daily-label').textContent = 'Бонус получен';
        document.getElementById('daily-desc').textContent = 'Приходи завтра';
        document.getElementById('daily-amount').textContent = '✓';
        toast('+' + bonus + ' монет!', 'success');
        hOk();
    } catch (e) { toast(e.message, 'error'); }
};

// exact picker
function buildExactPicker() {
    const cont = document.getElementById('exact-nums');
    // суммы от 2 до 12
    const payouts = { 2: 36, 3: 18, 4: 12, 5: 9, 6: 7.2, 7: 6, 8: 7.2, 9: 9, 10: 12, 11: 18, 12: 36 };
    let html = '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px">';
    for (let i = 2; i <= 12; i++) {
        html += `<button class="quick-bet ${i === 7 ? 'active' : ''}" data-exact="${i}" onclick="pickExact(${i})" style="padding:8px 2px">
      <div style="font-size:13px;font-weight:800;color:var(--t1)">${i}</div>
      <div style="font-size:9px;color:var(--gold);font-weight:700">×${payouts[i]}</div>
    </button>`;
    }
    html += '</div>';
    cont.innerHTML = html;
}

window.pickExact = function (n) {
    exactNum = n;
    document.querySelectorAll('#exact-nums .quick-bet').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-exact="${n}"]`).classList.add('active');
    calcWin();
    hLight();
};

// range picker
document.getElementById('range-min')?.addEventListener('input', updateRange);
document.getElementById('range-max')?.addEventListener('input', updateRange);

function updateRange() {
    rangeMin = Math.max(2, Math.min(12, parseInt(document.getElementById('range-min').value) || 2));
    rangeMax = Math.max(rangeMin, Math.min(12, parseInt(document.getElementById('range-max').value) || 12));
    // рассчитать множитель по вероятности
    const totalCombos = 36;
    let winCombos = 0;
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) {
        const s = a + b;
        if (s >= rangeMin && s <= rangeMax) winCombos++;
    }
    const prob = winCombos / totalCombos;
    const mult = prob > 0 ? (0.95 / prob) : 0;
    document.getElementById('range-mult').textContent = '×' + mult.toFixed(2);
    calcWin();
}

// навигация
window.switchTab = function (name) {
    document.querySelectorAll('.nav-tab').forEach(t => {
        t.classList.remove('active');
        if (t.dataset.tab === name) t.classList.add('active');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('content-' + name).classList.add('active');

    if (name === 'history') loadHistory();
    if (name === 'leaderboard') loadTop();
    if (name === 'shop') loadGifts();
    hLight();
};

document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// выбор ставки
document.querySelectorAll('.bet-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.bet-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        betType = btn.dataset.bet;

        // показать/скрыть пикеры
        document.getElementById('exact-picker').style.display = betType === 'exact' ? 'block' : 'none';
        document.getElementById('range-picker').style.display = betType === 'range' ? 'block' : 'none';

        calcWin();
        hLight();
    });
});

// сумма
const betInput = document.getElementById('bet-amount');
document.getElementById('btn-half').addEventListener('click', () => {
    betInput.value = Math.max(settings.minBet || 10, ~~(parseInt(betInput.value) / 2));
    calcWin(); hLight();
});
document.getElementById('btn-double').addEventListener('click', () => {
    betInput.value = Math.min(settings.maxBet || 10000, parseInt(betInput.value) * 2, user?.balance || 0);
    calcWin(); hLight();
});
betInput.addEventListener('input', calcWin);

document.querySelectorAll('.quick-bet[data-amount]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.quick-bet[data-amount]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const a = btn.dataset.amount;
        betInput.value = a === 'max' ? Math.min(user?.balance || 0, settings.maxBet || 10000) : parseInt(a);
        calcWin(); hLight();
    });
});

function getMultiplier() {
    const exactPayouts = { 2: 36, 3: 18, 4: 12, 5: 9, 6: 7.2, 7: 6, 8: 7.2, 9: 9, 10: 12, 11: 18, 12: 36 };
    if (betType === 'exact') return exactPayouts[exactNum] || 6;
    if (betType === 'range') {
        let w = 0;
        for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) { if (a + b >= rangeMin && a + b <= rangeMax) w++; }
        return w > 0 ? parseFloat((0.95 / (w / 36)).toFixed(2)) : 0;
    }
    const m = { high: 1.95, low: 1.95, seven: 3.5, even: 1.9, odd: 1.9, doubles: 5.0 };
    return m[betType] || 1.95;
}

function calcWin() {
    const bet = parseFloat(betInput.value) || 0;
    const mult = getMultiplier();
    const streakBonus = streak >= 2 ? 1 + streak * 0.05 : 1;
    document.getElementById('potential-amount').textContent = (bet * mult * streakBonus).toFixed(2);
}

// повороты кубика
const diceRot = {
    1: { x: 0, y: 0 }, 2: { x: -90, y: 0 }, 3: { x: 0, y: -90 },
    4: { x: 0, y: 90 }, 5: { x: 90, y: 0 }, 6: { x: 180, y: 0 }
};

// бросок
const rollBtn = document.getElementById('roll-btn');
rollBtn.addEventListener('click', async () => {
    if (rolling) return;
    const amt = parseFloat(betInput.value);
    if (!amt || amt < (settings.minBet || 10)) { toast('Мин. ставка: ' + (settings.minBet || 10), 'error'); return; }
    if (amt > (user?.balance || 0)) { toast('Недостаточно средств', 'error'); hErr(); return; }

    rolling = true;
    rollBtn.disabled = true;
    rollBtn.classList.add('rolling');
    rollBtn.querySelector('.roll-text').textContent = 'БРОСАЮ...';

    const d1 = document.getElementById('die1');
    const d2 = document.getElementById('die2');
    const s1 = document.querySelector('.shadow-1');
    const s2 = document.querySelector('.shadow-2');

    d1.style.transform = '';
    d2.style.transform = '';
    s1.classList.add('flying');
    s2.classList.add('flying');

    d1.classList.add('rolling');
    setTimeout(() => d2.classList.add('rolling'), 100);
    hMed();

    try {
        // для новых типов ставок добавляем параметры
        const body = { betAmount: amt, betType };
        if (betType === 'exact') body.exactNumber = exactNum;
        if (betType === 'range') { body.rangeMin = rangeMin; body.rangeMax = rangeMax; }

        const data = await api('/api/bet', 'POST', body);
        await sleep(1500);

        d1.classList.remove('rolling');
        d2.classList.remove('rolling');
        s1.classList.remove('flying');
        s2.classList.remove('flying');

        const v1 = data.result.dice[0], v2 = data.result.dice[1];
        d1.style.transform = `rotateX(${diceRot[v1].x}deg) rotateY(${diceRot[v1].y}deg)`;
        d2.style.transform = `rotateX(${diceRot[v2].x}deg) rotateY(${diceRot[v2].y}deg)`;

        // стрик
        if (data.result.won) {
            streak++;
        } else {
            streak = 0;
        }
        updateStreak();

        user.balance = data.result.newBalance;
        setBalance(data.result.newBalance, true);
        curSeeds.nonce = data.fairness.nonce;
        document.getElementById('nonce-value').textContent = data.fairness.nonce;

        setTimeout(() => showResult(data.result), 500);
        data.result.won ? hOk() : hErr();
    } catch (e) {
        d1.classList.remove('rolling');
        d2.classList.remove('rolling');
        s1.classList.remove('flying');
        s2.classList.remove('flying');
        toast(e.message, 'error');
        hErr();
    }

    rolling = false;
    rollBtn.disabled = false;
    rollBtn.classList.remove('rolling');
    rollBtn.querySelector('.roll-text').textContent = 'БРОСИТЬ КОСТИ';
    calcWin();
});

function showResult(r) {
    const ov = document.getElementById('result-overlay');
    const modal = ov.querySelector('.result-modal');
    modal.className = 'result-modal ' + (r.won ? 'win' : 'loss');

    // svg иконки вместо эмодзи
    const iconWrap = document.getElementById('result-icon-wrap');
    if (r.won) {
        iconWrap.innerHTML = `<svg class="result-icon-svg" viewBox="0 0 48 48" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="20"/><path d="M16 24l5 5 11-11"/></svg>`;
    } else {
        iconWrap.innerHTML = `<svg class="result-icon-svg" viewBox="0 0 48 48" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="20"/><line x1="16" y1="16" x2="32" y2="32"/><line x1="32" y1="16" x2="16" y2="32"/></svg>`;
    }

    const title = document.getElementById('result-title');
    title.textContent = r.won ? 'Победа!' : 'Мимо';
    title.className = 'result-title ' + (r.won ? 'win' : 'loss');

    const amt = document.getElementById('result-amount');
    amt.textContent = r.won ? ('+' + r.payout.toFixed(2)) : ('-' + Math.abs(r.profit).toFixed(2));
    amt.className = 'result-amount ' + (r.won ? 'win' : 'loss');

    // кубики как квадратики с числами
    document.getElementById('result-dice-display').innerHTML =
        r.dice.map(d => `<div class="result-die-box">${d}</div>`).join('');

    // стрик текст
    const streakEl = document.getElementById('result-streak');
    if (r.won && streak >= 2) {
        streakEl.textContent = 'Стрик ×' + streak + ' — бонус ×' + (1 + streak * 0.05).toFixed(2);
        streakEl.classList.add('visible');
    } else {
        streakEl.classList.remove('visible');
    }

    if (r.won) confetti();
    ov.classList.remove('hidden');
}

document.getElementById('result-close').addEventListener('click', () => document.getElementById('result-overlay').classList.add('hidden'));
document.getElementById('result-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) document.getElementById('result-overlay').classList.add('hidden'); });

function confetti() {
    const colors = ['#c8a55a', '#4caf50', '#e0c278', '#888', '#555'];
    for (let i = 0; i < 30; i++) {
        const c = document.createElement('div');
        c.className = 'confetti-piece';
        c.style.left = Math.random() * 100 + '%';
        c.style.top = '-6px';
        c.style.background = colors[~~(Math.random() * colors.length)];
        c.style.animationDelay = Math.random() * .3 + 's';
        const sz = 4 + Math.random() * 5;
        c.style.width = sz + 'px'; c.style.height = sz + 'px';
        c.style.borderRadius = Math.random() > .5 ? '50%' : '1px';
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 3000);
    }
}

// история
async function loadHistory() {
    try {
        const d = await api('/api/history');
        const list = document.getElementById('history-list');
        if (!d.games?.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg></div><p>Пока пусто</p></div>'; return; }

        const names = { high: 'Больше', low: 'Меньше', seven: 'Семёрка', even: 'Чётное', odd: 'Нечётное', doubles: 'Дубль', exact: 'Точно', range: 'Диапазон' };

        list.innerHTML = d.games.map((g, i) => {
            const dice = g.dice_result.split(',').map(Number);
            const w = g.won === 1;
            const time = new Date(g.created_at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            return `<div class="history-item" style="animation-delay:${i * .03}s">
        <div class="history-left">
          <div class="history-dice-dots">${dice.map(d => `<div class="history-die">${d}</div>`).join('')}</div>
          <div class="history-details">
            <span class="history-bet-type">${names[g.player_choice] || g.player_choice} (${g.dice_total})</span>
            <span class="history-time">${time}</span>
          </div>
        </div>
        <div class="history-right">
          <div class="history-amount ${w ? 'win' : 'loss'}">${w ? '+' + g.payout.toFixed(2) : '-' + g.bet_amount.toFixed(2)}</div>
          <div class="history-bet">${g.bet_amount.toFixed(2)}</div>
        </div>
      </div>`;
        }).join('');
    } catch (e) { console.error(e); }
}

async function loadTop() {
    try {
        const d = await api('/api/leaderboard');
        const list = document.getElementById('leaderboard-list');
        if (!d.players?.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg></div><p>Пусто</p></div>'; return; }
        list.innerHTML = d.players.map((p, i) => `
      <div class="leaderboard-item ${i < 3 ? 'top-3' : ''}" style="animation-delay:${i * .03}s">
        <div class="leaderboard-rank">${i + 1}</div>
        <div class="leaderboard-info">
          <span class="leaderboard-name">${p.username || 'Аноним'}</span>
          <span class="leaderboard-stats">${p.gamesPlayed} игр · ${p.gamesWon} побед</span>
        </div>
        <span class="leaderboard-balance">${p.balance.toFixed(0)}</span>
      </div>
    `).join('');
    } catch (e) { console.error(e); }
}

// сиды
document.getElementById('btn-update-seed').addEventListener('click', async () => {
    const s = document.getElementById('client-seed-input').value.trim();
    if (!s) { toast('Введи seed', 'error'); return; }
    try { await api('/api/seeds/client', 'POST', { clientSeed: s }); curSeeds.clientSeed = s; toast('Обновлено', 'success'); hOk(); }
    catch (e) { toast(e.message, 'error'); }
});

document.getElementById('btn-rotate-seed').addEventListener('click', async () => {
    try {
        const d = await api('/api/seeds/rotate', 'POST', { clientSeed: document.getElementById('client-seed-input').value.trim() || undefined });
        document.getElementById('old-server-seed').textContent = d.oldServerSeed;
        document.getElementById('old-server-hash').textContent = d.oldServerSeedHash;
        document.getElementById('old-seed-reveal').style.display = 'block';
        document.getElementById('server-seed-hash').textContent = d.newServerSeedHash;
        document.getElementById('nonce-value').textContent = d.nonce;
        curSeeds = { serverSeedHash: d.newServerSeedHash, clientSeed: d.clientSeed, nonce: d.nonce };
        toast('Seed раскрыт', 'success'); hOk();
    } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('btn-verify').addEventListener('click', async () => {
    const ss = document.getElementById('verify-server-seed').value.trim();
    const cs = document.getElementById('verify-client-seed').value.trim();
    const n = document.getElementById('verify-nonce').value;
    if (!ss || !cs || n === '') { toast('Заполни все поля', 'error'); return; }
    try {
        const d = await api('/api/verify', 'POST', { serverSeed: ss, clientSeed: cs, nonce: parseInt(n) });
        document.getElementById('verify-dice').textContent = d.dice.join(' + ') + ' = ' + d.total;
        document.getElementById('verify-total').textContent = d.total;
        document.getElementById('verify-hash').textContent = d.serverSeedHash;
        document.getElementById('verify-result').style.display = 'block';
        toast('Проверено', 'success');
    } catch (e) { toast(e.message, 'error'); }
});

// haptic
function hLight() { try { window.haptic?.impactOccurred?.('light'); } catch (e) { } }
function hMed() { try { window.haptic?.impactOccurred?.('medium'); } catch (e) { } }
function hOk() { try { window.haptic?.notificationOccurred?.('success'); } catch (e) { } }
function hErr() { try { window.haptic?.notificationOccurred?.('error'); } catch (e) { } }

function toast(msg, type) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// подарки
async function loadGifts() {
    const list = document.getElementById('shop-list');
    try {
        const d = await api('/api/gifts');
        if (!d.gifts?.length) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/></svg></div><p>Подарков пока нет</p></div>';
            return;
        }
        list.innerHTML = d.gifts.map(g => `
      <div class="shop-item" onclick="openGift(${g.id})">
        <div class="gift-preview" style="background:${g.background || 'var(--bg2)'}">
          <img src="${g.model}" class="gift-model">
          <div class="gift-symbol">${g.symbol || ''}</div>
        </div>
        <div class="shop-item-info">
          <div class="shop-item-name">${g.title}</div>
          <div class="shop-item-price">${g.price} C</div>
        </div>
      </div>
    `).join('');
    } catch (e) { console.error(e); }
}

window.openGift = async function (id) {
    // красивое окно выбора подарка (результат оверлей переиспользуем или новый модал)
    toast('Загрузка подарка...', 'info');
    try {
        const g = await api('/api/gifts/' + id);
        if (confirm(`Купить "${g.title}" за ${g.price} монет?`)) {
            const res = await api('/api/gifts/buy', 'POST', { giftId: id });
            user.balance = res.newBalance;
            setBalance(user.balance, true);
            toast('Подарок куплен!', 'success');
            hOk();
        }
    } catch (e) { toast(e.message, 'error'); }
};

window.connectWallet = function () {
    // тут должен быть TonConnect, пока симуляция
    const addr = 'EQB...z4z';
    document.getElementById('wallet-address').textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
    toast('Кошелёк привязан', 'success');
    hOk();
};

window.deposit = async function (amount) {
    toast(`Переходим к оплате ${amount} TON...`, 'info');
    // симуляция пополнения через бота/инвойс
    setTimeout(async () => {
        const bonus = amount * 1000; // курс 1 TON = 1000 монет
        user.balance += bonus;
        setBalance(user.balance, true);
        toast(`Баланс пополнен на ${bonus} монет`, 'success');
        hOk();
    }, 2000);
};

// парсинг ссылки (для админки)
async function parseGiftLink(url) {
    // эмуляция парсинга
    return {
        model: 'https://i.imgur.com/8YvYyZp.png',
        background: 'radial-gradient(circle, #333, #000)',
        symbol: '💎'
    };
}

document.addEventListener('DOMContentLoaded', init);
