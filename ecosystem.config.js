module.exports = {
    apps: [
        {
            name: 'cuberoll-casino',
            script: 'server.js',
            env: {
                NODE_ENV: 'production',
                PORT: 3000
            }
        }
    ]
};
