// polyDcopier — Telegram bot entrypoint.
// Wires: Telegram bot ↔ Orchestrator ↔ Mempool watcher ↔ DB ↔ Express server.
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Orchestrator, PAPER_TRADE } = require('./orchestrator');
const { MempoolWatcher } = require('./mempool');
const { setup: setupBotCommands } = require('./bot');
const { start: startServer } = require('./server');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN env var is required.');
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3000);
const ALCHEMY_WS = process.env.ALCHEMY_WS_URL;

async function main() {
  // 1. Express HTTPS host (Mini App + wallet-connect callback)
  await startServer(PORT);

  // 2. Orchestrator — converts mempool events into copy orders
  const orchestrator = new Orchestrator();

  // 3. Telegram bot — long polling (no webhook required, makes Render free
  //    tier viable; we still serve HTTPS for the Mini App separately).
  const bot = new TelegramBot(TOKEN, { polling: true });
  setupBotCommands(bot, orchestrator);

  bot.on('polling_error', (e) => console.warn('[telegram] polling_error:', e.code, e.message || ''));

  // 4. Mempool watcher — refresh watched-leaders set on every event so we
  //    don't have to reconnect when users add/remove leaders.
  const watcher = new MempoolWatcher({
    alchemyWsUrl: ALCHEMY_WS,
    getWatchedAddresses: () => orchestrator.getWatchedAddresses(),
  });
  watcher.on('leaderFill', (ev) => orchestrator.onLeaderFill(ev).catch(e => {
    console.error('[main] orchestrator error:', e);
  }));
  watcher.on('connected', () => console.log('[main] mempool live'));
  watcher.on('disconnected', () => console.log('[main] mempool down — auto-reconnecting'));
  watcher.start();

  // 5. Heartbeat log
  setInterval(() => {
    const watched = orchestrator.getWatchedAddresses();
    console.log(`[hb] ${new Date().toISOString()}  watching=${watched.size}  mempool=${watcher.isHealthy() ? 'up' : 'down'}  paper=${PAPER_TRADE}`);
  }, 30000);

  console.log(`[polyDcopier] Telegram bot live · paper=${PAPER_TRADE} · port=${PORT}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
