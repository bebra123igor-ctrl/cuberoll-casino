const crypto = require('crypto');

class ProvablyFair {
    /**
     * Generate a random server seed
     */
    static generateServerSeed() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Generate a default client seed
     */
    static generateClientSeed() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * Create a SHA-256 hash of the server seed (shown to user before game)
     */
    static hashServerSeed(serverSeed) {
        return crypto.createHash('sha256').update(serverSeed).digest('hex');
    }

    /**
     * Generate HMAC-based result from seeds and nonce
     * Returns a value between 0 and 1
     */
    static generateResult(serverSeed, clientSeed, nonce) {
        const hmac = crypto.createHmac('sha256', serverSeed);
        hmac.update(`${clientSeed}:${nonce}`);
        const hex = hmac.digest('hex');

        // Use first 8 chars of hex (32 bits) for precision
        const intValue = parseInt(hex.substr(0, 8), 16);
        return intValue / 0xFFFFFFFF; // normalize to 0-1
    }

    /**
     * Generate two dice results (1-6 each) from the provably fair result
     */
    static generateDice(serverSeed, clientSeed, nonce) {
        const hmac = crypto.createHmac('sha256', serverSeed);
        hmac.update(`${clientSeed}:${nonce}`);
        const hex = hmac.digest('hex');

        // Use different parts of the hash for each die
        const die1 = (parseInt(hex.substr(0, 8), 16) % 6) + 1;
        const die2 = (parseInt(hex.substr(8, 8), 16) % 6) + 1;

        return {
            dice: [die1, die2],
            total: die1 + die2,
            hash: hex,
            serverSeed,
            clientSeed,
            nonce
        };
    }

    /**
     * Verify a game result
     */
    static verify(serverSeed, clientSeed, nonce) {
        return this.generateDice(serverSeed, clientSeed, nonce);
    }

    /**
     * Calculate multiplier based on bet type and result
     * Bet types:
     *   - 'high' (8-12): 2x
     *   - 'low' (2-6): 2x
     *   - 'seven' (exactly 7): 4x
     *   - 'exact_N' (exact total): varies
     *   - 'even': 1.9x
     *   - 'odd': 1.9x
     *   - 'doubles': 5x
     */
    static calculatePayout(betType, diceResult, betAmount) {
        const total = diceResult.total;
        const d1 = diceResult.dice[0];
        const d2 = diceResult.dice[1];
        const isDoubles = d1 === d2;

        let won = false;
        let multiplier = 0;

        switch (betType) {
            case 'high':
                won = total >= 8;
                multiplier = won ? 1.95 : 0;
                break;

            case 'low':
                won = total <= 6;
                multiplier = won ? 1.95 : 0;
                break;

            case 'seven':
                won = total === 7;
                multiplier = won ? 3.5 : 0;
                break;

            case 'even':
                won = total % 2 === 0;
                multiplier = won ? 1.9 : 0;
                break;

            case 'odd':
                won = total % 2 !== 0;
                multiplier = won ? 1.9 : 0;
                break;

            case 'doubles':
                won = isDoubles;
                multiplier = won ? 5.0 : 0;
                break;

            default:
                // Exact number bet (e.g., 'exact_9')
                if (betType.startsWith('exact_')) {
                    const target = parseInt(betType.split('_')[1]);
                    won = total === target;
                    // Multiplier based on probability
                    const exactMultipliers = {
                        2: 35, 3: 17, 4: 11, 5: 8.5, 6: 7,
                        7: 5.8, 8: 7, 9: 8.5, 10: 11, 11: 17, 12: 35
                    };
                    multiplier = won ? (exactMultipliers[target] || 0) : 0;
                }
                break;
        }

        const payout = won ? betAmount * multiplier : 0;
        const profit = payout - betAmount;

        return {
            won,
            multiplier,
            payout,
            profit
        };
    }
}

module.exports = ProvablyFair;
