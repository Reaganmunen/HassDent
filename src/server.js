require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/db');
const { assertConfig } = require('./services/auth.service');

assertConfig(); // stop immediately if JWT_SECRET is missing or weak

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => {
  console.log(`HassDent app:  http://localhost:${port}`);          // open this one in the browser
  console.log(`HassDent API:  http://localhost:${port}/api/v1`);   // JSON only, needs a login token
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref(); // don't hang forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));