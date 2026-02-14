const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'cuberoll.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

  CREATE INDEX IF NOT EXISTS idx_games_tgid ON games(telegram_id);
  CREATE INDEX IF NOT EXISTS idx_trans_tgid ON transactions(telegram_id);
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN last_daily_claim TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address)');
} catch (e) { }


const userOps = {
  getOrCreate(tgId, username, firstName, lastName) {
    const startBal = 0; // Начинаем с 0 TON
    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    if (existing) {
      db.prepare('UPDATE users SET username = ?, first_name = ?, last_name = ?, last_active = datetime(\'now\') WHERE telegram_id = ?')
        .run(username, firstName, lastName, tgId);
      return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    }

    db.prepare('INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, ?)')
      .run(tgId, username, firstName, startBal);
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
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
    const after = before + amount;
    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(after, tgId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tgId, type, amount, before, after, desc);
    return { balanceBefore: before, balanceAfter: after };
  },

  setBalance(tgId, newBal) {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
    if (!user) return null;
    const before = user.balance;
    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(newBal, tgId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tgId, 'admin_set', newBal - before, before, newBal, 'Admin set balance');
    return { balanceBefore: before, balanceAfter: newBal };
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
    return stmt.run(data.telegramId, data.betAmount, data.gameType, data.playerChoice, data.diceResult, data.diceTotal, data.multiplier, data.payout, data.profit, data.serverSeed, data.clientSeed, data.nonce, data.hash, data.won ? 1 : 0);
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
  }
};

module.exports = { db, userOps, gameOps, settingsOps, giftOps, depositOps };
