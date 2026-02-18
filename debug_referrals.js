const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'cuberoll.db');
const db = new Database(dbPath);

console.log('--- DATABASE SCHEMA CHECK ---');
const info = db.prepare("PRAGMA table_info(users)").all();
console.log('Users columns:', info.map(c => `${c.name} (${c.type})`));

console.log('\n--- SAMPLE DATA (Users with ANY referred_by) ---');
const withRef = db.prepare('SELECT telegram_id, username, referred_by, referral_count, referral_earned FROM users WHERE referred_by IS NOT NULL LIMIT 10').all();
console.log('Users with referred_by:', withRef);

console.log('\n--- SAMPLE DATA (Users with referral_count > 0) ---');
const counts = db.prepare('SELECT telegram_id, username, referral_count FROM users WHERE referral_count > 0 LIMIT 10').all();
console.log('Users with referral_count > 0:', counts);

console.log('\n--- UNIQUE VALUES IN referred_by ---');
const distinct = db.prepare('SELECT DISTINCT referred_by, typeof(referred_by) as t FROM users LIMIT 20').all();
console.log('Distinct referred_by values:', distinct);

console.log('\n--- TOTALS ---');
console.log('Total users:', db.prepare('SELECT count(*) as c FROM users').get().c);
console.log('Total where referred_by is NOT NULL:', db.prepare('SELECT count(*) as c FROM users WHERE referred_by IS NOT NULL').get().c);
console.log('Total where referred_by is NOT NULL and not empty:', db.prepare('SELECT count(*) as c FROM users WHERE referred_by IS NOT NULL AND referred_by != "" AND referred_by != 0').get().c);
