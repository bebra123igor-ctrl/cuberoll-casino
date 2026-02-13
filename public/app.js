// cuberoll

const API = '';
let tg = null, initData = '';
let user = null, settings = {}, curSeeds = {};
let betType = 'high';
let rolling = false;

function initTg() {
    if (window.Telegram && window.Telegram.WebApp) {
        tg = window.Telegram.WebApp;
        tg.expand(); tg.ready();
        try { tg.setHeaderColor('#121212'); tg.setBackgroundColor('#121212'); } catch (e) { }
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
    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || 'err ' + res.status);
    }
    return res.json();
}

async function init() {
    initTg();
    mkParticles();

    try {
        const d = await api('/api/auth', 'POST');
        user = d.user;
        settings = d.settings;
        curSeeds = d.seeds;
        render();

        setTimeout(() => {
            document.getElementById('loading-screen').classList.add('fade-out');
            setTimeout(() => {
                document.getElementById('loading-screen').style.display = 'none';
                document.getElementById('app').classList.remove('hidden');
            }, 800);
        }, 2000);
    } catch (e) {
        console.error(e);
        document.querySelector('.loading-subtitle').textContent = 'Connection error';
    }
}

function mkParticles() {
    const c = document.getElementById('loading-particles');
    for (let i = 0; i < 20; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.left = Math.random() * 100 + '%';
        p.style.animationDelay = Math.random() * 5 + 's';
        p.style.animationDuration = (4 + Math.random() * 4) + 's';
        c.appendChild(p);
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
    calcWin();
}

function setBalance(val, anim) {
    const el = document.getElementById('balance-amount');
    const wrap = document.getElementById('balance-display');
    if (anim) {
        const old = parseFloat(el.textContent);
        animNum(el, old, val, 800);
        wrap.classList.add(val > old ? 'pulse' : 'pulse-loss');
        setTimeout(() => { wrap.classList.remove('pulse', 'pulse-loss'); }, 500);
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

// навигация
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('content-' + name).classList.add('active');
        if (name === 'history') loadHistory();
        if (name === 'leaderboard') loadTop();
        hLight();
    });
});

// тип ставки
document.querySelectorAll('.bet-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.bet-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        betType = btn.dataset.bet;
        calcWin();
        hLight();
    });
});

// управление суммой
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

document.querySelectorAll('.quick-bet').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.quick-bet').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const a = btn.dataset.amount;
        betInput.value = a === 'max' ? Math.min(user?.balance || 0, settings.maxBet || 10000) : parseInt(a);
        calcWin(); hLight();
    });
});

function calcWin() {
    const bet = parseFloat(betInput.value) || 0;
    const mults = { high: 1.95, low: 1.95, seven: 3.5, even: 1.9, odd: 1.9, doubles: 5.0 };
    document.getElementById('potential-amount').textContent = (bet * (mults[betType] || 1.95)).toFixed(2);
}

// бросок кубиков
const rollBtn = document.getElementById('roll-btn');

// маппинг поворотов для каждого значения
const diceRotations = {
    1: { x: 0, y: 0 },
    2: { x: -90, y: 0 },
    3: { x: 0, y: -90 },
    4: { x: 0, y: 90 },
    5: { x: 90, y: 0 },
    6: { x: 180, y: 0 }
};

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

    // сброс позиции и запуск анимации
    d1.style.transform = '';
    d2.style.transform = '';

    // небольшая задержка для второго кубика
    d1.classList.add('rolling');
    setTimeout(() => d2.classList.add('rolling'), 80);
    hMed();

    try {
        const data = await api('/api/bet', 'POST', { betAmount: amt, betType });

        // ждём пока анимация доиграет
        await sleep(1300);

        d1.classList.remove('rolling');
        d2.classList.remove('rolling');

        // ставим кубики на финальное значение
        const val1 = data.result.dice[0];
        const val2 = data.result.dice[1];
        const r1 = diceRotations[val1];
        const r2 = diceRotations[val2];

        d1.style.transform = `rotateX(${r1.x}deg) rotateY(${r1.y}deg)`;
        d2.style.transform = `rotateX(${r2.x}deg) rotateY(${r2.y}deg)`;

        user.balance = data.result.newBalance;
        setBalance(data.result.newBalance, true);
        curSeeds.nonce = data.fairness.nonce;
        document.getElementById('nonce-value').textContent = data.fairness.nonce;

        setTimeout(() => showResult(data.result), 500);
        data.result.won ? hOk() : hErr();
    } catch (e) {
        d1.classList.remove('rolling');
        d2.classList.remove('rolling');
        toast(e.message, 'error');
        hErr();
    }

    rolling = false;
    rollBtn.disabled = false;
    rollBtn.classList.remove('rolling');
    rollBtn.querySelector('.roll-text').textContent = '🎲  БРОСИТЬ КОСТИ';
});

function showResult(r) {
    const ov = document.getElementById('result-overlay');
    const modal = ov.querySelector('.result-modal');
    modal.className = 'result-modal ' + (r.won ? 'win' : 'loss');

    document.getElementById('result-icon').textContent = r.won ? '🎉' : '💀';

    const title = document.getElementById('result-title');
    title.textContent = r.won ? 'Победа!' : 'Мимо';
    title.className = 'result-title ' + (r.won ? 'win' : 'loss');

    const amt = document.getElementById('result-amount');
    amt.textContent = r.won ? ('+' + r.payout.toFixed(2)) : ('-' + Math.abs(r.profit).toFixed(2));
    amt.className = 'result-amount ' + (r.won ? 'win' : 'loss');

    const emojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    document.getElementById('result-dice-display').innerHTML =
        r.dice.map(d => `<span>${emojis[d]}</span>`).join('');

    if (r.won) confetti();
    ov.classList.remove('hidden');
}

document.getElementById('result-close').addEventListener('click', () => {
    document.getElementById('result-overlay').classList.add('hidden');
});
document.getElementById('result-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('result-overlay').classList.add('hidden');
});

function confetti() {
    const colors = ['#c9a96e', '#5cb85c', '#e0e0e0', '#a0a0a0', '#dfc08a', '#666'];
    for (let i = 0; i < 35; i++) {
        const c = document.createElement('div');
        c.className = 'confetti-piece';
        c.style.left = Math.random() * 100 + '%';
        c.style.top = '-8px';
        c.style.background = colors[~~(Math.random() * colors.length)];
        c.style.animationDelay = Math.random() * .4 + 's';
        c.style.borderRadius = Math.random() > .5 ? '50%' : '1px';
        const sz = 5 + Math.random() * 6;
        c.style.width = sz + 'px';
        c.style.height = sz + 'px';
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 2500);
    }
}

// история
async function loadHistory() {
    try {
        const d = await api('/api/history');
        const list = document.getElementById('history-list');
        if (!d.games?.length) { list.innerHTML = '<div class="empty-state"><span class="empty-icon">📜</span><p>Пока пусто</p></div>'; return; }

        const names = { high: '⬆️ Больше', low: '⬇️ Меньше', seven: '7️⃣ Семёрка', even: '🔵 Чёт', odd: '🔴 Нечёт', doubles: '🎯 Дубль' };
        const emojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

        list.innerHTML = d.games.map((g, i) => {
            const dice = g.dice_result.split(',').map(Number);
            const w = g.won === 1;
            const time = new Date(g.created_at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            return `<div class="history-item" style="animation-delay:${i * .04}s">
        <div class="history-left">
          <div class="history-dice">${dice.map(d => emojis[d]).join(' ')}</div>
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
        if (!d.players?.length) { list.innerHTML = '<div class="empty-state"><span class="empty-icon">🏆</span><p>Пусто</p></div>'; return; }
        const medals = ['🥇', '🥈', '🥉'];
        list.innerHTML = d.players.map((p, i) => `
      <div class="leaderboard-item ${i < 3 ? 'top-3' : ''}" style="animation-delay:${i * .04}s">
        <div class="leaderboard-rank">${i < 3 ? medals[i] : i + 1}</div>
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
        curSeeds.serverSeedHash = d.newServerSeedHash;
        curSeeds.clientSeed = d.clientSeed;
        curSeeds.nonce = d.nonce;
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
        const em = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        document.getElementById('verify-dice').textContent = d.dice.map(x => em[x] + ' (' + x + ')').join(' + ');
        document.getElementById('verify-total').textContent = d.total;
        document.getElementById('verify-hash').textContent = d.serverSeedHash;
        document.getElementById('verify-result').style.display = 'block';
        toast('Проверено ✅', 'success');
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

document.addEventListener('DOMContentLoaded', init);
