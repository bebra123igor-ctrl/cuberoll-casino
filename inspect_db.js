const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'cuberoll.db');
const db = new Database(dbPath);

console.log('--- DB INSPECT ---');
const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
const withRef = db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by IS NOT NULL').get().c;
console.log('Total users:', total);
console.log('Users with referred_by:', withRef);

if (withRef > 0) {
    const samples = db.prepare('SELECT telegram_id, referred_by FROM users WHERE referred_by IS NOT NULL LIMIT 5').all();
    console.log('Samples of referred users:', samples);

    const referrers = db.prepare('SELECT DISTINCT referred_by FROM users WHERE referred_by IS NOT NULL').all();
    console.log('Count of distinct referrers in users table:', referrers.length);

    for (const r of referrers.slice(0, 3)) {
        const found = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(r.referred_by);
        console.log(`Checking if referrer ${r.referred_by} exists in users table:`, found ? 'YES' : 'NO');
    }
}
