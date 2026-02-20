const { settingsOps } = require('./database');
const newWallet = 'UQCCy-dvxLvZ8f4_ifO0PqavqPMGJkuONSf6WZNvPU3M0eQf';
console.log('Force updating ton_wallet to:', newWallet);
settingsOps.set('ton_wallet', newWallet);
console.log('Update complete. Current ton_wallet:', settingsOps.get('ton_wallet'));
process.exit(0);
