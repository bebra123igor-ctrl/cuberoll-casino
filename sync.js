const https = require('https');
const { db } = require('./database');

const FIREBASE_URL = 'https://shout-messenger-default-rtdb.europe-west1.firebasedatabase.app/';

const TABLES = [
    'users', 'games', 'settings', 'promocodes', 'promocode_activations',
    'deposits', 'gifts', 'transfers', 'transactions', 'raffles', 'raffle_tickets'
];

async function firebaseRequest(path, method, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${FIREBASE_URL}${path}.json`);
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(url, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve(body);
                }
            });
        });

        req.on('error', (e) => reject(e));
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

const syncOps = {
    async pushToCloud() {
        console.log('[CloudSync] Pushing database to Firebase...');
        const backup = {};
        for (const table of TABLES) {
            try {
                backup[table] = db.prepare(`SELECT * FROM ${table}`).all();
            } catch (e) {
                console.error(`[CloudSync] Error reading table ${table}:`, e.message);
            }
        }

        try {
            await firebaseRequest('cuberoll_backup', 'PUT', backup);
            console.log('[CloudSync] Database successfully pushed to Firebase.');
        } catch (e) {
            console.error('[CloudSync] Failed to push to Firebase:', e.message);
        }
    },

    async pullFromCloud() {
        console.log('[CloudSync] Checking for cloud backup...');
        try {
            const data = await firebaseRequest('cuberoll_backup', 'GET');
            if (!data || typeof data !== 'object') {
                console.log('[CloudSync] No backup found or invalid data.');
                return false;
            }

            console.log('[CloudSync] Backup found! Restoring tables...');
            for (const table of TABLES) {
                if (data[table] && Array.isArray(data[table])) {
                    // Очищаем таблицу перед восстановлением
                    db.prepare(`DELETE FROM ${table}`).run();

                    if (data[table].length === 0) continue;

                    const cols = Object.keys(data[table][0]);
                    const placeholders = cols.map(() => '?').join(',');
                    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);

                    const transaction = db.transaction((rows) => {
                        for (const row of rows) {
                            const vals = cols.map(c => row[c]);
                            stmt.run(...vals);
                        }
                    });

                    transaction(data[table]);
                    console.log(`[CloudSync] Restored ${data[table].length} rows into ${table}`);
                }
            }
            return true;
        } catch (e) {
            console.error('[CloudSync] Error pulling from Firebase:', e.message);
            return false;
        }
    }
};

module.exports = syncOps;
