const crypto = require('crypto');

// провабли фейр логика
// на основе hmac-sha256, как у stake/bc.game и тд
class ProvablyFair {

    static generateServerSeed() {
        return crypto.randomBytes(32).toString('hex');
    }

    static generateClientSeed() {
        return crypto.randomBytes(16).toString('hex');
    }

    // хеш сида для показа юзеру ДО игры (чтобы не могли подменить)
    static hashServerSeed(seed) {
        return crypto.createHash('sha256').update(seed).digest('hex');
    }

    // основная генерация - hmac от комбинации сидов + nonce
    // возвращает float 0..1
    static generateResult(serverSeed, clientSeed, nonce) {
        const hmac = crypto.createHmac('sha256', serverSeed);
        hmac.update(`${clientSeed}:${nonce}`);
        const hex = hmac.digest('hex');
        // берем первые 8 символов (32 бита)
        const val = parseInt(hex.substr(0, 8), 16);
        return val / 0xFFFFFFFF;
    }

    // генерим 2 кубика из хеша
    static generateDice(serverSeed, clientSeed, nonce) {
        const hmac = crypto.createHmac('sha256', serverSeed);
        hmac.update(`${clientSeed}:${nonce}`);
        const hex = hmac.digest('hex');

        // разные части хеша для разных кубиков чтобы были независимые
        const die1 = (parseInt(hex.substr(0, 8), 16) % 6) + 1;
        const die2 = (parseInt(hex.substr(8, 8), 16) % 6) + 1;

        return { dice: [die1, die2], total: die1 + die2, hash: hex, serverSeed, clientSeed, nonce };
    }

    static verify(serverSeed, clientSeed, nonce) {
        return this.generateDice(serverSeed, clientSeed, nonce);
    }

    // расчет выплаты
    static calculatePayout(betType, diceResult, betAmount, rangeBounds) {
        const total = diceResult.total;
        const d1 = diceResult.dice[0], d2 = diceResult.dice[1];

        let won = false;
        let multiplier = 0;

        switch (betType) {
            case 'high':
                won = total >= 8;
                multiplier = won ? 1.75 : 0;
                break;
            case 'low':
                won = total <= 6;
                multiplier = won ? 1.75 : 0;
                break;
            case 'seven':
                won = total === 7;
                multiplier = won ? 3.2 : 0;
                break;
            case 'even':
                won = total % 2 === 0;
                multiplier = won ? 1.7 : 0;
                break;
            case 'odd':
                won = total % 2 !== 0;
                multiplier = won ? 1.7 : 0;
                break;
            case 'doubles':
                won = d1 === d2;
                multiplier = won ? 4.5 : 0;
                break;
            case 'range':
                // ставка на диапазон — множитель по вероятности
                if (rangeBounds) {
                    won = total >= rangeBounds.min && total <= rangeBounds.max;
                    // считаем вероятность
                    let combos = 0;
                    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) {
                        if (a + b >= rangeBounds.min && a + b <= rangeBounds.max) combos++;
                    }
                    const prob = combos / 36;
                    multiplier = won ? parseFloat((0.85 / prob).toFixed(2)) : 0;
                }
                break;
            default:
                // exact_N
                if (betType.startsWith('exact_')) {
                    const target = parseInt(betType.split('_')[1]);
                    won = total === target;
                    const mults = { 2: 32, 3: 15, 4: 10, 5: 7.7, 6: 6.3, 7: 5.2, 8: 6.3, 9: 7.7, 10: 10, 11: 15, 12: 32 };
                    multiplier = won ? (mults[target] || 0) : 0;
                }
                break;
        }

        const payout = won ? betAmount * multiplier : 0;
        return { won, multiplier, payout, profit: payout - betAmount };
    }
}

module.exports = ProvablyFair;
