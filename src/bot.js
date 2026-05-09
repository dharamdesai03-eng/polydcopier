// Telegram bot command layer — polyDcopier v2
// PolyGun-style UX: persistent reply keyboard with 2-column menu, rich
// status header, portfolio view with tree-character formatting, live
// market browser, leader discovery. All previous slash commands remain
// as fallbacks for power users.

const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { stmt } = require('./db');
const { isValidEthAddress, shortAddr } = require('./utils');
const md = require('./polymarket-data');

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';

// ─────────────────────────────── helpers ───────────────────────────────
function escapeMd(s) {
  return String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
function fmt$(n, opts = {}) {
  if (n == null || isNaN(n)) return '\\—';
  const v = Number(n);
  const sign = v < 0 ? '\\-' : '';
  const abs = Math.abs(v);
  const fixed = abs >= 1000 ? abs.toFixed(0) : abs >= 100 ? abs.toFixed(2) : abs.toFixed(2);
  return `${sign}\\$${escapeMd(fixed)}`;
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '\\—';
  const v = Number(n);
  const sign = v >= 0 ? '\\+' : '\\-';
  return `${sign}${escapeMd(Math.abs(v).toFixed(1))}%`;
}
function fmtCent(price) {
  if (price == null || isNaN(price)) return '\\—';
  return escapeMd((Number(price) * 100).toFixed(1)) + '¢';
}
function shortQ(q, n = 60) {
  q = String(q || '');
  return q.length > n ? q.slice(0, n - 1) + '…' : q;
}

// ─────────────────────────── reply-keyboard menu ───────────────────────
const MENU = {
  reply_markup: {
    keyboard: [
      [{ text: '🔍 Markets' }, { text: '🪙 Copy Trade' }],
      [{ text: '📊 Portfolio' }, { text: '💰 Wallet' }],
      [{ text: '🛡 TP/SL' },     { text: '🦞 AutoPilot' }],
      [{ text: '🧠 Smart Wallets' }, { text: '🔄 Refresh' }],
      [{ text: '📝 Limit Orders' }, { text: '👥 Referrals' }],
      [{ text: '⚙️ Settings' },     { text: '📚 Help' }],
      [{ text: '🇺🇸 English' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  },
};

const BACK_BTN = (label = '↩ Back to menu') => ({
  reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'menu' }]] },
});

// ─────────────────────────── welcome / dashboard ───────────────────────
async function buildDashboard(chatId) {
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;

  let activeOrders = 0;
  let totalNetWorth = 0;
  if (addr) {
    try {
      const [bal, summary, positions] = await Promise.all([
        md.getUsdcBalance(addr),
        md.getUserSummary(addr),
        md.getPositions(addr),
      ]);
      const equity = summary?.equity ?? positions.reduce((s, p) => s + p.size * p.currentPrice, 0);
      totalNetWorth = equity + (bal?.total || 0);
      activeOrders = positions.length;
    } catch (_) {}
  }

  const walletLine = addr
    ? `🔌 Wallet: \`${escapeMd(shortAddr(addr))}\``
    : `🔌 Wallet: _not connected_ — tap *💰 Wallet* to link`;

  return (
    `*polyDcopier* 🎯  _Sub\\-200ms Polymarket copy trader_\n\n` +
    `${walletLine}\n` +
    `📊 Open Positions: ${activeOrders}\n` +
    `🏛 Total Net Worth: ${fmt$(totalNetWorth)}\n\n` +
    `Tap a button below to get started\\.\n` +
    `_If bot is slow_, /stats to see latency  ·  /help for commands`
  );
}

// ────────────────────────────── views ──────────────────────────────────
async function viewMarkets() {
  const markets = await md.getTopMarkets({ limit: 10 });
  if (markets.length === 0) {
    return { text: '📡 _Could not load markets right now\\._ Try again in a moment\\.' };
  }
  const lines = markets.map((m, i) => {
    const yes = fmtCent(m.yesPrice);
    const no = fmtCent(m.noPrice);
    const vol = m.volume24h >= 1000
      ? `${(m.volume24h / 1000).toFixed(0)}K`
      : `${m.volume24h.toFixed(0)}`;
    return (
      `*${i + 1}\\.* ${escapeMd(shortQ(m.question, 80))}\n` +
      `├ YES ${yes}  ·  NO ${no}\n` +
      `└ Vol 24h: \\$${escapeMd(vol)}`
    );
  });
  return {
    text:
      `🔍 *Markets — top by 24h volume*\n\n` +
      lines.join('\n\n') +
      `\n\n_Tap a market on Polymarket to drill in_\n` +
      `_Use /addleader to start copying a trader on these markets_`,
    options: {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          ...markets.slice(0, 5).map((m, i) => ([
            { text: `${i + 1}. Open on Polymarket`, url: m.url },
          ])),
          [{ text: '↩ Back to menu', callback_data: 'menu' }],
        ],
      },
    },
  };
}

async function viewPortfolio(chatId) {
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;
  if (!addr) {
    return {
      text:
        `📊 *Portfolio*\n\n` +
        `_No wallet connected\\._\n` +
        `Tap *💰 Wallet* to link your wallet first\\.`,
    };
  }
  const positions = await md.getPositions(addr);
  if (positions.length === 0) {
    return {
      text:
        `📊 *Portfolio* — \`${escapeMd(shortAddr(addr))}\`\n\n` +
        `🟢 *Open Positions*\n_None — start copy\\-trading via /addleader_`,
    };
  }
  const lines = positions.map((p, i) => {
    const cost = p.size * p.entryPrice;
    const value = p.size * p.currentPrice;
    const pnlPct = p.pnlPct != null
      ? p.pnlPct
      : (p.entryPrice > 0 ? (p.currentPrice / p.entryPrice - 1) * 100 : 0);
    return (
      `*${i + 1}\\.* ${escapeMd(shortQ(p.market, 70))}\n` +
      `├ ${escapeMd(p.size.toFixed(2))} ${p.outcome}\n` +
      `├ Avg/Now: ${fmtCent(p.entryPrice)} ▶ ${fmtCent(p.currentPrice)}\n` +
      `├ Cost/Value: ${fmt$(cost)} ▶ ${fmt$(value)}\n` +
      `└ PnL: ${fmt$(p.pnl)} \\(${fmtPct(pnlPct)}\\)`
    );
  });
  return {
    text:
      `📊 *Portfolio*  ·  \`${escapeMd(shortAddr(addr))}\`\n\n` +
      `🟢 *Open Positions* \\(${positions.length}\\)\n\n` +
      lines.join('\n\n'),
  };
}

async function viewWallet(chatId) {
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;
  if (!addr) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    stmt.newNonce.run(nonce, chatId, Math.floor(Date.now() / 1000) + 600);
    const url = `${PUBLIC_URL}/connect?nonce=${nonce}`;
    return {
      text:
        `💰 *Wallet*\n\n` +
        `_No wallet connected\\._\n\n` +
        `One signature unlocks Polymarket trading — works with MetaMask, Coinbase, Rabby, Trust, Phantom, Rainbow, OKX, Brave, Frame\\.\n\n` +
        `Or use \`/setkey <hex>\` to paste a dedicated trading\\-wallet private key\\.`,
      options: {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👛 Connect wallet', url }],
            [{ text: '↩ Back to menu', callback_data: 'menu' }],
          ],
        },
      },
    };
  }
  const [bal, summary] = await Promise.all([
    md.getUsdcBalance(addr),
    md.getUserSummary(addr),
  ]);
  return {
    text:
      `💰 *Wallet*  ·  \`${escapeMd(shortAddr(addr))}\`\n\n` +
      `🪙 USDC \\(native\\): ${fmt$(bal.native)}\n` +
      `🪙 USDC \\(bridged\\): ${fmt$(bal.bridged)}\n` +
      `   *Total liquid:* ${fmt$(bal.total)}\n\n` +
      (summary ? (
        `📈 Polymarket equity: ${fmt$(summary.equity)}\n` +
        `📊 Lifetime volume: ${fmt$(summary.volume)}\n` +
        `💵 Lifetime profit: ${fmt$(summary.profit)}\n`
      ) : '') +
      `\n_Use \`/setkey\` to rotate · /pause to stop the bot_`,
  };
}

async function viewCopyTrade(chatId) {
  const user = stmt.findUser.get(chatId);
  const leaders = stmt.listLeaders.all(chatId);
  const sizePct = ((user?.size_multiplier ?? 0.1) * 100).toFixed(0);
  const maxUsdc = (user?.max_trade_size_usdc ?? 50).toFixed(0);
  const mode = user?.mode || 'COPY';
  const status = user?.bot_enabled ? '🟢 *RUNNING*' : '🔴 *PAUSED*';

  const leaderLines = leaders.length
    ? leaders.map((l, i) => {
        const lbl = l.label ? ` *${escapeMd(l.label)}*` : '';
        return `*${i + 1}\\.* \`${escapeMd(shortAddr(l.address))}\`${lbl}`;
      }).join('\n')
    : '_no leaders yet — add one with /addleader_';

  return {
    text:
      `🪙 *Copy Trade*  ·  ${status}\n\n` +
      `Mode: *${mode}*  \\(COPY mirrors \\| ZIG fades \\| PAUSE stops\\)\n` +
      `Sizing: *${escapeMd(sizePct)}%* of leader, cap ${fmt$(maxUsdc)}/trade\n\n` +
      `*Leaders \\(${leaders.length}\\)*\n${leaderLines}\n\n` +
      `Commands:\n` +
      `\`/addleader 0x… [label]\`\n` +
      `\`/removeleader 0x…\`\n` +
      `\`/mode COPY\\|ZIG\\|PAUSE\`\n` +
      `\`/setsize 10 50\`  _\\(10% of leader, max \\$50\\)_\n` +
      `\`/setfilter 0x… min_price=0.10 max_price=0.90\`\n` +
      `\`/pause\`  ·  \`/resume\``,
  };
}

async function viewSmartWallets() {
  const lb = await md.getLeaderboard({ limit: 10 });
  if (lb.length === 0) {
    return {
      text:
        `🧠 *Smart Wallets — top traders*\n\n` +
        `_Live leaderboard is loading\\. Try again in a moment\\._\n\n` +
        `In the meantime, paste any trader's address with /addleader to start copying\\.`,
    };
  }
  const lines = lb.map((t, i) => {
    const name = t.name ? escapeMd(t.name) : `\`${escapeMd(shortAddr(t.address))}\``;
    return (
      `*${i + 1}\\.* ${name}\n` +
      `├ Profit: ${fmt$(t.profit)}\n` +
      `└ \`${escapeMd(t.address)}\``
    );
  });
  return {
    text:
      `🧠 *Smart Wallets* — top traders\n\n` +
      lines.join('\n\n') +
      `\n\nTap a row, copy the address, then \`/addleader 0x… <name>\` to copy them\\.`,
  };
}

async function viewStats(chatId) {
  const s = stmt.statsForChat.get(chatId) || {};
  const recent = stmt.listRecentTrades.all(chatId, 5);
  const lines = (recent.map(t => {
    const ts = new Date((t.detected_at || 0) * 1000);
    const time = ts.toISOString().slice(11, 16) + 'Z';
    const ic = t.status === 'submitted' ? '✅'
            : t.status === 'paper'     ? '📝'
            : t.status === 'failed'    ? '❌'
            : t.status === 'skipped'   ? '⏭'
            : '•';
    return `${ic} \`${escapeMd(time)}\` ${escapeMd(shortQ(t.market_name || '', 30))} ${t.side || ''} ${fmt$(t.notional_usdc)}`;
  }).join('\n')) || '_no trades yet_';

  return {
    text:
      `📈 *Stats*\n\n` +
      `Trades total: ${s.n_total || 0}\n` +
      `✅ Submitted: ${s.n_submitted || 0}  ·  ❌ Failed: ${s.n_failed || 0}\n` +
      `⏭ Skipped: ${s.n_skipped || 0}  ·  📝 Paper: ${s.n_paper || 0}\n` +
      `⚡ Avg latency: ${s.avg_latency ? Math.round(s.avg_latency) + 'ms' : '\\—'}\n` +
      `💵 Realized PnL: ${fmt$(s.total_pnl)}\n\n` +
      `*Last 5 trades*\n${lines}`,
  };
}

const HELP_TEXT =
  `*polyDcopier — full command list*\n\n` +
  `*Setup*\n` +
  `\`/connect\` — link wallet via WalletConnect\n` +
  `\`/setkey <hex>\` — paste a trading\\-wallet private key\n\n` +
  `*Leaders*\n` +
  `\`/addleader 0x… [label]\`\n` +
  `\`/listleaders\`  ·  \`/removeleader 0x…\`\n\n` +
  `*Copy settings*\n` +
  `\`/mode COPY\\|ZIG\\|PAUSE\`\n` +
  `\`/setsize <pct> <max_usdc>\`  _\\(e\\.g\\. 10 50\\)_\n` +
  `\`/setfilter 0x… key=value …\`\n` +
  `\`/filters\`  ·  \`/pause\`  ·  \`/resume\`\n\n` +
  `*Activity*\n` +
  `\`/stats\` · \`/portfolio\`\n\n` +
  `*Tips*\n` +
  `Use a *dedicated* trading wallet \\(not your main\\)\\.\n` +
  `Your key is encrypted with AES\\-256\\-GCM and decrypted JIT in memory\\.`;

const SETTINGS_TEXT = (user) =>
  `⚙️ *Settings*\n\n` +
  `Mode: *${user?.mode || 'COPY'}*\n` +
  `Size: *${((user?.size_multiplier ?? 0.1) * 100).toFixed(0)}%* of leader\n` +
  `Cap: ${fmt$(user?.max_trade_size_usdc ?? 50)}/trade\n` +
  `Status: ${user?.bot_enabled ? '🟢 RUNNING' : '🔴 PAUSED'}\n\n` +
  `Change with:\n` +
  `\`/mode COPY\\|ZIG\\|PAUSE\`\n` +
  `\`/setsize <pct> <max>\`\n` +
  `\`/pause\` · \`/resume\``;

const TPSL_TEXT =
  `🛡 *Take Profit / Stop Loss*\n\n` +
  `_Coming in v2\\.1\\._\n\n` +
  `For now, set per\\-leader filters to limit risk:\n` +
  `\`/setfilter 0x… min_price=0.20 max_price=0.80\`\n\n` +
  `min\\_price = don't copy if price below this\n` +
  `max\\_price = don't copy if price above this`;

const AUTOPILOT_TEXT =
  `🦞 *AutoPilot*\n\n` +
  `_Coming soon\\._ AutoPilot will auto\\-add the top 5 Smart Wallets and tune sizing based on their hit rate\\.\n\n` +
  `For now, browse *🧠 Smart Wallets* and add manually\\.`;

const LIMIT_TEXT =
  `📝 *Limit Orders*\n\n` +
  `_Coming in v2\\.1\\._\n\n` +
  `polyDcopier currently fires *market orders* on every leader fill — that's how it stays sub\\-200ms\\.\n` +
  `Standalone limit orders \\(without a leader trigger\\) are on the roadmap\\.`;

const REFERRALS_TEXT = (chatId) =>
  `👥 *Referrals*\n\n` +
  `Share polyDcopier with friends:\n` +
  `https://t\\.me/polyDcopier\\_bot?start\\=ref\\_${chatId}\n\n` +
  `_Referral rewards launching with v2\\.1_`;

// ─────────────────────────── send + setup ───────────────────────────
function send(bot, chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    ...MENU,
    ...extra,
  });
}

function sendWithCustomKb(bot, chatId, text, replyMarkup) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

function setup(bot, orchestrator) {

  // ---- /start ---------------------------------------------------------
  bot.onText(/\/start(?:\s|$|.*)/, async (msg) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    try {
      const text = await buildDashboard(chatId);
      send(bot, chatId, text);
    } catch (e) {
      send(bot, chatId, `*Welcome to polyDcopier* 🎯\n\nTap a button below to get started\\.`);
    }
  });

  // ---- /menu ----------------------------------------------------------
  bot.onText(/\/menu/, async (msg) => {
    const text = await buildDashboard(msg.chat.id);
    send(bot, msg.chat.id, text);
  });

  // ---- reply-keyboard button handlers --------------------------------
  // These match the buttons in MENU. We listen for plain text equal to
  // the button label.
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    try {
      switch (text) {
        case '🔍 Markets': {
          const v = await viewMarkets();
          if (v.options) sendWithCustomKb(bot, chatId, v.text, v.options.reply_markup);
          else send(bot, chatId, v.text);
          return;
        }
        case '🪙 Copy Trade': {
          const v = await viewCopyTrade(chatId);
          send(bot, chatId, v.text);
          return;
        }
        case '📊 Portfolio': {
          const v = await viewPortfolio(chatId);
          send(bot, chatId, v.text);
          return;
        }
        case '💰 Wallet': {
          const v = await viewWallet(chatId);
          if (v.options) sendWithCustomKb(bot, chatId, v.text, v.options.reply_markup);
          else send(bot, chatId, v.text);
          return;
        }
        case '🛡 TP/SL':
          send(bot, chatId, TPSL_TEXT); return;
        case '🦞 AutoPilot':
          send(bot, chatId, AUTOPILOT_TEXT); return;
        case '🧠 Smart Wallets': {
          const v = await viewSmartWallets();
          send(bot, chatId, v.text);
          return;
        }
        case '🔄 Refresh': {
          const t = await buildDashboard(chatId);
          send(bot, chatId, t);
          return;
        }
        case '📝 Limit Orders':
          send(bot, chatId, LIMIT_TEXT); return;
        case '👥 Referrals':
          send(bot, chatId, REFERRALS_TEXT(chatId)); return;
        case '⚙️ Settings': {
          const u = stmt.findUser.get(chatId);
          send(bot, chatId, SETTINGS_TEXT(u));
          return;
        }
        case '📚 Help':
          send(bot, chatId, HELP_TEXT); return;
        case '🇺🇸 English':
          send(bot, chatId, '_polyDcopier currently supports English only\\. Other languages coming soon\\._');
          return;
      }
    } catch (e) {
      send(bot, chatId, `❌ Something glitched: ${escapeMd(e.message || String(e))}`);
    }
  });

  // ---- callback (inline keyboard) ------------------------------------
  bot.on('callback_query', async (q) => {
    try {
      if (q.data === 'menu') {
        const t = await buildDashboard(q.message.chat.id);
        send(bot, q.message.chat.id, t);
      }
      bot.answerCallbackQuery(q.id);
    } catch (_) {}
  });

  // ===================== existing commands (unchanged) ===================

  bot.onText(/\/help/, (msg) => send(bot, msg.chat.id, HELP_TEXT));

  bot.onText(/\/connect/, (msg) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    const nonce = crypto.randomBytes(24).toString('base64url');
    stmt.newNonce.run(nonce, chatId, Math.floor(Date.now() / 1000) + 600);
    const url = `${PUBLIC_URL}/connect?nonce=${nonce}`;
    sendWithCustomKb(bot, chatId,
      `💰 *Connect your wallet*\n\nOne signature unlocks Polymarket trading — MetaMask, Coinbase, Rabby, Trust, Phantom, Rainbow, OKX, Brave, Frame\\.`,
      { inline_keyboard: [
        [{ text: '👛 Connect wallet', url }],
        [{ text: '↩ Back to menu', callback_data: 'menu' }],
      ]});
  });

  bot.onText(/\/setkey(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    const arg = (match[1] || '').trim();
    if (!arg) {
      send(bot, chatId,
        `Usage: \`/setkey <0x...64hex>\`\n\n⚠️ Use a *dedicated* trading wallet\\. Key is encrypted with AES\\-256\\-GCM\\.`);
      return;
    }
    const { isValidPrivateKey, encrypt } = require('./utils');
    const { ethers } = require('ethers');
    if (!isValidPrivateKey(arg)) {
      send(bot, chatId, '❌ Not a valid 64\\-hex private key\\.');
      return;
    }
    try {
      const wallet = new ethers.Wallet(arg.startsWith('0x') ? arg : '0x' + arg);
      const addr = wallet.address;
      const enc = encrypt(arg);
      const { getClobAuthRequest, deriveApiKey } = require('./polymarket');
      const ts = String(Math.floor(Date.now() / 1000));
      const req = getClobAuthRequest(addr, ts);
      const sig = await wallet.signTypedData(req.domain, req.types, req.message);
      const creds = await deriveApiKey({ address: addr, signature: sig, timestamp: ts });
      stmt.setUserCreds.run(addr, enc, creds.apiKey, creds.secret || creds.apiSecret, creds.passphrase, chatId);
      send(bot, chatId,
        `✅ Wallet linked: \`${escapeMd(shortAddr(addr))}\`\n\n` +
        `Polymarket API key derived\\. Tap *🪙 Copy Trade* to add leaders\\.\n\n` +
        `_Tip: delete the message above containing your key_`);
    } catch (e) {
      send(bot, chatId, `❌ Failed: ${escapeMd(e.message || String(e))}`);
    }
  });

  bot.onText(/\/addleader(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const addr = (match[1] || '').trim().toLowerCase();
    const label = (match[2] || '').trim() || null;
    if (!isValidEthAddress(addr)) {
      send(bot, chatId, 'Usage: `/addleader <0x...address> [label]`'); return;
    }
    stmt.addLeader.run(chatId, addr, label);
    send(bot, chatId,
      `✅ Tracking \`${escapeMd(shortAddr(addr))}\`${label ? ` \\(${escapeMd(label)}\\)` : ''}\\.\n\n` +
      `Tap *🪙 Copy Trade* to see your roster\\.`);
  });

  bot.onText(/\/listleaders/, (msg) => {
    const rows = stmt.listLeaders.all(msg.chat.id);
    if (rows.length === 0) {
      send(bot, msg.chat.id, '_No leaders yet\\._ Use `/addleader 0x…` to start\\.'); return;
    }
    const lines = rows.map(r => {
      const lbl = r.label ? ` *${escapeMd(r.label)}*` : '';
      return `• \`${escapeMd(shortAddr(r.address))}\`${lbl}`;
    });
    send(bot, msg.chat.id, `*Tracked leaders \\(${rows.length}\\)*\n\n${lines.join('\n')}`);
  });

  bot.onText(/\/removeleader(?:\s+(\S+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    if (!isValidEthAddress(addr)) {
      send(bot, msg.chat.id, 'Usage: `/removeleader <0x...address>`'); return;
    }
    stmt.removeLeader.run(msg.chat.id, addr);
    send(bot, msg.chat.id, `🗑 Removed \`${escapeMd(shortAddr(addr))}\``);
  });

  bot.onText(/\/mode(?:\s+(\S+))?/, (msg, match) => {
    const m = (match[1] || '').toUpperCase();
    if (!['COPY', 'ZIG', 'PAUSE'].includes(m)) {
      send(bot, msg.chat.id, 'Usage: `/mode COPY | ZIG | PAUSE`'); return;
    }
    stmt.setMode.run(m, msg.chat.id);
    send(bot, msg.chat.id, `Mode set to *${m}*`);
  });

  bot.onText(/\/pause/, (msg) => {
    stmt.setBotEnabled.run(0, msg.chat.id);
    send(bot, msg.chat.id, '⏸ Bot paused\\. /resume to start again\\.');
  });
  bot.onText(/\/resume/, (msg) => {
    stmt.setBotEnabled.run(1, msg.chat.id);
    send(bot, msg.chat.id, '▶️ Bot resumed\\.');
  });

  bot.onText(/\/setsize(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?/, (msg, match) => {
    const pct = parseFloat(match[1]);
    const max = parseFloat(match[2]);
    if (!isFinite(pct) || !isFinite(max)) {
      send(bot, msg.chat.id, 'Usage: `/setsize <percent> <max_usdc_per_trade>`'); return;
    }
    stmt.setSizing.run(pct / 100, max, msg.chat.id);
    send(bot, msg.chat.id, `Size: *${pct}%* of leader, max ${fmt$(max)} per trade\\.`);
  });

  bot.onText(/\/stats/, async (msg) => {
    const v = await viewStats(msg.chat.id);
    send(bot, msg.chat.id, v.text);
  });

  bot.onText(/\/portfolio/, async (msg) => {
    const v = await viewPortfolio(msg.chat.id);
    send(bot, msg.chat.id, v.text);
  });

  bot.onText(/\/filters/, (msg) => {
    const rows = stmt.listLeaders.all(msg.chat.id);
    if (rows.length === 0) { send(bot, msg.chat.id, '_No leaders yet\\._'); return; }
    const lines = rows.map(r => {
      const f = [];
      if (r.filter_min_price != null || r.filter_max_price != null) {
        f.push(`price ${r.filter_min_price ?? '0'}–${r.filter_max_price ?? '1'}`);
      }
      if (r.filter_only_side) f.push(r.filter_only_side + ' only');
      if (r.filter_only_outcome) f.push(r.filter_only_outcome + ' only');
      if (r.filter_min_leader_usdc != null) f.push(`min $${r.filter_min_leader_usdc}`);
      if (r.filter_cooldown_minutes) f.push(`cooldown ${r.filter_cooldown_minutes}m`);
      const fs = f.length ? ' · ' + f.join(', ') : ' · no filters';
      return `\`${escapeMd(shortAddr(r.address))}\`${escapeMd(fs)}`;
    });
    send(bot, msg.chat.id,
      `*Per\\-leader filters*\n\n${lines.join('\n')}\n\n` +
      `Set with \`/setfilter <addr> key=value\` _\\(see /help\\)_`);
  });

  bot.onText(/\/setfilter(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    const rest = (match[2] || '').trim();
    if (!isValidEthAddress(addr) || !rest) {
      send(bot, msg.chat.id,
        'Usage: `/setfilter <addr> key=value …`\n\nKeys: `min_price` `max_price` `min_hours` `max_hours` `side` `outcome` `min_leader_usdc` `cooldown_min`');
      return;
    }
    const rows = stmt.listLeaders.all(msg.chat.id).filter(r => r.address.toLowerCase() === addr);
    if (rows.length === 0) { send(bot, msg.chat.id, 'Not tracking that address\\. Use /addleader first\\.'); return; }
    const r = rows[0];
    const next = {
      min_price: r.filter_min_price, max_price: r.filter_max_price,
      min_hours: r.filter_min_hours_to_close, max_hours: r.filter_max_hours_to_close,
      side: r.filter_only_side, outcome: r.filter_only_outcome,
      min_leader_usdc: r.filter_min_leader_usdc, cooldown_min: r.filter_cooldown_minutes,
    };
    for (const part of rest.split(/\s+/)) {
      const [k, v] = part.split('=');
      if (!(k in next)) continue;
      if (['side', 'outcome'].includes(k)) next[k] = v.toUpperCase();
      else next[k] = v === 'null' || v === '' ? null : Number(v);
    }
    stmt.setLeaderFilters.run(
      next.min_price, next.max_price,
      next.min_hours, next.max_hours,
      next.side, next.outcome,
      next.min_leader_usdc, next.cooldown_min,
      r.id,
    );
    send(bot, msg.chat.id, `Filters updated for \`${escapeMd(shortAddr(addr))}\`\\.`);
  });

  // ---- Live trade notifications ---------------------------------------
  orchestrator.on('trade', (p) => {
    const market = shortQ(p.market || '', 60);
    if (p.status === 'submitted') {
      const ic = p.mode === 'ZIG' ? '↔️' : '⚡';
      bot.sendMessage(p.chat_id,
        `${ic} *${p.mode} fired*\n` +
        `${escapeMd(market)}\n` +
        `${p.side} ${escapeMd(String(p.outcome || ''))} @ ${fmtCent(p.price)}  ·  ` +
        `${fmt$(p.size * p.price)}  ·  *${p.latency_ms}ms*`,
        { parse_mode: 'MarkdownV2', ...MENU });
    } else if (p.status === 'paper') {
      bot.sendMessage(p.chat_id,
        `📝 *Paper trade* · ${escapeMd(market)} ${p.side} @ ${fmtCent(p.price)}`,
        { parse_mode: 'MarkdownV2', ...MENU });
    } else if (p.status === 'failed') {
      bot.sendMessage(p.chat_id, `❌ Trade failed: ${escapeMd((p.error_msg || '').slice(0, 200))}`,
        { parse_mode: 'MarkdownV2', ...MENU });
    }
  });
}

module.exports = { setup };
