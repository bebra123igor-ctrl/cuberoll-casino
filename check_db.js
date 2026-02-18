const Database = require('better-sqlite3');
const db = new Database('cuberoll.db');
const rows = db.prepare('SELECT id, title, link, gift_id, slug FROM gifts LIMIT 10').all();
console.log(JSON.stringify(rows, null, 2));
db.close();
