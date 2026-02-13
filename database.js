const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'cuberoll.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    balance REAL DEFAULT 1000,
    total_wagered REAL DEFAULT 0,
    total_won REAL DEFAULT 0,
    total_lost REAL DEFAULT 0,
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
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

  CREATE INDEX IF NOT EXISTS idx_games_telegram_id ON games(telegram_id);
  CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);
  CREATE INDEX IF NOT EXISTS idx_transactions_telegram_id ON transactions(telegram_id);
`);

// Initialize default settings
const defaultSettings = {
  min_bet: '10',
  max_bet: '10000',
  starting_balance: '1000',
  house_edge: '5',
  maintenance_mode: '0'
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

// User operations
const userOps = {
  getOrCreate: (telegramId, username, firstName, lastName) => {
    const startingBalance = parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('starting_balance')?.value || '1000');
    
    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (existing) {
      db.prepare('UPDATE users SET username = ?, first_name = ?, last_name = ?, last_active = datetime(\'now\') WHERE telegram_id = ?')
        .run(username, firstName, lastName, telegramId);
      return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    }
    
    db.prepare('INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, ?)')
      .run(telegramId, username, firstName, startingBalance);
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  get: (telegramId) => {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  getAll: () => {
    return db.prepare('SELECT * FROM users ORDER BY balance DESC').all();
  },

  updateBalance: (telegramId, amount, type, description) => {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!user) return null;

    const balanceBefore = user.balance;
    const balanceAfter = balanceBefore + amount;

    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(balanceAfter, telegramId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(telegramId, type, amount, balanceBefore, balanceAfter, description);

    return { balanceBefore, balanceAfter };
  },

  setBalance: (telegramId, newBalance) => {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!user) return null;

    const balanceBefore = user.balance;
    db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(newBalance, telegramId);
    db.prepare('INSERT INTO transactions (telegram_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(telegramId, 'admin_set', newBalance - balanceBefore, balanceBefore, newBalance, 'Admin set balance');

    return { balanceBefore, balanceAfter: newBalance };
  },

  ban: (telegramId) => {
    db.prepare('UPDATE users SET is_banned = 1 WHERE telegram_id = ?').run(telegramId);
  },

  unban: (telegramId) => {
    db.prepare('UPDATE users SET is_banned = 0 WHERE telegram_id = ?').run(telegramId);
  },

  updateStats: (telegramId, wagered, isWin, profit) => {
    const won = isWin ? profit : 0;
    const lost = isWin ? 0 : Math.abs(profit);
    const gamesWonInc = isWin ? 1 : 0;

    db.prepare(`
      UPDATE users SET 
        total_wagered = total_wagered + ?,
        total_won = total_won + ?,
        total_lost = total_lost + ?,
        games_played = games_played + 1,
        games_won = games_won + ?
      WHERE telegram_id = ?
    `).run(wagered, won, lost, gamesWonInc, telegramId);
  },

  getTopPlayers: (limit = 10) => {
    return db.prepare('SELECT * FROM users ORDER BY balance DESC LIMIT ?').all(limit);
  },

  getCount: () => {
    return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  }
};

// Game operations
const gameOps = {
  create: (data) => {
    const stmt = db.prepare(`
      INSERT INTO games (telegram_id, bet_amount, game_type, player_choice, dice_result, dice_total, multiplier, payout, profit, server_seed, client_seed, nonce, hash, won)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      data.telegramId, data.betAmount, data.gameType, data.playerChoice,
      data.diceResult, data.diceTotal, data.multiplier, data.payout,
      data.profit, data.serverSeed, data.clientSeed, data.nonce, data.hash, data.won ? 1 : 0
    );
  },

  getByUser: (telegramId, limit = 50) => {
    return db.prepare('SELECT * FROM games WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?').all(telegramId, limit);
  },

  getRecent: (limit = 50) => {
    return db.prepare(`
      SELECT g.*, u.username, u.first_name FROM games g 
      JOIN users u ON g.telegram_id = u.telegram_id 
      ORDER BY g.created_at DESC LIMIT ?
    `).all(limit);
  },

  getStats: () => {
    return db.prepare(`
      SELECT 
        COUNT(*) as total_games,
        SUM(bet_amount) as total_wagered,
        SUM(CASE WHEN won = 1 THEN payout ELSE 0 END) as total_payouts,
        SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as total_wins,
        SUM(profit) as total_profit
      FROM games
    `).get();
  },

  getTodayStats: () => {
    return db.prepare(`
      SELECT 
        COUNT(*) as total_games,
        SUM(bet_amount) as total_wagered,
        SUM(CASE WHEN won = 1 THEN payout ELSE 0 END) as total_payouts,
        SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as total_wins,
        SUM(profit) as total_profit
      FROM games
      WHERE date(created_at) = date('now')
    `).get();
  }
};

// Settings operations
const settingsOps = {
  get: (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  set: (key, value) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  },

  getAll: () => {
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }
};

module.exports = { db, userOps, gameOps, settingsOps };
