const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'cuberoll.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Hook for sync
let onChange = () => { };
const setOnChange = (fn) => { onChange = fn; };

// таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    balance REAL DEFAULT 0,
    total_wagered REAL DEFAULT 0,
    total_won REAL DEFAULT 0,
    total_lost REAL DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    last_daily_claim TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    bet_amount REAL,
    game_type TEXT DEFAULT 'dice',
    player_choice TEXT,
    dice_result TEXT,
    dice_total INTEGER,
    multiplier REAL,
    payout REAL,
    profit REAL,
    server_seed TEXT,
    client_seed TEXT,
    nonce INTEGER,
    hash TEXT,
    won INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    type TEXT,
    amount REAL,
    balance_before REAL,
    balance_after REAL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    price REAL,
    link TEXT,
    model TEXT,
    background TEXT,
    symbol TEXT,
    gift_id TEXT UNIQUE, -- Telegram Unique Gift ID
    nft_address TEXT,    -- NFT Address for floor price check
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount REAL,
    status TEXT DEFAULT 'pending',
    comment TEXT UNIQUE,
    tx_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS promocodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    amount REAL,
    max_activations INTEGER,
    current_activations INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promocode_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promocode_id INTEGER,
    telegram_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(promocode_id, telegram_id),
    FOREIGN KEY(promocode_id) REFERENCES promocodes(id),
    FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
  );

  CREATE INDEX IF NOT EXISTS idx_games_tgid ON games(telegram_id);
  CREATE INDEX IF NOT EXISTS idx_trans_tgid ON transactions(telegram_id);
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN last_name TEXT');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN last_daily_claim TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address)');
} catch (e) { }

try {
  db.exec('ALTER TABLE gifts ADD COLUMN gift_id TEXT UNIQUE');
} catch (e) { }

try {
  db.exec('ALTER TABLE gifts ADD COLUMN nft_address TEXT');
} catch (e) { }

// Таблица для активных сессий (Crossroad и др.)
db.exec(`
  CREATE TABLE IF NOT EXISTS active_sessions (
    telegram_id INTEGER PRIMARY KEY,
    bet_amount REAL,
    game_type TEXT,
    current_step INTEGER DEFAULT 0,
    current_multiplier REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );
`);

// Таблица для очереди передачи подарков
db.exec(`
  CREATE TABLE IF NOT EXISTS gift_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gift_id INTEGER,
    receiver_id INTEGER,
    status TEXT DEFAULT 'pending', -- pending, sent, failed
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (gift_id) REFERENCES gifts(id),
    FOREIGN KEY (receiver_id) REFERENCES users(telegram_id)
  );
`);

const sessionOps = {
  get(tgId) {
    return db.prepare('SELECT * FROM active_sessions WHERE telegram_id = ?').get(tgId);
  },
  create(tgId, amount, gameType) {
    return db.prepare('INSERT INTO active_sessions (telegram_id, bet_amount, game_type, current_step, current_multiplier) VALUES (?, ?, ?, 0, 1.0)')
      .run(tgId, amount, gameType);
  },
  update(tgId, step, multiplier) {
    return db.prepare('UPDATE active_sessions SET current_step = ?, current_multiplier = ? WHERE telegram_id = ?')
      .run(step, multiplier, tgId);
  },
  delete(tgId) {
    return db.prepare('DELETE FROM active_sessions WHERE telegram_id = ?').delete ? db.prepare('DELETE FROM active_sessions WHERE telegram_id = ?').run(tgId) : db.prepare('DELETE FROM active_sessions WHERE telegram_id = ?').run(tgId);
  }
};

const userOps = {
  getOrCreate(tgId, username, firstName, lastName) {
    const startBal = 0;
    try {
      const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
      if (existing) {
        db.prepare('UPDATE users SET username = ?, first_name = ?, last_name = ?, last_active = datetime(\'now\') WHERE telegram_id = ?')
          .run(username || '', firstName || '', lastName || '', tgId);
        return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
      }

      console.log(`[DB] Creating new user: ${tgId} (${username})`);
      db.prepare('INSERT INTO users (telegram_id, username, first_name, last_name, balance) VALUES (?, ?, ?, ?, ?)')
        .run(tgId, username || '', firstName || '', lastName || '', startBal);

      return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    } catch (err) {
      console.error(`[DB Error] getOrCreate failed for user ${tgId}:`, err.message);
      // Если юзер уже есть (параллельный запрос), просто вернем его
      return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    }
  },

  get(tgId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
  },

  getAll() {
    return db.prepare('SELECT * FROM users ORDER BY balance DESC').all();
  },

  getByWallet(address) {
    if (!address) return null;
    return db.prepare('SELECT * FROM users WHERE wallet_address = ?').get(address);
  },

  updateWallet(tgId, address) {
    return db.prepare("UPDATE users SET wallet_address = ?, last_active = datetime('now') WHERE telegram_id = ?").run(address, tgId);
  },

  updateBalance(tgId, amount, type, desc) {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    if (!user) return null;
    const before = user.balance;
    // Округляем до 9 знаков (нанотоны), чтобы избежать проблем с точностью JS
    const after = Math.round((before + amount) * 1e9) / 1e9;
    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(after, tgId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tgId, type, amount, before, after, desc);
    onChange();
    return { balanceBefore: before, balanceAfter: after };
  },

  setBalance(tgId, newBal) {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    if (!user) return null;
    const before = user.balance;
    const roundedBal = Math.round(newBal * 1e9) / 1e9;
    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(roundedBal, tgId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tgId, 'admin_set', roundedBal - before, before, roundedBal, 'Admin set balance');
    onChange();
    return { balanceBefore: before, balanceAfter: roundedBal };
  },

  ban(tgId) { db.prepare('UPDATE users SET is_banned = 1 WHERE telegram_id = ?').run(tgId); },
  unban(tgId) { db.prepare('UPDATE users SET is_banned = 0 WHERE telegram_id = ?').run(tgId); },

  updateStats(tgId, wagered, isWin, profit) {
    db.prepare(`
      UPDATE users SET 
        total_wagered = total_wagered + ?,
        total_won = total_won + ?,
        total_lost = total_lost + ?,
        games_played = games_played + 1,
        games_won = games_won + ?
      WHERE telegram_id = ?
    `).run(wagered, isWin ? profit : 0, isWin ? 0 : wagered, isWin ? 1 : 0, tgId);
  },

  getCount() {
    return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  },

  getTopPlayers(limit = 100) {
    return db.prepare('SELECT * FROM users ORDER BY balance DESC LIMIT ?').all(limit);
  },

  claimDaily(tgId, amount) {
    db.prepare('UPDATE users SET balance = balance + ?, last_daily_claim = datetime(\'now\') WHERE telegram_id = ?').run(amount, tgId);
  }
};

const gameOps = {
  create(data) {
    const stmt = db.prepare(`
      INSERT INTO games (telegram_id, bet_amount, game_type, player_choice, dice_result, dice_total, multiplier, payout, profit, server_seed, client_seed, nonce, hash, won)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(data.telegramId, data.betAmount, data.gameType, data.playerChoice, data.diceResult, data.diceTotal, data.multiplier, data.payout, data.profit, data.serverSeed, data.clientSeed, data.nonce, data.hash, data.won ? 1 : 0);
    onChange();
    return r;
  },

  getByUser(tgId, limit = 50) {
    return db.prepare('SELECT * FROM games WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?').all(tgId, limit);
  },

  getRecent(limit = 50) {
    return db.prepare(`
      SELECT g.*, u.username, u.first_name FROM games g 
      JOIN users u ON g.telegram_id = u.telegram_id 
      ORDER BY g.created_at DESC LIMIT ?
    `).all(limit);
  },

  getStats() {
    return db.prepare(`
      SELECT COUNT(*) as total_games, SUM(bet_amount) as total_wagered,
        SUM(CASE WHEN won = 1 THEN payout ELSE 0 END) as total_payouts,
        SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as total_wins,
        SUM(profit) as total_profit
      FROM games
    `).get();
  },

  getTodayStats() {
    return db.prepare(`
      SELECT COUNT(*) as total_games, SUM(bet_amount) as total_wagered,
        SUM(CASE WHEN won = 1 THEN payout ELSE 0 END) as total_payouts,
        SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as total_wins,
        SUM(profit) as total_profit
      FROM games WHERE date(created_at) = date('now')
    `).get();
  }
};


// --- настройки ---

const settingsOps = {
  get(key) {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? r.value : null;
  },
  set(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    onChange();
  },
  getAll() {
    const rows = db.prepare('SELECT * FROM settings').all();
    const out = {};
    rows.forEach(r => out[r.key] = r.value);
    return out;
  }
};

// Seed defaults
const defs = {
  min_bet: '0.1', max_bet: '100', house_edge: '5', starting_balance: '0',
  maintenance_mode: '0', min_deposit: '0.1',
  ton_wallet: 'UQBy7B0yPz6g5J0... (ADMIN: SET THIS IN PANEL)'
};
Object.entries(defs).forEach(([k, v]) => {
  if (!settingsOps.get(k)) settingsOps.set(k, v);
});

const giftOps = {
  getAll() {
    return db.prepare('SELECT * FROM gifts WHERE is_active = 1').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM gifts WHERE id = ?').get(id);
  },
  create(data) {
    return db.prepare('INSERT INTO gifts (title, price, link, model, background, symbol) VALUES (?, ?, ?, ?, ?, ?)')
      .run(data.title, data.price, data.link, data.model, data.background, data.symbol);
  },
  delete(id) {
    db.prepare('UPDATE gifts SET is_active = 0 WHERE id = ?').run(id);
  },

  createTransfer(giftId, receiverId) {
    return db.prepare('INSERT INTO gift_transfers (gift_id, receiver_id) VALUES (?, ?)').run(giftId, receiverId);
  },

  getPendingTransfers() {
    return db.prepare(`
      SELECT t.*, g.gift_id as tg_gift_id, g.title 
      FROM gift_transfers t 
      JOIN gifts g ON t.gift_id = g.id 
      WHERE t.status = 'pending'
    `).all();
  },

  markTransferSent(id) {
    db.prepare("UPDATE gift_transfers SET status = 'sent' WHERE id = ?").run(id);
  },

  markTransferFailed(id, error) {
    db.prepare("UPDATE gift_transfers SET status = 'failed', error = ? WHERE id = ?").run(error, id);
  }
};

const depositOps = {
  createPending(tgId, amount, comment) {
    return db.prepare('INSERT INTO deposits (telegram_id, amount, comment) VALUES (?, ?, ?)')
      .run(tgId, amount, comment);
  },
  getByComment(comment) {
    return db.prepare('SELECT * FROM deposits WHERE comment = ?').get(comment);
  },
  markCompleted(comment, hash) {
    const dep = this.getByComment(comment);
    if (!dep) return null;
    // Можно завершить если статус pending ИЛИ optimistic
    if (dep.status !== 'pending' && dep.status !== 'optimistic') return null;
    db.prepare("UPDATE deposits SET status = 'completed', tx_hash = ? WHERE comment = ?").run(hash, comment);
    return dep;
  },
  markOptimistic(comment) {
    db.prepare("UPDATE deposits SET status = 'optimistic', created_at = datetime('now') WHERE comment = ?").run(comment);
  },
  getPendingByUser(tgId) {
    return db.prepare("SELECT * FROM deposits WHERE telegram_id = ? AND status = 'pending'").all(tgId);
  },
  getOptimisticByUser(tgId) {
    return db.prepare("SELECT * FROM deposits WHERE telegram_id = ? AND status = 'optimistic'").all(tgId);
  },
  getExpiredOptimistic(minutes = 5) {
    return db.prepare("SELECT * FROM deposits WHERE status = 'optimistic' AND datetime(created_at, '+' || ? || ' minutes') < datetime('now')").all(minutes);
  },
  isHashUsed(hash) {
    if (!hash) return false;
    const exists = db.prepare("SELECT id FROM deposits WHERE tx_hash = ?").get(hash);
    if (exists) return true;
    const existsInTrans = db.prepare("SELECT id FROM transactions WHERE description LIKE ?").get(`%${hash}%`);
    return !!existsInTrans;
  }
};

const promoOps = {
  create(code, amount, maxActivations) {
    return db.prepare('INSERT INTO promocodes (code, amount, max_activations) VALUES (?, ?, ?)')
      .run(code.toUpperCase(), amount, maxActivations);
  },

  getAll() {
    return db.prepare('SELECT * FROM promocodes ORDER BY created_at DESC').all();
  },

  get(code) {
    return db.prepare('SELECT * FROM promocodes WHERE code = ? AND is_active = 1').get(code.toUpperCase());
  },

  redeem(tgId, code) {
    const promo = this.get(code);
    if (!promo) throw new Error('Промокод не найден или неактивен');
    if (promo.current_activations >= promo.max_activations) throw new Error('Промокод закончился');

    // Проверка на повторную активацию
    const alreadyUsed = db.prepare('SELECT id FROM promocode_activations WHERE promocode_id = ? AND telegram_id = ?').get(promo.id, tgId);
    if (alreadyUsed) throw new Error('Вы уже активировали этот промокод');

    const transaction = db.transaction(() => {
      // 1. Записываем активацию
      db.prepare('INSERT INTO promocode_activations (promocode_id, telegram_id) VALUES (?, ?)').run(promo.id, tgId);

      // 2. Увеличиваем счетчик на промокоде
      db.prepare('UPDATE promocodes SET current_activations = current_activations + 1 WHERE id = ?').run(promo.id);

      // 3. Начисляем баланс
      userOps.updateBalance(tgId, promo.amount, 'promocode', `Redeemed promo: ${code.toUpperCase()}`);
    });

    transaction();
    return promo;
  },

  delete(id) {
    db.prepare('UPDATE promocodes SET is_active = 0 WHERE id = ?').run(id);
  }
};

module.exports = { db, userOps, gameOps, settingsOps, giftOps, depositOps, promoOps, sessionOps, setOnChange };
