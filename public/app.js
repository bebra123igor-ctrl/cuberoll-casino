// ===== CubeRoll Casino — Frontend App =====

const API_BASE = '';
let tg = null;
let initData = '';
let currentUser = null;
let currentSettings = {};
let currentSeeds = {};
let selectedBetType = 'high';
let isRolling = false;
let isAdmin = false;

// ===== Telegram WebApp Init =====
function initTelegram() {
    if (window.Telegram && window.Telegram.WebApp) {
        tg = window.Telegram.WebApp;
        tg.expand();
        tg.ready();

        // Apply TG theme
        document.documentElement.style.setProperty('--tg-header-height',
            (tg.headerColor ? '0px' : '0px'));

        if (tg.themeParams) {
            if (tg.themeParams.bg_color) {
                // We keep our own theme, but set header color
                tg.setHeaderColor('#0a0e17');
                tg.setBackgroundColor('#0a0e17');
            }
        }

        initData = tg.initData;

        // Haptic feedback
        if (tg.HapticFeedback) {
            window.haptic = tg.HapticFeedback;
        }
    }
}

// ===== API Calls =====
async function apiCall(endpoint, method = 'GET', body = null) {
    const headers = {
        'Content-Type': 'application/json',
    };

    if (initData) {
        headers['X-Telegram-Init-Data'] = initData;
    } else {
        // Dev mode
        headers['X-Dev-User-Id'] = '12345';
    }

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${API_BASE}${endpoint}`, options);

    if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${response.status}`);
    }

    return response.json();
}

// ===== Init App =====
async function initApp() {
    initTelegram();
    createLoadingParticles();

    try {
        const data = await apiCall('/api/auth', 'POST');
        currentUser = data.user;
        currentSettings = data.settings;
        currentSeeds = data.seeds;
        isAdmin = data.isAdmin;

        updateUI();

        // Finish loading
        setTimeout(() => {
            document.getElementById('loading-screen').classList.add('fade-out');
            setTimeout(() => {
                document.getElementById('loading-screen').style.display = 'none';
                document.getElementById('app').classList.remove('hidden');
            }, 600);
        }, 1800);
    } catch (err) {
        console.error('Init error:', err);
        document.querySelector('.loading-subtitle').textContent = 'Ошибка загрузки...';
    }
}

// ===== Create Loading Particles =====
function createLoadingParticles() {
    const container = document.getElementById('loading-particles');
    for (let i = 0; i < 30; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 4 + 's';
        particle.style.animationDuration = (3 + Math.random() * 3) + 's';
        const colors = ['#6366f1', '#a855f7', '#ec4899', '#10b981'];
        particle.style.background = colors[Math.floor(Math.random() * colors.length)];
        container.appendChild(particle);
    }
}

// ===== Update UI =====
function updateUI() {
    if (!currentUser) return;

    // User info
    document.getElementById('user-name').textContent = currentUser.firstName || currentUser.username || 'Player';
    document.getElementById('user-id').textContent = `ID: ${currentUser.telegramId}`;
    document.getElementById('user-initial').textContent =
        (currentUser.firstName || currentUser.username || '?').charAt(0).toUpperCase();

    // Balance
    updateBalance(currentUser.balance);

    // Seeds
    if (currentSeeds) {
        document.getElementById('server-seed-hash').textContent = currentSeeds.serverSeedHash || '---';
        document.getElementById('client-seed-input').value = currentSeeds.clientSeed || '';
        document.getElementById('nonce-value').textContent = currentSeeds.nonce || '0';
    }

    // Update potential win
    updatePotentialWin();
}

function updateBalance(amount, animate = false) {
    const el = document.getElementById('balance-amount');
    const display = document.getElementById('balance-display');

    if (animate) {
        const oldAmount = parseFloat(el.textContent);
        animateNumber(el, oldAmount, amount, 600);

        if (amount > oldAmount) {
            display.classList.add('pulse');
            setTimeout(() => display.classList.remove('pulse'), 500);
        } else {
            display.classList.add('pulse-loss');
            setTimeout(() => display.classList.remove('pulse-loss'), 500);
        }
    } else {
        el.textContent = amount.toFixed(2);
    }
}

function animateNumber(el, from, to, duration) {
    const start = performance.now();
    const diff = to - from;

    function update(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        const current = from + diff * eased;
        el.textContent = current.toFixed(2);

        if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// ===== Tab Navigation =====
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;

        // Remove active from all tabs and content
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        // Activate selected
        tab.classList.add('active');
        document.getElementById(`content-${tabName}`).classList.add('active');

        // Load data for tab
        if (tabName === 'history') loadHistory();
        if (tabName === 'leaderboard') loadLeaderboard();

        hapticLight();
    });
});

// ===== Bet Type Selection =====
document.querySelectorAll('.bet-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.bet-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedBetType = btn.dataset.bet;
        updatePotentialWin();
        hapticLight();
    });
});

// ===== Bet Amount Controls =====
const betInput = document.getElementById('bet-amount');

document.getElementById('btn-half').addEventListener('click', () => {
    betInput.value = Math.max(currentSettings.minBet || 10, Math.floor(parseInt(betInput.value) / 2));
    updatePotentialWin();
    hapticLight();
});

document.getElementById('btn-double').addEventListener('click', () => {
    const doubled = parseInt(betInput.value) * 2;
    betInput.value = Math.min(currentSettings.maxBet || 10000, doubled, currentUser?.balance || 0);
    updatePotentialWin();
    hapticLight();
});

betInput.addEventListener('input', () => {
    updatePotentialWin();
});

// Quick bet buttons
document.querySelectorAll('.quick-bet').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.quick-bet').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const amount = btn.dataset.amount;
        if (amount === 'max') {
            betInput.value = Math.min(currentUser?.balance || 0, currentSettings.maxBet || 10000);
        } else {
            betInput.value = parseInt(amount);
        }
        updatePotentialWin();
        hapticLight();
    });
});

// ===== Potential Win Calculation =====
function updatePotentialWin() {
    const bet = parseFloat(betInput.value) || 0;
    const multipliers = {
        high: 1.95, low: 1.95, seven: 3.5,
        even: 1.9, odd: 1.9, doubles: 5.0
    };
    const mult = multipliers[selectedBetType] || 1.95;
    const potential = bet * mult;
    document.getElementById('potential-amount').textContent = potential.toFixed(2);
}

// ===== Roll Dice =====
const rollBtn = document.getElementById('roll-btn');

rollBtn.addEventListener('click', async () => {
    if (isRolling) return;

    const betAmount = parseFloat(betInput.value);

    if (!betAmount || betAmount < (currentSettings.minBet || 10)) {
        showToast(`Минимальная ставка: ${currentSettings.minBet || 10}`, 'error');
        return;
    }

    if (betAmount > (currentUser?.balance || 0)) {
        showToast('Недостаточно средств!', 'error');
        hapticError();
        return;
    }

    isRolling = true;
    rollBtn.disabled = true;
    rollBtn.classList.add('rolling');
    rollBtn.querySelector('.roll-text').textContent = '🎲 БРОСАЮ...';

    // Start dice animation
    const die1 = document.getElementById('die1');
    const die2 = document.getElementById('die2');
    die1.classList.add('rolling');
    die2.classList.add('rolling');

    hapticMedium();

    try {
        const data = await apiCall('/api/bet', 'POST', {
            betAmount,
            betType: selectedBetType
        });

        // Wait for animation
        await sleep(1000);

        die1.classList.remove('rolling');
        die2.classList.remove('rolling');

        // Show result on dice
        setDiceFace(die1, data.result.dice[0]);
        setDiceFace(die2, data.result.dice[1]);

        // Update balance with animation
        currentUser.balance = data.result.newBalance;
        updateBalance(data.result.newBalance, true);

        // Update seeds
        currentSeeds.nonce = data.fairness.nonce;
        document.getElementById('nonce-value').textContent = data.fairness.nonce;

        // Show result overlay
        setTimeout(() => {
            showResult(data.result);
        }, 400);

        if (data.result.won) {
            hapticSuccess();
        } else {
            hapticError();
        }

    } catch (err) {
        die1.classList.remove('rolling');
        die2.classList.remove('rolling');
        showToast(err.message, 'error');
        hapticError();
    }

    isRolling = false;
    rollBtn.disabled = false;
    rollBtn.classList.remove('rolling');
    rollBtn.querySelector('.roll-text').textContent = '🎲 БРОСИТЬ КОСТИ';
});

// ===== Set Dice Face =====
function setDiceFace(dieEl, value) {
    const rotations = {
        1: 'rotateX(0deg) rotateY(0deg)',
        2: 'rotateX(-90deg) rotateY(0deg)',
        3: 'rotateX(0deg) rotateY(-90deg)',
        4: 'rotateX(0deg) rotateY(90deg)',
        5: 'rotateX(90deg) rotateY(0deg)',
        6: 'rotateX(180deg) rotateY(0deg)'
    };

    dieEl.style.transform = rotations[value] || rotations[1];
}

// ===== Show Result =====
function showResult(result) {
    const overlay = document.getElementById('result-overlay');
    const modal = overlay.querySelector('.result-modal');
    const icon = document.getElementById('result-icon');
    const title = document.getElementById('result-title');
    const diceDisplay = document.getElementById('result-dice-display');
    const amount = document.getElementById('result-amount');

    modal.className = 'result-modal ' + (result.won ? 'win' : 'loss');

    if (result.won) {
        icon.textContent = '🎉';
        title.textContent = 'Победа!';
        title.className = 'result-title win';
        amount.textContent = `+${result.payout.toFixed(2)}`;
        amount.className = 'result-amount win';

        // Fire confetti
        fireConfetti();
    } else {
        icon.textContent = '😢';
        title.textContent = 'Проигрыш';
        title.className = 'result-title loss';
        amount.textContent = `-${Math.abs(result.profit).toFixed(2)}`;
        amount.className = 'result-amount loss';
    }

    // Show dice
    const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    diceDisplay.innerHTML = result.dice.map(d =>
        `<span style="font-size: 40px;">${diceEmojis[d]}</span>`
    ).join('');

    overlay.classList.remove('hidden');
}

// ===== Close Result =====
document.getElementById('result-close').addEventListener('click', () => {
    document.getElementById('result-overlay').classList.add('hidden');
    hapticLight();
});

document.getElementById('result-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        document.getElementById('result-overlay').classList.add('hidden');
    }
});

// ===== Confetti =====
function fireConfetti() {
    const colors = ['#6366f1', '#a855f7', '#ec4899', '#10b981', '#f59e0b', '#ef4444'];

    for (let i = 0; i < 50; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.top = '-10px';
        confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animationDelay = Math.random() * 0.5 + 's';
        confetti.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
        confetti.style.width = (6 + Math.random() * 8) + 'px';
        confetti.style.height = (6 + Math.random() * 8) + 'px';
        document.body.appendChild(confetti);

        setTimeout(() => confetti.remove(), 2500);
    }
}

// ===== History =====
async function loadHistory() {
    try {
        const data = await apiCall('/api/history');
        const list = document.getElementById('history-list');

        if (!data.games || data.games.length === 0) {
            list.innerHTML = '<div class="empty-state"><span class="empty-icon">📜</span><p>Пока нет игр</p></div>';
            return;
        }

        const betTypeNames = {
            high: '⬆️ Больше', low: '⬇️ Меньше', seven: '7️⃣ Семёрка',
            even: '🔵 Чётное', odd: '🔴 Нечётное', doubles: '🎯 Дубль'
        };

        list.innerHTML = data.games.map((game, i) => {
            const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
            const dice = game.dice_result.split(',').map(Number);
            const isWin = game.won === 1;
            const time = new Date(game.created_at).toLocaleString('ru-RU', {
                hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
            });

            return `
        <div class="history-item" style="animation-delay: ${i * 0.05}s">
          <div class="history-left">
            <div class="history-dice">
              ${dice.map(d => diceEmojis[d]).join(' ')}
            </div>
            <div class="history-details">
              <span class="history-bet-type">${betTypeNames[game.player_choice] || game.player_choice} (${game.dice_total})</span>
              <span class="history-time">${time}</span>
            </div>
          </div>
          <div class="history-right">
            <div class="history-amount ${isWin ? 'win' : 'loss'}">
              ${isWin ? '+' + game.payout.toFixed(2) : '-' + game.bet_amount.toFixed(2)}
            </div>
            <div class="history-bet">Ставка: ${game.bet_amount.toFixed(2)}</div>
          </div>
        </div>
      `;
        }).join('');
    } catch (err) {
        console.error('History load error:', err);
    }
}

// ===== Leaderboard =====
async function loadLeaderboard() {
    try {
        const data = await apiCall('/api/leaderboard');
        const list = document.getElementById('leaderboard-list');

        if (!data.players || data.players.length === 0) {
            list.innerHTML = '<div class="empty-state"><span class="empty-icon">🏆</span><p>Нет игроков</p></div>';
            return;
        }

        const medals = ['🥇', '🥈', '🥉'];

        list.innerHTML = data.players.map((player, i) => `
      <div class="leaderboard-item ${i < 3 ? 'top-3' : ''}" style="animation-delay: ${i * 0.05}s">
        <div class="leaderboard-rank">${i < 3 ? medals[i] : (i + 1)}</div>
        <div class="leaderboard-info">
          <span class="leaderboard-name">${player.username || 'Anonymous'}</span>
          <span class="leaderboard-stats">${player.gamesPlayed} игр • ${player.gamesWon} побед</span>
        </div>
        <span class="leaderboard-balance">💰 ${player.balance.toFixed(0)}</span>
      </div>
    `).join('');
    } catch (err) {
        console.error('Leaderboard load error:', err);
    }
}

// ===== Fairness — Seeds =====
document.getElementById('btn-update-seed').addEventListener('click', async () => {
    const newSeed = document.getElementById('client-seed-input').value.trim();
    if (!newSeed) {
        showToast('Введите client seed', 'error');
        return;
    }

    try {
        await apiCall('/api/seeds/client', 'POST', { clientSeed: newSeed });
        currentSeeds.clientSeed = newSeed;
        showToast('Client seed обновлён ✅', 'success');
        hapticSuccess();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

document.getElementById('btn-rotate-seed').addEventListener('click', async () => {
    try {
        const data = await apiCall('/api/seeds/rotate', 'POST', {
            clientSeed: document.getElementById('client-seed-input').value.trim() || undefined
        });

        // Show old seed
        document.getElementById('old-server-seed').textContent = data.oldServerSeed;
        document.getElementById('old-server-hash').textContent = data.oldServerSeedHash;
        document.getElementById('old-seed-reveal').style.display = 'block';

        // Update current display
        document.getElementById('server-seed-hash').textContent = data.newServerSeedHash;
        document.getElementById('nonce-value').textContent = data.nonce;

        currentSeeds.serverSeedHash = data.newServerSeedHash;
        currentSeeds.clientSeed = data.clientSeed;
        currentSeeds.nonce = data.nonce;

        showToast('Server seed обновлён! Старый seed раскрыт.', 'success');
        hapticSuccess();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// ===== Verify Game =====
document.getElementById('btn-verify').addEventListener('click', async () => {
    const serverSeed = document.getElementById('verify-server-seed').value.trim();
    const clientSeed = document.getElementById('verify-client-seed').value.trim();
    const nonce = document.getElementById('verify-nonce').value;

    if (!serverSeed || !clientSeed || nonce === '') {
        showToast('Заполните все поля', 'error');
        return;
    }

    try {
        const data = await apiCall('/api/verify', 'POST', {
            serverSeed, clientSeed, nonce: parseInt(nonce)
        });

        const diceEmojis = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

        document.getElementById('verify-dice').textContent =
            data.dice.map(d => `${diceEmojis[d]} (${d})`).join(' + ');
        document.getElementById('verify-total').textContent = data.total;
        document.getElementById('verify-hash').textContent = data.serverSeedHash;
        document.getElementById('verify-result').style.display = 'block';

        showToast('Верификация пройдена ✅', 'success');
        hapticSuccess();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// ===== Haptic Feedback =====
function hapticLight() {
    try { window.haptic?.impactOccurred?.('light'); } catch (e) { }
}

function hapticMedium() {
    try { window.haptic?.impactOccurred?.('medium'); } catch (e) { }
}

function hapticSuccess() {
    try { window.haptic?.notificationOccurred?.('success'); } catch (e) { }
}

function hapticError() {
    try { window.haptic?.notificationOccurred?.('error'); } catch (e) { }
}

// ===== Toast =====
function showToast(message, type = '') {
    // Remove existing toast
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// ===== Utility =====
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== Start =====
document.addEventListener('DOMContentLoaded', initApp);
