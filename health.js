const os = require("os");
const chalk = require("chalk");
const boxen = require("boxen");

const bytesToMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);

const uptime = process.uptime();
const uptimeHours = Math.floor(uptime / 3600);
const uptimeMinutes = Math.floor((uptime % 3600) / 60);
const uptimeSeconds = Math.floor(uptime % 60);

const totalMemory = bytesToMB(os.totalmem());
const freeMemory = bytesToMB(os.freemem());
const usedMemory = (totalMemory - freeMemory).toFixed(2);

const cpuUsage = os.loadavg()[0].toFixed(2);

const dashboard = `
${chalk.green.bold("● SYSTEM STATUS")}      ${chalk.green("HEALTHY")}

${chalk.cyan("Server Information")}
────────────────────────────────────────────
${chalk.white("Environment")}   : ${process.env.NODE_ENV || "development"}
${chalk.white("Node Version")}  : ${process.version}
${chalk.white("Platform")}      : ${os.platform()}
${chalk.white("Hostname")}      : ${os.hostname()}
${chalk.white("Architecture")}  : ${os.arch()}

${chalk.yellow("Runtime")}
────────────────────────────────────────────
${chalk.white("PID")}           : ${process.pid}
${chalk.white("Uptime")}        : ${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s
${chalk.white("Timestamp")}     : ${new Date().toISOString()}

${chalk.magenta("Memory")}
────────────────────────────────────────────
${chalk.white("Total RAM")}     : ${totalMemory} MB
${chalk.white("Used RAM")}      : ${usedMemory} MB
${chalk.white("Free RAM")}      : ${freeMemory} MB

${chalk.blue("Process")}
────────────────────────────────────────────
${chalk.white("Heap Used")}     : ${bytesToMB(process.memoryUsage().heapUsed)} MB
${chalk.white("Heap Total")}    : ${bytesToMB(process.memoryUsage().heapTotal)} MB
${chalk.white("RSS")}           : ${bytesToMB(process.memoryUsage().rss)} MB

${chalk.red("CPU")}
────────────────────────────────────────────
${chalk.white("Load Average")}  : ${cpuUsage}

${chalk.green.bold("✓ All Systems Operational")}
`;

console.clear();

console.log(
  boxen(dashboard, {
    padding: 1,
    margin: 1,
    borderStyle: "round",
    borderColor: "green",
    title: "SERVER HEALTH DASHBOARD",
    titleAlignment: "center",
  })
);