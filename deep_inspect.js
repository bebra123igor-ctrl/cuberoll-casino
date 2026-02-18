const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'cuberoll.db');
const db = new Database(dbPath);

console.log('--- DEEP INSPECT ---');
const allReferred = db.prepare('SELECT telegram_id, referred_by FROM users WHERE referred_by IS NOT NULL').all();
console.log('Total users with referred_by:', allReferred.length);
if (allReferred.length > 0) {
    const counts = {};
    allReferred.forEach(u => {
        counts[u.referred_by] = (counts[u.referred_by] || 0) + 1;
    });
    console.log('Distribution (Referrer ID -> Count):', counts);
}

const referrersWithGaps = db.prepare('SELECT telegram_id, referral_count, referral_earned FROM users WHERE referral_count > 0 OR referral_earned > 0').all();
console.log('Users with referral_count > 0 or referral_earned > 0:', referrersWithGaps.length);
if (referrersWithGaps.length > 0) {
    console.log('Samples:', referrersWithGaps.slice(0, 5));
}
