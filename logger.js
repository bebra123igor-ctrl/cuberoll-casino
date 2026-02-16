const monitoringLogs = [];

function logMonitor(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    monitoringLogs.unshift(entry);
    if (monitoringLogs.length > 30) monitoringLogs.pop();
    console.log(`[Monitor] ${msg}`);
}

module.exports = { logMonitor, monitoringLogs };
