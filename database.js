const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'cuberoll.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000'); // Wait up to 10s if DB is locked

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
    last_daily_spin TEXT DEFAULT NULL,
    wallet_address TEXT DEFAULT NULL,
    referral_earned REAL DEFAULT 0,
    auto_cashout REAL DEFAULT NULL,
    biggest_win_mult REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_active TEXT DEFAULT (datetime('now'))
  );

  -- Migration: Add missing columns if they don't exist
  PRAGMA table_info(users);
  -- columns will be added below via JS safely

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
  db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN referral_earned REAL DEFAULT 0');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN last_daily_spin TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN biggest_win_mult REAL DEFAULT 0');
} catch (e) { }

try {
  db.exec('ALTER TABLE gifts ADD COLUMN slug TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN auto_cashout REAL DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN wallet_address TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec("ALTER TABLE users ADD COLUMN last_active TEXT DEFAULT (datetime('now'))");
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT DEFAULT NULL');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN referral_count INTEGER DEFAULT 0');
} catch (e) { }

try {
  db.exec('ALTER TABLE users ADD COLUMN referral_bonus_claimed INTEGER DEFAULT 0');
} catch (e) { }

try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_code ON users(referral_code)');
} catch (e) { }

// Marketplace Table
db.exec(`
  CREATE TABLE IF NOT EXISTS marketplace_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    gift_instance_id INTEGER, -- Link to user's gift if we have an inventory system, but currently we just have gifts as objects. 
    -- Actually, we need an inventory table to track who owns what gift. 
    price REAL,
    status TEXT DEFAULT 'active', -- active, sold, cancelled
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (seller_id) REFERENCES users(telegram_id)
  );
`);

// Inventory Table (to track which user owns which gift)
db.exec(`
  CREATE TABLE IF NOT EXISTS user_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    gift_id INTEGER,
    acquired_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
    FOREIGN KEY (gift_id) REFERENCES gifts(id)
  );
`);

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
  getOrCreate(tgId, username, firstName, lastName, referrerId = null) {
    const startBal = 0;
    try {
      const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
      if (existing) {
        db.prepare('UPDATE users SET username = ?, first_name = ?, last_name = ?, last_active = datetime(\'now\') WHERE telegram_id = ?')
          .run(username || '', firstName || '', lastName || '', tgId);
        // Generate referral code if missing
        if (!existing.referral_code) {
          const code = this.generateReferralCode();
          db.prepare('UPDATE users SET referral_code = ? WHERE telegram_id = ?').run(code, tgId);
        }
        const u = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
        u._isNew = false;
        return u;
      }

      const refCode = this.generateReferralCode();
      console.log(`[DB] Creating new user: ${tgId} (${username}), referred by: ${referrerId}, code: ${refCode}`);
      db.prepare('INSERT INTO users (telegram_id, username, first_name, last_name, balance, referred_by, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tgId, username || '', firstName || '', lastName || '', startBal, referrerId, refCode);

      // Increment referrer's referral_count and check for bonus
      if (referrerId && referrerId !== tgId) {
        db.prepare('UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = ?').run(referrerId);
        this.checkReferralBonus(referrerId);
      }

      const u = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
      u._isNew = true;
      u._referrerId = referrerId;
      return u;
    } catch (err) {
      console.error(`[DB Error] getOrCreate failed for user ${tgId}:`, err.message);
      const resumed = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
      if (resumed) return resumed;
      throw err; // Re-throw if we still can't get the user so the server knows something is seriously wrong
    }
  },

  generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while (db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code));
    return code;
  },

  getByReferralCode(code) {
    return db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code);
  },

  checkReferralBonus(referrerId) {
    const referrer = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(referrerId);
    if (!referrer) return;
    // Bonus: 3 TON for 10 referrals, only until 2026-02-22, claim once
    const deadline = new Date('2026-02-22T23:59:59+03:00');
    if (referrer.referral_count >= 10 && !referrer.referral_bonus_claimed && new Date() <= deadline) {
      db.prepare('UPDATE users SET referral_bonus_claimed = 1 WHERE telegram_id = ?').run(referrerId);
      this.updateBalance(referrerId, 3, 'referral_bonus', 'Бонус за 10 рефералов: +3 TON');
      console.log(`[Referral] User ${referrerId} claimed 3 TON bonus for 10 referrals!`);
    }
  },

  getReferralCount(tgId) {
    const r = db.prepare('SELECT COUNT(*) as count FROM users WHERE referred_by = ?').get(tgId);
    return r ? r.count : 0;
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

  updateStats(tgId, wagered, isWin, profit, multiplier = 0) {
    db.prepare(`
      UPDATE users SET 
        total_wagered = total_wagered + ?,
        total_won = total_won + ?,
        total_lost = total_lost + ?,
        games_played = games_played + 1,
        games_won = games_won + ?,
        biggest_win_mult = MAX(biggest_win_mult, ?)
      WHERE telegram_id = ?
    `).run(wagered, isWin ? profit : 0, isWin ? 0 : wagered, isWin ? 1 : 0, isWin ? multiplier : 0, tgId);

    // Referral Commission (10% of LOSS)
    if (!isWin) {
      const user = this.get(tgId);
      if (user && user.referred_by) {
        const commission = wagered * 0.1;
        this.updateBalance(user.referred_by, commission, 'referral_loss_bonus', `10% commission from referral ${tgId} loss`);
        db.prepare('UPDATE users SET referral_earned = referral_earned + ? WHERE telegram_id = ?')
          .run(commission, user.referred_by);
      }
    }
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
  },

  resetAllStats() {
    return db.transaction(() => {
      // 1. Clear games history
      db.prepare('DELETE FROM games').run();
      // 2. Reset user stats
      db.prepare(`
        UPDATE users SET 
          total_wagered = 0,
          total_won = 0,
          total_lost = 0,
          games_played = 0,
          games_won = 0,
          biggest_win_mult = 0
      `).run();
      // 3. Clear sessions
      db.prepare('DELETE FROM active_sessions').run();
    })();
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
  maintenance_mode: '0', min_deposit: '0.01',
  ton_wallet: 'UQCCy-dvxLvZ8f4_ifO0PqavqPMGJkuONSf6WZNvPU3M0eQf'
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
    // If it has a gift_id, we should use OR REPLACE to avoid duplicate errors
    if (data.gift_id) {
      return db.prepare('INSERT OR REPLACE INTO gifts (title, price, link, model, background, symbol, slug, gift_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(data.title, data.price, data.link, data.model, data.background, data.symbol, data.slug || null, data.gift_id);
    }
    return db.prepare('INSERT INTO gifts (title, price, link, model, background, symbol, slug, gift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(data.title, data.price, data.link, data.model, data.background, data.symbol, data.slug || null, data.gift_id || null);
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
    if (dep.status !== 'pending' && dep.status !== 'optimistic') return dep; // Already completed or canceled
    db.prepare("UPDATE deposits SET status = 'completed', tx_hash = ? WHERE comment = ?").run(hash, comment);
    return dep;
  },
  createCompleted(tgId, amount, comment, hash) {
    // Check if hash exists first (paranoia check)
    if (this.isHashUsed(hash)) return;
    return db.prepare("INSERT INTO deposits (telegram_id, amount, comment, status, tx_hash) VALUES (?, ?, ?, 'completed', ?)")
      .run(tgId, amount, comment, hash);
  },
  isHashUsed(hash) {
    const row = db.prepare('SELECT 1 FROM deposits WHERE tx_hash = ?').get(hash);
    return !!row;
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

const inventoryOps = {
  add(tgId, giftId) {
    return db.prepare('INSERT INTO user_inventory (telegram_id, gift_id) VALUES (?, ?)').run(tgId, giftId);
  },
  getByUser(tgId) {
    return db.prepare(`
      SELECT i.id as instance_id, g.* FROM user_inventory i
      JOIN gifts g ON i.gift_id = g.id
      WHERE i.telegram_id = ?
      AND i.id NOT IN (SELECT gift_instance_id FROM marketplace_listings WHERE status = 'active')
    `).all(tgId);
  },
  remove(instanceId) {
    return db.prepare('DELETE FROM user_inventory WHERE id = ?').run(instanceId);
  }
};

const marketplaceOps = {
  list(sellerId, instanceId, price) {
    const item = db.prepare('SELECT * FROM user_inventory WHERE id = ? AND telegram_id = ?').get(instanceId, sellerId);
    if (!item) throw new Error('Item not found in inventory');

    return db.transaction(() => {
      db.prepare('INSERT INTO marketplace_listings (seller_id, gift_instance_id, price) VALUES (?, ?, ?)').run(sellerId, instanceId, price);
      // We don't remove from inventory yet, but we mark it as "listed" if we had a status column. 
      // Instead, we just check for exists in marketplace_listings.
    })();
  },
  getActive() {
    return db.prepare(`
      SELECT m.*, g.title, g.model, g.background, g.symbol, g.gift_id, g.slug, g.link, u.username as seller_name
      FROM marketplace_listings m
      JOIN user_inventory i ON m.gift_instance_id = i.id
      JOIN gifts g ON i.gift_id = g.id
      JOIN users u ON m.seller_id = u.telegram_id
      WHERE m.status = 'active'
      ORDER BY m.created_at DESC
    `).all();
  },
  buy(buyerId, listingId) {
    const listing = db.prepare("SELECT * FROM marketplace_listings WHERE id = ? AND status = 'active'").get(listingId);
    if (!listing) throw new Error('Listing not found');
    if (listing.seller_id === buyerId) throw new Error('Cannot buy your own item');

    const buyer = userOps.get(buyerId);
    if (buyer.balance < listing.price) throw new Error('Insufficient balance');

    return db.transaction(() => {
      // 1. Pay seller
      userOps.updateBalance(listing.seller_id, listing.price, 'marketplace_sale', `Sold gift for ${listing.price} TON`);
      // 2. Charge buyer
      userOps.updateBalance(buyerId, -listing.price, 'marketplace_purchase', `Bought gift for ${listing.price} TON`);
      // 3. Move inventory
      db.prepare('UPDATE user_inventory SET telegram_id = ? WHERE id = ?').run(buyerId, listing.gift_instance_id);
      // 4. Mark listing as sold
      db.prepare("UPDATE marketplace_listings SET status = 'sold' WHERE id = ?").run(listingId);
    })();
  },
  cancel(sellerId, listingId) {
    return db.prepare("UPDATE marketplace_listings SET status = 'cancelled' WHERE id = ? AND seller_id = ? AND status = 'active'").run(listingId, sellerId);
  },
  getByUser(sellerId) {
    return db.prepare(`
      SELECT m.*, g.title, g.model, g.background, g.symbol, g.gift_id, g.slug, g.link
      FROM marketplace_listings m
      JOIN user_inventory i ON m.gift_instance_id = i.id
      JOIN gifts g ON i.gift_id = g.id
      WHERE m.seller_id = ? AND m.status = 'active'
    `).all(sellerId);
  }
};

// --- RAFFLE SYSTEM (Dynamic) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    prize TEXT NOT NULL,
    nft_link TEXT,
    channel_link TEXT,
    description TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT,
    deposit_per_ticket REAL DEFAULT 0.1,
    ref_first_dep_tickets INTEGER DEFAULT 1,
    ref_cumul_amount REAL DEFAULT 0.5,
    ref_cumul_tickets INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    is_finished INTEGER DEFAULT 0,
    winner_id INTEGER DEFAULT NULL,
    prize_gift_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (prize_gift_id) REFERENCES gifts(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS raffle_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    telegram_id INTEGER,
    amount INTEGER DEFAULT 1,
    reason TEXT,
    source_deposit_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (raffle_id) REFERENCES raffles(id),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );
  CREATE INDEX IF NOT EXISTS idx_raffle_tgid ON raffle_tickets(telegram_id);
`);

// Migration: Add columns if missing
try { db.exec('ALTER TABLE raffles ADD COLUMN is_finished INTEGER DEFAULT 0'); } catch (e) { }
try { db.exec('ALTER TABLE raffles ADD COLUMN winner_id INTEGER DEFAULT NULL'); } catch (e) { }
try { db.exec('ALTER TABLE raffles ADD COLUMN prize_gift_id INTEGER DEFAULT NULL'); } catch (e) { }
try { db.exec('ALTER TABLE raffles ADD COLUMN is_active INTEGER DEFAULT 1'); } catch (e) { }

// Track cumulative referral deposits for ticket awarding
try {
  db.exec('ALTER TABLE users ADD COLUMN raffle_ref_deposit_tracked REAL DEFAULT 0');
} catch (e) { }

const raffleOps = {
  // --- Raffle CRUD ---
  create(data) {
    return db.prepare(`INSERT INTO raffles (title, prize, nft_link, channel_link, description, start_date, end_date, deposit_per_ticket, ref_first_dep_tickets, ref_cumul_amount, ref_cumul_tickets, prize_gift_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(data.title, data.prize, data.nft_link || null, data.channel_link || null, data.description || null, data.start_date, data.end_date || null, data.deposit_per_ticket || 0.1, data.ref_first_dep_tickets || 1, data.ref_cumul_amount || 0.5, data.ref_cumul_tickets || 1, data.prize_gift_id || null);
  },
  getAll() {
    return db.prepare('SELECT * FROM raffles ORDER BY created_at DESC').all();
  },
  getActive() {
    return db.prepare("SELECT * FROM raffles WHERE is_active = 1 AND is_finished = 0 ORDER BY created_at DESC").all();
  },
  getById(id) {
    return db.prepare('SELECT * FROM raffles WHERE id = ?').get(id);
  },
  toggle(id) {
    const r = db.prepare('SELECT is_active FROM raffles WHERE id = ?').get(id);
    if (r) db.prepare('UPDATE raffles SET is_active = ? WHERE id = ?').run(r.is_active ? 0 : 1, id);
  },
  delete(id) {
    db.prepare('DELETE FROM raffle_tickets WHERE raffle_id = ?').run(id);
    db.prepare('DELETE FROM raffles WHERE id = ?').run(id);
  },

  // --- Tickets ---
  addTickets(raffleId, tgId, amount, reason, depositHash = null) {
    if (amount <= 0) return;
    return db.prepare('INSERT INTO raffle_tickets (raffle_id, telegram_id, amount, reason, source_deposit_hash) VALUES (?, ?, ?, ?, ?)')
      .run(raffleId, tgId, amount, reason, depositHash);
  },
  getTickets(raffleId, tgId) {
    const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM raffle_tickets WHERE raffle_id = ? AND telegram_id = ?').get(raffleId, tgId);
    return row ? row.total : 0;
  },
  getTicketDetails(raffleId, tgId) {
    return db.prepare('SELECT * FROM raffle_tickets WHERE raffle_id = ? AND telegram_id = ? ORDER BY created_at DESC').all(raffleId, tgId);
  },
  getLeaderboard(raffleId, limit = 50) {
    return db.prepare(`
      SELECT t.telegram_id, u.username, u.first_name, SUM(t.amount) as total_tickets
      FROM raffle_tickets t
      JOIN users u ON t.telegram_id = u.telegram_id
      WHERE t.raffle_id = ?
      GROUP BY t.telegram_id
      ORDER BY total_tickets DESC
      LIMIT ?
    `).all(raffleId, limit);
  },
  getTotalTickets(raffleId) {
    const row = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM raffle_tickets WHERE raffle_id = ?').get(raffleId);
    return row ? row.total : 0;
  },
  getParticipantCount(raffleId) {
    const row = db.prepare('SELECT COUNT(DISTINCT telegram_id) as count FROM raffle_tickets WHERE raffle_id = ?').get(raffleId);
    return row ? row.count : 0;
  },
  drawWinner(id) {
    const raffle = this.getById(id);
    if (!raffle || raffle.is_finished) return null;

    const tickets = db.prepare('SELECT telegram_id, amount FROM raffle_tickets WHERE raffle_id = ?').all(id);
    if (tickets.length === 0) {
      db.prepare('UPDATE raffles SET is_finished = 1, is_active = 0 WHERE id = ?').run(id);
      return null;
    }

    const pool = [];
    tickets.forEach(t => {
      for (let i = 0; i < t.amount; i++) {
        pool.push(t.telegram_id);
      }
    });

    const winnerId = pool[Math.floor(Math.random() * pool.length)];
    db.prepare('UPDATE raffles SET is_finished = 1, winner_id = ?, is_active = 0 WHERE id = ?').run(winnerId, id);

    // Auto-transfer gift if assigned
    if (raffle.prize_gift_id) {
      giftOps.createTransfer(raffle.prize_gift_id, winnerId);
    }

    return {
      winnerId,
      raffle
    };
  }
};

module.exports = { db, userOps, gameOps, settingsOps, giftOps, depositOps, promoOps, sessionOps, inventoryOps, marketplaceOps, raffleOps, setOnChange };
