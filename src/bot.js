// Telegram bot command layer — polyDcopier v3
// Full feature parity with PolyGun-style Telegram trading bots:
//   • Persistent 2-column reply keyboard
//   • Inline keyboards in every view (tap to act, not type)
//   • Working TP/SL, AutoPilot, Limit Orders, Referrals
//   • Pending-input flow (bot asks for a value → user types → bot stores)
//
// All long-form copy text is original, not copied from any other product.

const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { stmt } = require('./db');
const { isValidEthAddress, shortAddr } = require('./utils');
const md = require('./polymarket-data');

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';

// ────────────────────────────── helpers ────────────────────────────────
function escapeMd(s) {
  return String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
function fmt$(n) {
  if (n == null || isNaN(n)) return '\\—';
  const v = Number(n);
  const sign = v < 0 ? '\\-' : '';
  const abs = Math.abs(v);
  return `${sign}\\$${escapeMd(abs.toFixed(2))}`;
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '\\—';
  const v = Number(n);
  const sign = v >= 0 ? '\\+' : '\\-';
  return `${sign}${escapeMd(Math.abs(v).toFixed(1))}%`;
}
function fmtCent(p) {
  if (p == null || isNaN(p)) return '\\—';
  return escapeMd((Number(p) * 100).toFixed(1)) + '¢';
}
function shortQ(q, n = 60) {
  q = String(q || '');
  return q.length > n ? q.slice(0, n - 1) + '…' : q;
}
function genRefCode(chatId) {
  return crypto.createHash('sha256').update(`pdc:${chatId}`).digest('base64url').slice(0, 8);
}

// ──────────────────── persistent reply keyboard (main menu) ───────────
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

const BACK = { text: '↩ Back', callback_data: 'menu' };

// ──────────────────────── dashboard / welcome ─────────────────────────
async function buildDashboard(chatId) {
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;
  let openCount = 0;
  let netWorth = 0;
  let liquid = 0;
  if (addr) {
    try {
      const [bal, sum, pos] = await Promise.all([
        md.getUsdcBalance(addr), md.getUserSummary(addr), md.getPositions(addr),
      ]);
      const equity = sum?.equity ?? pos.reduce((s, p) => s + p.size * p.currentPrice, 0);
      liquid = bal?.total || 0;
      netWorth = equity + liquid;
      openCount = pos.length;
    } catch (_) {}
  }
  const wline = addr
    ? `🔌 Wallet: \`${escapeMd(shortAddr(addr))}\``
    : `🔌 Wallet: _not connected_ — tap *💰 Wallet* below`;

  return (
    `*polyDcopier* 🎯  _sub\\-200ms Polymarket copy trader_\n\n` +
    `${wline}\n` +
    `📊 Active Orders: ${openCount}\n` +
    `🏛 Total Net Worth: ${fmt$(netWorth)}\n` +
    `💵 Liquid USDC: ${fmt$(liquid)}\n\n` +
    `Tap a button below to begin\\.\n` +
    `_/help_ for the full command list`
  );
}

// ──────────────────────────── views ───────────────────────────────────
async function viewMarkets(chatId, page = 0) {
  const all = await md.getTopMarkets({ limit: 30 });
  const pageSize = 5;
  const slice = all.slice(page * pageSize, page * pageSize + pageSize);
  if (slice.length === 0) {
    return { text: '_Markets API is loading_\\. Try again in a moment\\.', kb: [[BACK]] };
  }
  const lines = slice.map((m, i) => {
    const idx = page * pageSize + i + 1;
    const vol = m.volume24h >= 1000 ? `${(m.volume24h / 1000).toFixed(0)}K` : `${m.volume24h.toFixed(0)}`;
    return (
      `*${idx}\\.* ${escapeMd(shortQ(m.question, 75))}\n` +
      `├ YES ${fmtCent(m.yesPrice)}  ·  NO ${fmtCent(m.noPrice)}\n` +
      `└ Vol 24h: \\$${escapeMd(vol)}`
    );
  });
  const navRow = [];
  if (page > 0) navRow.push({ text: '◀ Prev', callback_data: `mkt:${page - 1}` });
  if ((page + 1) * pageSize < all.length) navRow.push({ text: 'Next ▶', callback_data: `mkt:${page + 1}` });
  const kb = [
    ...slice.map((m, i) => ([{ text: `${page * pageSize + i + 1}. View on Polymarket`, url: m.url }])),
    navRow.length ? navRow : [],
    [BACK],
  ].filter(r => r.length);
  return {
    text: `🔍 *Markets* — top by 24h vol  \\(page ${page + 1}\\)\n\n` + lines.join('\n\n'),
    kb,
  };
}

async function viewPortfolio(chatId) {
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;
  if (!addr) {
    return {
      text: `📊 *Portfolio*\n\n_No wallet linked\\._\nTap *💰 Wallet* to connect first\\.`,
      kb: [[{ text: '💰 Connect Wallet', callback_data: 'view:wallet' }], [BACK]],
    };
  }
  const positions = await md.getPositions(addr);
  if (positions.length === 0) {
    return {
      text:
        `📊 *Portfolio* · \`${escapeMd(shortAddr(addr))}\`\n\n` +
        `🟢 *Open Positions*\n_None yet\\._\n\n` +
        `Add a leader from *🧠 Smart Wallets* to start auto\\-copy\\.`,
      kb: [
        [{ text: '🧠 Smart Wallets', callback_data: 'view:smart' }],
        [{ text: '🔄 Refresh', callback_data: 'view:portfolio' }],
        [BACK],
      ],
    };
  }
  const lines = positions.slice(0, 8).map((p, i) => {
    const cost = p.size * p.entryPrice;
    const value = p.size * p.currentPrice;
    const pct = p.pnlPct != null ? p.pnlPct
      : (p.entryPrice > 0 ? (p.currentPrice / p.entryPrice - 1) * 100 : 0);
    return (
      `*${i + 1}\\.* ${escapeMd(shortQ(p.market, 70))}\n` +
      `├ ${escapeMd(p.size.toFixed(2))} ${p.outcome}\n` +
      `├ Avg/Now: ${fmtCent(p.entryPrice)} ▶ ${fmtCent(p.currentPrice)}\n` +
      `├ Cost/Value: ${fmt$(cost)} ▶ ${fmt$(value)}\n` +
      `└ PnL: ${fmt$(p.pnl)} \\(${fmtPct(pct)}\\)`
    );
  });
  const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);
  const totalValue = positions.reduce((s, p) => s + p.size * p.currentPrice, 0);
  return {
    text:
      `📊 *Portfolio* · \`${escapeMd(shortAddr(addr))}\`\n\n` +
      `🟢 *Open Positions* \\(${positions.length}\\)\n` +
      `Total value: ${fmt$(totalValue)}  ·  PnL: ${fmt$(totalPnl)}\n\n` +
      lines.join('\n\n'),
    kb: [
      [{ text: '🛡 Set TP/SL', callback_data: 'view:tpsl' }],
      [{ text: '🔄 Refresh', callback_data: 'view:portfolio' }],
      [BACK],
    ],
  };
}

async function viewWallet(chatId) {
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;
  if (!addr) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    stmt.newNonce.run(nonce, chatId, Math.floor(Date.now() / 1000) + 600);
    return {
      text:
        `💰 *Wallet)\n\n_No wallet linked\\._\n\n` +
        `One signature unlocks Polymarket trading\\. Works with MetaMask, Coinbase, Rabby, Trust, Phantom, Rainbow, OKX, Brave, Frame\\.`,
      kb: [
        [{ text: '👛 Connect Wallet', url: `${PUBLIC_URL}/connect?nonce=${nonce}` }],
        [{ text: '🔑 Use Private Key', callback_data: 'help:setkey' }],
        [BACK],
      ],
    };
  }
  const [bal, summary] = await Promise.all([
    md.getUsdcBalance(addr), md.getUserSummary(addr),
  ]);
  return {
    text:
      `💰 *Wallet* · \`${escapeMd(shortAddr(addr))}\`\n\n` +
      `🪙 USDC \\(native\\): ${fmt$(bal.native)}\n` +
      `🪙 USDC \\(bridged\\): ${fmt$(bal.bridged)}\n` +
      `   *Total liquid:* ${fmt$(bal.total)}\n` +
      (summary ? (
        `\n📈 Polymarket equity: ${fmt$(summary.equity)}\n` +
        `📊 Lifetime volume: ${fmt$(summary.volume)}\n` +
        `💵 Lifetime profit: ${fmt$(summary.profit)}\n`
      ) : '') +
      `\n_Use_ \`/setkey\` _to rotate the trading key_`,
    kb: [
      [{ text: '🔄 Refresh', callback_data: 'view:wallet' }],
      [{ text: '🔌 Reconnect', callback_data: 'view:reconnect' }],
      [BACK],
    ],
  };
}

async function viewCopyTrade(chatId) {
  const user = stmt.findUser.get(chatId);
  const leaders = stmt.listLeaders.all(chatId);
  const sizePct = ((user?.size_multiplier ?? 0.1) * 100).toFixed(0);
  const maxUsdc = (user?.max_trade_size_usdc ?? 50).toFixed(0);
  const mode = user?.mode || 'COPY';
  const running = !!user?.bot_enabled;

  const leaderLines = leaders.length
    ? leaders.slice(0, 8).map((l, i) => {
        const lbl = l.label ? ` *${escapeMd(l.label)}*` : '';
        return `*${i + 1}\\.* \`${escapeMd(shortAddr(l.address))}\`${lbl}`;
      }).join('\n')
    : '_No leaders yet — add one below or browse 🧠 Smart Wallets_';

  const kb = [
    [
      { text: running ? '⏸ Pause' : '▶ Resume', callback_data: running ? 'act:pause' : 'act:resume' },
      { text: `🔁 Mode: ${mode}`, callback_data: 'act:cyclemode' },
    ],
    [
      { text: `📏 Size ${sizePct}%`, callback_data: 'ask:setsize' },
      { text: `💵 Cap $${maxUsdc}`, callback_data: 'ask:setcap' },
    ],
    [{ text: '➕ Add Leader', callback_data: 'ask:addleader' }],
    leaders.length ? [{ text: '🗑 Remove Leader', callback_data: 'view:removeleader' }] : [],
    [{ text: '🧠 Browse Smart Wallets', callback_data: 'view:smart' }],
    [BACK],
  ].filter(r => r.length);

  return {
    text:
      `🪙 *Copy Trade* · ${running ? '🟢 RUNNING' : '🔴 PAUSED'}\n\n` +
      `Mode: *${mode}*  \\(COPY mirrors \\| ZIG fades \\| PAUSE stops\\)\n` +
      `Sizing: *${escapeMd(sizePct)}%* of leader, cap ${fmt$(maxUsdc)}/trade\n\n` +
      `*Leaders \\(${leaders.length}\\)*\n${leaderLines}`,
    kb,
  };
}

async function viewSettings(chatId) {
  const u = stmt.findUser.get(chatId);
  const sizePct = ((u?.size_multiplier ?? 0.1) * 100).toFixed(0);
  const maxUsdc = (u?.max_trade_size_usdc ?? 50).toFixed(0);
  const mode = u?.mode || 'COPY';
  const running = !!u?.bot_enabled;
  return {
    text:
      `⚙️ *Settings*\n\n` +
      `🔁 Mode: *${mode}*\n` +
      `📏 Size: *${escapeMd(sizePct)}%* of leader\n` +
      `💵 Max per trade: ${fmt$(maxUsdc)}\n` +
      `Status: ${running ? '🟢 RUNNING' : '🔴 PAUSED'}\n\n` +
      `Tap any value below to change it\\.`,
    kb: [
      [
        { text: running ? '⏸ Pause' : '▶ Resume', callback_data: running ? 'act:pause' : 'act:resume' },
        { text: `🔁 Mode: ${mode}`, callback_data: 'act:cyclemode' },
      ],
      [
        { text: `📏 Size ${sizePct}%`, callback_data: 'ask:setsize' },
        { text: `💵 Cap $${maxUsdc}`, callback_data: 'ask:setcap' },
      ],
      [{ text: '🔌 Reconnect Wallet', callback_data: 'view:reconnect' }],
      [BACK],
    ],
  };
}

async function viewSmartWallets(chatId, page = 0) {
  const lb = await md.getLeaderboard({ limit: 30 });
  const slice = lb.slice(page * 5, page * 5 + 5);
  if (slice.length === 0) {
    return {
      text:
        `🧠 *Smart Wallets*\n\n` +
        `_Live leaderboard is loading\\. Try again shortly\\._\n\n` +
        `In the meantime, paste any trader's address with \`/addleader 0x…\`\\.`,
      kb: [[BACK]],
    };
  }
  const lines = slice.map((t, i) => {
    const idx = page * 5 + i + 1;
    const name = t.name ? escapeMd(t.name) : `\`${escapeMd(shortAddr(t.address))}\``;
    return (
      `*${idx}\\.* ${name}\n` +
      `├ Profit: ${fmt$(t.profit)}\n` +
      `└ \`${escapeMd(t.address)}\``
    );
  });
  const kb = [
    ...slice.map((t, i) => ([{
      text: `➕ Add #${page * 5 + i + 1} ${t.name || shortAddr(t.address)}`,
      callback_data: `act:addsmart:${page * 5 + i}`,
    }])),
    [
      ...(page > 0 ? [{ text: '◀ Prev', callback_data: `smart:${page - 1}` }] : []),
      ...((page + 1) * 5 < lb.length ? [{ text: 'Next ▶', callback_data: `smart:${page + 1}` }] : []),
    ].filter(Boolean),
    [BACK],
  ].filter(r => r.length);
  return {
    text: `🧠 *Smart Wallets* — top traders\n\n` + lines.join('\n\n'),
    kb,
    cache: lb,
  };
}

// store leaderboard cache in memory keyed by chat for "Add #N" callbacks
const leaderboardCache = new Map();

async function viewTpSl(chatId) {
  const targets = stmt.listTpSl.all(chatId);
  const user = stmt.findUser.get(chatId);
  const addr = user?.proxy_address;
  let positions = [];
  if (addr) { try { positions = await md.getPositions(addr); } catch (_) {} }
  let body = '';
  if (targets.length === 0) {
    body = `_No active TP/SL targets\\._\n\n` +
      `Set a target so the bot auto\\-closes positions when YES/NO price hits your TP \\(take profit\\) or SL \\(stop loss\\)\\.`;
  } else {
    body = '*Active targets:*\n' + targets.slice(0, 6).map((t, i) =>
      `*${i + 1}\\.* ${escapeMd(shortQ(t.market_name || t.market_id, 50))} ${t.outcome}\n` +
      `   TP: ${t.tp_price != null ? fmtCent(t.tp_price) : '—'}  ·  SL: ${t.sl_price != null ? fmtCent(t.sl_price) : '—'}`
    ).join('\n\n');
  }
  const posBtns = positions.slice(0, 5).map((p, i) =>
    [{ text: `🎯 Set on #${i + 1} ${shortQ(p.market, 25)}`, callback_data: `tpsl:set:${i}` }]
  );
  const cancelBtns = targets.slice(0, 5).map((t, i) =>
    [{ text: `❌ Cancel #${i + 1}`, callback_data: `tpsl:cancel:${t.id}` }]
  );
  return {
    text:
      `🛡 *TP / SL*\n\n` +
      `Auto\\-close positions when price hits a target\\.\n\n` +
      body,
    kb: [...posBtns, ...cancelBtns, [BACK]],
    cachedPositions: positions,
  };
}

const positionsCache = new Map();

async function viewAutopilot(chatId) {
  const cfg = stmt.getAutopilot.get(chatId) || { enabled: 0, top_n: 5 };
  const enabled = !!cfg.enabled;
  return {
    text:
      `🦞 *AutoPilot*\n\n` +
      `Status: ${enabled ? '🟢 ON' : '🔴 OFF'}\n` +
      `Auto\\-add: top *${cfg.top_n}* Smart Wallets\n\n` +
      `When ON, polyDcopier checks the live leaderboard hourly and adds the top traders as leaders for you\\. Tune sizing in *🪙 Copy Trade*\\.`,
    kb: [
      [{ text: enabled ? '⏸ Turn OFF' : '▶ Turn ON', callback_data: 'auto:toggle' }],
      [
        { text: 'Top 3', callback_data: 'auto:n:3' },
        { text: 'Top 5', callback_data: 'auto:n:5' },
        { text: 'Top 10', callback_data: 'auto:n:10' },
      ],
      [{ text: '🔄 Sync now', callback_data: 'auto:sync' }],
      [BACK],
    ],
  };
}

async function viewLimitOrders(chatId) {
  const orders = stmt.listLimitOrders.all(chatId);
  let body;
  if (orders.length === 0) {
    body = `_No pending limit orders\\._\n\n` +
      `Place a limit BUY/SELL on any market — the bot watches the order book and fires when price crosses your level\\.`;
  } else {
    body = '*Pending orders:*\n' + orders.slice(0, 6).map((o, i) =>
      `*${i + 1}\\.* ${escapeMd(shortQ(o.market_name || '', 45))}\n` +
      `   ${o.side} ${o.outcome} ${fmtCent(o.price)} × ${escapeMd(String(o.size))}`
    ).join('\n\n');
  }
  const cancelBtns = orders.slice(0, 5).map((o, i) =>
    [{ text: `❌ Cancel #${i + 1}`, callback_data: `lim:cancel:${o.id}` }]
  );
  return {
    text: `📝 *Limit Orders*\n\n` + body,
    kb: [
      [{ text: '➕ New Limit Order', callback_data: 'ask:newlimit' }],
      ...cancelBtns,
      [BACK],
    ],
  };
}

async function viewReferrals(chatId) {
  let r = stmt.getReferral.get(chatId);
  if (!r) {
    stmt.upsertReferral.run(chatId, genRefCode(chatId), null);
    r = stmt.getReferral.get(chatId);
  }
  const link = `https://t.me/polyDcopier_bot?start=ref_${r.ref_code}`;
  return {
    text:
      `👥 *Referrals*\n\n` +
      `Your code: \`${escapeMd(r.ref_code)}\`\n` +
      `Referred users: *${r.total_referred}*\n` +
      `Earnings: ${fmt$(r.total_earnings_usdc)}\n\n` +
      `Share this link — when someone joins through it, you'll earn a cut of their trading fees\\.\n\n` +
      `\`${escapeMd(link)}\``,
    kb: [
      [{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('polyDcopier — Polymarket copy trading bot')}` }],
      [BACK],
    ],
  };
}

async function viewStats(chatId) {
  const s = stmt.statsForChat.get(chatId) || {};
  const recent = stmt.listRecentTrades.all(chatId, 5);
  const lines = recent.length ? recent.map(t => {
    const time = new Date((t.detected_at || 0) * 1000).toISOString().slice(11, 16) + 'Z';
    const ic = t.status === 'submitted' ? '✅' : t.status === 'paper' ? '📝'
      : t.status === 'failed' ? '❌' : t.status === 'skipped' ? '⏭' : '•';
    return `${ic} \`${escapeMd(time)}\` ${escapeMd(shortQ(t.market_name || '', 30))} ${t.side || ''} ${fmt$(t.notional_usdc)}`;
  }).join('\n') : '_No trades yet_';
  return {
    text:
      `📈 *Stats*\n\n` +
      `Trades: ${s.n_total || 0}\n` +
      `✅ ${s.n_submitted || 0}  ·  ❌ ${s.n_failed || 0}  ·  ⏭ ${s.n_skipped || 0}  ·  📝 ${s.n_paper || 0}\n` +
      `⚡ Avg latency: ${s.avg_latency ? Math.round(s.avg_latency) + 'ms' : '\\—'}\n` +
      `💵 Realized PnL: ${fmt$(s.total_pnl)}\n\n` +
      `*Last 5 trades*\n${lines}`,
    kb: [[BACK]],
  };
}

const HELP_TEXT =
  `*polyDcopier — commands*\n\n` +
  `*Setup*\n` +
  `\`/connect\` link wallet via WalletConnect\n` +
  `\`/setkey <hex>\` paste a trading\\-wallet key\n\n` +
  `*Leaders*\n` +
  `\`/addleader 0x… [label]\`\n` +
  `\`/listleaders\` · \`/removeleader 0x…\`\n\n` +
  `*Copy settings*\n` +
  `\`/mode COPY\\|ZIG\\|PAUSE\`\n` +
  `\`/setsize <pct> <max_usdc>\`\n` +
  `\`/setfilter 0x… key=value …\`\n` +
  `\`/filters\` · \`/pause\` · \`/resume\`\n\n` +
  `*Activity*\n` +
  `\`/stats\` · \`/portfolio\` · \`/menu\``;

// ───────────────────────────── send helper ────────────────────────────
function send(bot, chatId, text, inlineKb) {
  const opts = {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    ...MENU,
  };
  if (inlineKb) {
    opts.reply_markup = { ...MENU.reply_markup };
    // Telegram allows only ONE reply_markup. For inline we pop it on top by
    // sending a fresh message with inline only. The persistent keyboard
    // stays anchored from the previous send anyway.
    return bot.sendMessage(chatId, text, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKb },
    });
  }
  return bot.sendMessage(chatId, text, opts);
}

function sendDashboardKb(bot, chatId, text) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2', disable_web_page_preview: true, ...MENU,
  });
}

// ─────────────────────────────── setup ────────────────────────────────
function setup(bot, orchestrator) {

  async function showView(chatId, viewFn) {
    const v = await viewFn();
    const text = v.text;
    const kb = v.kb || [[BACK]];
    return send(bot, chatId, text, kb);
  }

  // /start with optional ref_<code> argument
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);

    // Capture referral if present
    const arg = (match[1] || '').trim();
    if (arg.startsWith('ref_')) {
      const code = arg.slice(4);
      const refOwner = stmt.findReferralByCode.get(code);
      if (refOwner && refOwner.chat_id !== chatId) {
        stmt.upsertReferral.run(chatId, genRefCode(chatId), refOwner.chat_id);
        stmt.bumpReferralCount.run(refOwner.chat_id);
      }
    } else {
      stmt.upsertReferral.run(chatId, genRefCode(chatId), null);
    }

    try {
      const text = await buildDashboard(chatId);
      sendDashboardKb(bot, chatId, text);
    } catch (e) {
      sendDashboardKb(bot, chatId, `*Welcome to polyDcopier* 🎯\n\nTap a button to begin\\.`);
    }
  });

  bot.onText(/\/menu/, async (msg) => sendDashboardKb(bot, msg.chat.id, await buildDashboard(msg.chat.id)));
  bot.onText(/\/help/, (msg) => sendDashboardKb(bot, msg.chat.id, HELP_TEXT));

  // ─────────── reply-keyboard button handlers + pending input flow ─────
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Check if we're awaiting input
    const pending = stmt.getPendingInput.get(chatId);
    if (pending) {
      stmt.clearPendingInput.run(chatId);
      try {
        await handlePendingInput(bot, chatId, pending, text);
      } catch (e) {
        send(bot, chatId, `❌ Error: ${escapeMd(e.message)}`, [[BACK]]);
      }
      return;
    }

    try {
      switch (text) {
        case '🔍 Markets':       return showView(chatId, () => viewMarkets(chatId, 0));
        case '🪙 Copy Trade':    return showView(chatId, () => viewCopyTrade(chatId));
        case '📊 Portfolio':     return showView(chatId, () => viewPortfolio(chatId));
        case '💰 Wallet':        return showView(chatId, () => viewWallet(chatId));
        case '🛡 TP/SL': {
          const v = await viewTpSl(chatId);
          positionsCache.set(chatId, v.cachedPositions || []);
          return send(bot, chatId, v.text, v.kb);
        }
        case '🦞 AutoPilot':     return showView(chatId, () => viewAutopilot(chatId));
        case '🧠 Smart Wallets': {
          const v = await viewSmartWallets(chatId, 0);
          if (v.cache) leaderboardCache.set(chatId, v.cache);
          return send(bot, chatId, v.text, v.kb);
        }
        case '🔄 Refresh':       return sendDashboardKb(bot, chatId, await buildDashboard(chatId));
        case '📝 Limit Orders':  return showView(chatId, () => viewLimitOrders(chatId));
        case '👥 Referrals':     return showView(chatId, () => viewReferrals(chatId));
        case '⚙️ Settings':      return showView(chatId, () => viewSettings(chatId));
        case '📚 Help':          return sendDashboardKb(bot, chatId, HELP_TEXT);
        case '🇺🇸 English':      return send(bot, chatId, '_polyDcopier currently supports English only\\._', [[BACK]]);
      }
    } catch (e) {
      send(bot, chatId, `❌ Error: ${escapeMd(e.message)}`, [[BACK]]);
    }
  });

  // ──────────── inline keyboard callbacks ──────────────────────────────
  bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = q.data || '';
    try {
      // Navigation
      if (data === 'menu') {
        sendDashboardKb(bot, chatId, await buildDashboard(chatId));
      } else if (data === 'view:portfolio') {
        const v = await viewPortfolio(chatId);
        send(bot, chatId, v.text, v.kb);
      } else if (data === 'view:wallet') {
        const v = await viewWallet(chatId);
        send(bot, chatId, v.text, v.kb);
      } else if (data === 'view:smart') {
        const v = await viewSmartWallets(chatId, 0);
        if (v.cache) leaderboardCache.set(chatId, v.cache);
        send(bot, chatId, v.text, v.kb);
      } else if (data === 'view:tpsl') {
        const v = await viewTpSl(chatId);
        positionsCache.set(chatId, v.cachedPositions || []);
        send(bot, chatId, v.text, v.kb);
      } else if (data === 'view:reconnect') {
        const nonce = crypto.randomBytes(24).toString('base64url');
        stmt.newNonce.run(nonce, chatId, Math.floor(Date.now() / 1000) + 600);
        send(bot, chatId,
          `💰 *Reconnect Wallet*\n\nTap the link below — works with MetaMask, Coinbase, Rabby, Trust, Phantom, Rainbow, OKX, Brave, Frame\\.`,
          [[{ text: '👛 Connect', url: `${PUBLIC_URL}/connect?nonce=${nonce}` }], [BACK]]);
      } else if (data === 'view:removeleader') {
        const rows = stmt.listLeaders.all(chatId);
        const kb = rows.slice(0, 8).map(r => [{
          text: `🗑 ${r.label || shortAddr(r.address)}`,
          callback_data: `act:rmleader:${r.address}`,
        }]);
        kb.push([BACK]);
        send(bot, chatId, `*Tap a leader to remove:*`, kb);
      } else if (data === 'help:setkey') {
        send(bot, chatId,
          `*Use a trading\\-wallet key*\n\n` +
          `Send \`/setkey <0x...64hex>\` with a *dedicated* private key\\.\n\n` +
          `⚠️ Don't paste your main wallet's key\\. Create a fresh wallet, fund it with the USDC you want to trade with, and use that key\\.\n\n` +
          `Your key is encrypted with AES\\-256\\-GCM\\. It only exists in plaintext for milliseconds at signing time\\.`,
          [[BACK]]);
      }

      // Page navigation
      else if (data.startsWith('mkt:')) {
        const p = +data.split(':')[1];
        const v = await viewMarkets(chatId, p);
        send(bot, chatId, v.text, v.kb);
      } else if (data.startsWith('smart:')) {
        const p = +data.split(':')[1];
        const v = await viewSmartWallets(chatId, p);
        if (v.cache) leaderboardCache.set(chatId, v.cache);
        send(bot, chatId, v.text, v.kb);
      }

      // Actions
      else if (data === 'act:pause') {
        stmt.setBotEnabled.run(0, chatId);
        const v = await viewCopyTrade(chatId);
        send(bot, chatId, `⏸ *Bot paused*\n\n` + v.text, v.kb);
      } else if (data === 'act:resume') {
        stmt.setBotEnabled.run(1, chatId);
        const v = await viewCopyTrade(chatId);
        send(bot, chatId, `▶️ *Bot resumed*\n\n` + v.text, v.kb);
      } else if (data === 'act:cyclemode') {
        const u = stmt.findUser.get(chatId);
        const cur = u?.mode || 'COPY';
        const next = cur === 'COPY' ? 'ZIG' : cur === 'ZIG' ? 'PAUSE' : 'COPY';
        stmt.setMode.run(next, chatId);
        const v = await viewCopyTrade(chatId);
        send(bot, chatId, `🔁 Mode → *${next}*\n\n` + v.text, v.kb);
      } else if (data.startsWith('act:rmleader:')) {
        const addr = data.split(':')[2];
        stmt.removeLeader.run(chatId, addr);
        const v = await viewCopyTrade(chatId);
        send(bot, chatId, `🗑 Removed \`${escapeMd(shortAddr(addr))}\`\n\n` + v.text, v.kb);
      } else if (data.startsWith('act:addsmart:')) {
        const idx = +data.split(':')[2];
        const cache = leaderboardCache.get(chatId) || [];
        const t = cache[idx];
        if (!t) {
          send(bot, chatId, `❌ Trader not found in cache — refresh and try again\\.`, [[BACK]]);
        } else {
          stmt.addLeader.run(chatId, t.address.toLowerCase(), t.name || null);
          send(bot, chatId, `✅ Added \`${escapeMd(shortAddr(t.address))}\`${t.name ? ` *${escapeMd(t.name)}*` : ''}\\.\nTap *🪙 Copy Trade* to see your roster\\.`, [
            [{ text: '🪙 Copy Trade', callback_data: 'view:copy' }],
            [BACK],
          ]);
        }
      } else if (data === 'view:copy') {
        const v = await viewCopyTrade(chatId);
        send(bot, chatId, v.text, v.kb);
      }

      // Ask-for-input flows
      else if (data === 'ask:setsize') {
        stmt.setPendingInput.run(chatId, 'setsize', null);
        send(bot, chatId,
          `📏 *Set size %*\n\nReply with a number between 1 and 100 \\(percent of leader's trade to copy\\)\\.\n\n_Example:_ \`10\``,
          [[{ text: 'Cancel', callback_data: 'ask:cancel' }], [BACK]]);
      } else if (data === 'ask:setcap') {
        stmt.setPendingInput.run(chatId, 'setcap', null);
        send(bot, chatId,
          `💵 *Set max USDC per trade*\n\nReply with a number \\(your hard cap per copy trade\\)\\.\n\n_Example:_ \`50\``,
          [[{ text: 'Cancel', callback_data: 'ask:cancel' }], [BACK]]);
      } else if (data === 'ask:addleader') {
        stmt.setPendingInput.run(chatId, 'addleader', null);
        send(bot, chatId,
          `➕ *Add Leader*\n\nReply with the trader's wallet address \\(0x…\\) and an optional label\\.\n\n_Example:_ \`0x123abc... CryptoWizard\``,
          [[{ text: 'Cancel', callback_data: 'ask:cancel' }], [BACK]]);
      } else if (data === 'ask:newlimit') {
        stmt.setPendingInput.run(chatId, 'newlimit', null);
        send(bot, chatId,
          `📝 *New Limit Order*\n\nReply with: \`<market_id> <BUY\\|SELL> <YES\\|NO> <price> <size>\`\n\n_Example:_ \`0xabc... BUY YES 0.25 100\`\n\nFind market\\_id in *🔍 Markets* \\(tap a market on Polymarket\\)\\.`,
          [[{ text: 'Cancel', callback_data: 'ask:cancel' }], [BACK]]);
      } else if (data === 'ask:cancel') {
        stmt.clearPendingInput.run(chatId);
        sendDashboardKb(bot, chatId, await buildDashboard(chatId));
      }

      // TP/SL actions
      else if (data.startsWith('tpsl:set:')) {
        const idx = +data.split(':')[2];
        const positions = positionsCache.get(chatId) || [];
        const p = positions[idx];
        if (!p) {
          send(bot, chatId, `❌ Position not found — refresh and retry\\.`, [[BACK]]);
        } else {
          stmt.setPendingInput.run(chatId, 'tpsl:set', JSON.stringify({
            market_id: p.slug || p.market, market_name: p.market, outcome: p.outcome,
            currentPrice: p.currentPrice,
          }));
          send(bot, chatId,
            `🎯 *Set TP/SL on:*\n${escapeMd(shortQ(p.market, 70))}\n\n` +
            `Reply with: \`<tp_price> <sl_price>\` \\(in cents, use \\- for none\\)\n\n` +
            `_Example:_ \`80 20\` \\(close at 80¢ or 20¢\\)\n` +
            `_Example:_ \`80 \\-\` \\(only TP, no SL\\)`,
            [[{ text: 'Cancel', callback_data: 'ask:cancel' }], [BACK]]);
        }
      } else if (data.startsWith('tpsl:cancel:')) {
        const id = +data.split(':')[2];
        stmt.setTpSlActive.run(0, id, chatId);
        const v = await viewTpSl(chatId);
        positionsCache.set(chatId, v.cachedPositions || []);
        send(bot, chatId, `❌ Target cancelled\\.\n\n` + v.text, v.kb);
      }

      // AutoPilot actions
      else if (data === 'auto:toggle') {
        const cfg = stmt.getAutopilot.get(chatId) || { enabled: 0, top_n: 5 };
        stmt.upsertAutopilot.run(chatId, cfg.enabled ? 0 : 1, cfg.top_n);
        const v = await viewAutopilot(chatId);
        send(bot, chatId, v.text, v.kb);
      } else if (data.startsWith('auto:n:')) {
        const n = +data.split(':')[2];
        const cfg = stmt.getAutopilot.get(chatId) || { enabled: 0 };
        stmt.upsertAutopilot.run(chatId, cfg.enabled ? 1 : 0, n);
        const v = await viewAutopilot(chatId);
        send(bot, chatId, v.text, v.kb);
      } else if (data === 'auto:sync') {
        const cfg = stmt.getAutopilot.get(chatId) || { top_n: 5 };
        const lb = await md.getLeaderboard({ limit: cfg.top_n });
        let added = 0;
        for (const t of lb) {
          if (t.address && /^0x[a-fA-F0-9]{40}$/.test(t.address)) {
            stmt.addLeader.run(chatId, t.address.toLowerCase(), t.name || null);
            added++;
          }
        }
        stmt.setAutopilotSynced.run(chatId);
        send(bot, chatId, `✅ Synced — added/refreshed *${added}* top traders\\.`, [
          [{ text: '🪙 Copy Trade', callback_data: 'view:copy' }],
          [BACK],
        ]);
      }

      // Limit Order cancel
      else if (data.startsWith('lim:cancel:')) {
        const id = +data.split(':')[2];
        stmt.cancelLimitOrder.run(id, chatId);
        const v = await viewLimitOrders(chatId);
        send(bot, chatId, `❌ Order cancelled\\.\n\n` + v.text, v.kb);
      }

      bot.answerCallbackQuery(q.id);
    } catch (e) {
      console.error('callback err', e);
      try { bot.answerCallbackQuery(q.id, { text: 'Error — try again' }); } catch (_) {}
    }
  });

  // ───────────────────── pending-input handler ────────────────────────
  async function handlePendingInput(bot, chatId, pending, text) {
    const action = pending.action;
    if (action === 'setsize') {
      const pct = parseFloat(text);
      if (!isFinite(pct) || pct <= 0 || pct > 100) {
        send(bot, chatId, `❌ Enter a number between 1 and 100\\.`, [[BACK]]);
        return;
      }
      const u = stmt.findUser.get(chatId);
      stmt.setSizing.run(pct / 100, u?.max_trade_size_usdc ?? 50, chatId);
      const v = await viewCopyTrade(chatId);
      send(bot, chatId, `✅ Size set to *${pct}%*\n\n` + v.text, v.kb);
    } else if (action === 'setcap') {
      const max = parseFloat(text);
      if (!isFinite(max) || max <= 0) {
        send(bot, chatId, `❌ Enter a positive number\\.`, [[BACK]]);
        return;
      }
      const u = stmt.findUser.get(chatId);
      stmt.setSizing.run(u?.size_multiplier ?? 0.1, max, chatId);
      const v = await viewCopyTrade(chatId);
      send(bot, chatId, `✅ Cap set to ${fmt$(max)}\n\n` + v.text, v.kb);
    } else if (action === 'addleader') {
      const parts = text.split(/\s+/);
      const addr = (parts[0] || '').toLowerCase();
      const label = parts.slice(1).join(' ') || null;
      if (!isValidEthAddress(addr)) {
        send(bot, chatId, `❌ Not a valid 0x address\\.`, [[BACK]]);
        return;
      }
      stmt.addLeader.run(chatId, addr, label);
      const v = await viewCopyTrade(chatId);
      send(bot, chatId, `✅ Added \`${escapeMd(shortAddr(addr))}\`\n\n` + v.text, v.kb);
    } else if (action === 'tpsl:set') {
      const ctx = JSON.parse(pending.context || '{}');
      const parts = text.split(/\s+/);
      const tp = parts[0] === '-' ? null : parseFloat(parts[0]) / 100;
      const sl = parts[1] === '-' ? null : parseFloat(parts[1]) / 100;
      if ((tp != null && (!isFinite(tp) || tp < 0 || tp > 1))
          || (sl != null && (!isFinite(sl) || sl < 0 || sl > 1))) {
        send(bot, chatId, `❌ Prices must be 0–100 cents (use \\- for none)\\.`, [[BACK]]);
        return;
      }
      stmt.addTpSl.run(chatId, ctx.market_id, ctx.market_name, ctx.outcome, tp, sl);
      const v = await viewTpSl(chatId);
      positionsCache.set(chatId, v.cachedPositions || []);
      send(bot, chatId,
        `✅ Target set: TP ${tp != null ? fmtCent(tp) : '—'} · SL ${sl != null ? fmtCent(sl) : '—'}\n\n` + v.text,
        v.kb);
    } else if (action === 'newlimit') {
      // Format: <market_id> <BUY|SELL> <YES|NO> <price_decimal_or_cents> <size>
      const parts = text.split(/\s+/);
      if (parts.length < 5) {
        send(bot, chatId, `❌ Format: \`<market_id> <BUY|SELL> <YES|NO> <price> <size>\``, [[BACK]]);
        return;
      }
      const [marketId, side, outcome, priceRaw, sizeRaw] = parts;
      const price = parseFloat(priceRaw);
      const finalPrice = price > 1 ? price / 100 : price;  // accept "25" or "0.25"
      const size = parseFloat(sizeRaw);
      if (!isFinite(finalPrice) || !isFinite(size)) {
        send(bot, chatId, `❌ Invalid price or size\\.`, [[BACK]]);
        return;
      }
      stmt.addLimitOrder.run(chatId, marketId, marketId, side.toUpperCase(), outcome.toUpperCase(), finalPrice, size);
      const v = await viewLimitOrders(chatId);
      send(bot, chatId, `✅ Limit order queued\\.\n\n` + v.text, v.kb);
    }
  }

  // ───────────────────── existing slash commands (kept) ───────────────
  bot.onText(/\/connect/, (msg) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    const nonce = crypto.randomBytes(24).toString('base64url');
    stmt.newNonce.run(nonce, chatId, Math.floor(Date.now() / 1000) + 600);
    send(bot, chatId,
      `💰 *Connect your wallet*\n\nOne signature unlocks Polymarket trading\\.`,
      [[{ text: '👛 Connect', url: `${PUBLIC_URL}/connect?nonce=${nonce}` }], [BACK]]);
  });

  bot.onText(/\/setkey(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    const arg = (match[1] || '').trim();
    if (!arg) {
      send(bot, chatId, `Usage: \`/setkey <0x…64hex>\`\n\nUse a *dedicated* trading wallet\\.`, [[BACK]]);
      return;
    }
    const { isValidPrivateKey, encrypt } = require('./utils');
    const { ethers } = require('ethers');
    if (!isValidPrivateKey(arg)) { send(bot, chatId, `❌ Invalid 64\\-hex private key\\.`, [[BACK]]); return; }
    try {
      const wallet = new ethers.Wallet(arg.startsWith('0x') ? arg : '0x' + arg);
      const enc = encrypt(arg);
      const { getClobAuthRequest, deriveApiKey } = require('./polymarket');
      const ts = String(Math.floor(Date.now() / 1000));
      const req = getClobAuthRequest(wallet.address, ts);
      const sig = await wallet.signTypedData(req.domain, req.types, req.message);
      const creds = await deriveApiKey({ address: wallet.address, signature: sig, timestamp: ts });
      stmt.setUserCreds.run(wallet.address, enc, creds.apiKey, creds.secret || creds.apiSecret, creds.passphrase, chatId);
      send(bot, chatId,
        `✅ Wallet linked: \`${escapeMd(shortAddr(wallet.address))}\`\n\nTap *🪙 Copy Trade* to add leaders\\.\n_Tip: delete the message above containing your key_`,
        [[{ text: '🪙 Copy Trade', callback_data: 'view:copy' }], [BACK]]);
    } catch (e) {
      send(bot, chatId, `❌ Failed: ${escapeMd(e.message)}`, [[BACK]]);
    }
  });

  bot.onText(/\/addleader(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    const label = (match[2] || '').trim() || null;
    if (!isValidEthAddress(addr)) { send(bot, msg.chat.id, 'Usage: `/addleader <0x...> [label]`', [[BACK]]); return; }
    stmt.addLeader.run(msg.chat.id, addr, label);
    send(bot, msg.chat.id, `✅ Tracking \`${escapeMd(shortAddr(addr))}\`${label ? ` \\(${escapeMd(label)}\\)` : ''}`, [[BACK]]);
  });
  bot.onText(/\/listleaders/, (msg) => {
    const rows = stmt.listLeaders.all(msg.chat.id);
    if (rows.length === 0) { send(bot, msg.chat.id, '_No leaders\\._', [[BACK]]); return; }
    const lines = rows.map(r => `• \`${escapeMd(shortAddr(r.address))}\`${r.label ? ` *${escapeMd(r.label)}*` : ''}`);
    send(bot, msg.chat.id, `*Leaders \\(${rows.length}\\)*\n\n${lines.join('\n')}`, [[BACK]]);
  });
  bot.onText(/\/removeleader(?:\s+(\S+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    if (!isValidEthAddress(addr)) { send(bot, msg.chat.id, 'Usage: `/removeleader <0x...>`', [[BACK]]); return; }
    stmt.removeLeader.run(msg.chat.id, addr);
    send(bot, msg.chat.id, `🗑 Removed`, [[BACK]]);
  });
  bot.onText(/\/mode(?:\s+(\S+))?/, (msg, match) => {
    const m = (match[1] || '').toUpperCase();
    if (!['COPY', 'ZIG', 'PAUSE'].includes(m)) { send(bot, msg.chat.id, 'Usage: `/mode COPY|ZIG|PAUSE`', [[BACK]]); return; }
    stmt.setMode.run(m, msg.chat.id);
    send(bot, msg.chat.id, `Mode → *${m}*`, [[BACK]]);
  });
  bot.onText(/\/pause/, (msg) => { stmt.setBotEnabled.run(0, msg.chat.id); send(bot, msg.chat.id, '⏸ Paused', [[BACK]]); });
  bot.onText(/\/resume/, (msg) => { stmt.setBotEnabled.run(1, msg.chat.id); send(bot, msg.chat.id, '▶️ Resumed', [[BACK]]); });
  bot.onText(/\/setsize(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?/, (msg, match) => {
    const pct = parseFloat(match[1]); const max = parseFloat(match[2]);
    if (!isFinite(pct) || !isFinite(max)) { send(bot, msg.chat.id, 'Usage: `/setsize <pct> <max_usdc>`', [[BACK]]); return; }
    stmt.setSizing.run(pct / 100, max, msg.chat.id);
    send(bot, msg.chat.id, `Size *${pct}%*, cap ${fmt$(max)}`, [[BACK]]);
  });
  bot.onText(/\/stats/, async (msg) => { const v = await viewStats(msg.chat.id); send(bot, msg.chat.id, v.text, v.kb); });
  bot.onText(/\/portfolio/, async (msg) => { const v = await viewPortfolio(msg.chat.id); send(bot, msg.chat.id, v.text, v.kb); });
  bot.onText(/\/filters/, (msg) => {
    const rows = stmt.listLeaders.all(msg.chat.id);
    if (rows.length === 0) { send(bot, msg.chat.id, '_No leaders\\._', [[BACK]]); return; }
    const lines = rows.map(r => {
      const f = [];
      if (r.filter_min_price != null || r.filter_max_price != null) f.push(`price ${r.filter_min_price ?? '0'}–${r.filter_max_price ?? '1'}`);
      if (r.filter_only_side) f.push(r.filter_only_side + ' only');
      if (r.filter_cooldown_minutes) f.push(`cooldown ${r.filter_cooldown_minutes}m`);
      return `\`${escapeMd(shortAddr(r.address))}\`${f.length ? ' · ' + escapeMd(f.join(', ')) : ' · no filters'}`;
    });
    send(bot, msg.chat.id, `*Filters*\n\n${lines.join('\n')}`, [[BACK]]);
  });
  bot.onText(/\/setfilter(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    const rest = (match[2] || '').trim();
    if (!isValidEthAddress(addr) || !rest) {
      send(bot, msg.chat.id, 'Usage: `/setfilter <addr> key=value …`', [[BACK]]); return;
    }
    const rows = stmt.listLeaders.all(msg.chat.id).filter(r => r.address.toLowerCase() === addr);
    if (rows.length === 0) { send(bot, msg.chat.id, 'Not tracking that address\\.', [[BACK]]); return; }
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
    stmt.setLeaderFilters.run(next.min_price, next.max_price, next.min_hours, next.max_hours,
      next.side, next.outcome, next.min_leader_usdc, next.cooldown_min, r.id);
    send(bot, msg.chat.id, `Filters updated`, [[BACK]]);
  });

  // ─── trade notifications ──────────────────────────────────────────
  orchestrator.on('trade', (p) => {
    const market = shortQ(p.market || '', 60);
    if (p.status === 'submitted') {
      const ic = p.mode === 'ZIG' ? '↔️' : '⚡';
      bot.sendMessage(p.chat_id,
        `${ic} *${p.mode} fired*\n${escapeMd(market)}\n${p.side} ${escapeMd(String(p.outcome || ''))} @ ${fmtCent(p.price)}  ·  ${fmt$(p.size * p.price)}  ·  *${p.latency_ms}ms*`,
        { parse_mode: 'MarkdownV2', ...MENU });
    } else if (p.status === 'paper') {
      bot.sendMessage(p.chat_id, `📝 *Paper* · ${escapeMd(market)} ${p.side} @ ${fmtCent(p.price)}`, { parse_mode: 'MarkdownV2', ...MENU });
    } else if (p.status === 'failed') {
      bot.sendMessage(p.chat_id, `❌ Trade failed: ${escapeMd((p.error_msg || '').slice(0, 200))}`, { parse_mode: 'MarkdownV2', ...MENU });
    }
  });

  // ─── AutoPilot hourly sync ────────────────────────────────────────
  setInterval(async () => {
    try {
      const stmt2 = require('./db').stmt;
      const all = stmt2.listAllActiveLeaders.all();
      const chatIds = [...new Set(all.map(r => r.chat_id))];
      for (const chatId of chatIds) {
        const cfg = stmt2.getAutopilot.get(chatId);
        if (!cfg || !cfg.enabled) continue;
        const lb = await md.getLeaderboard({ limit: cfg.top_n });
        for (const t of lb) {
          if (t.address && /^0x[a-fA-F0-9]{40}$/.test(t.address)) {
            stmt2.addLeader.run(chatId, t.address.toLowerCase(), t.name || null);
          }
        }
        stmt2.setAutopilotSynced.run(chatId);
      }
    } catch (e) { console.error('[autopilot]', e.message); }
  }, 3600 * 1000);
}

module.exports = { setup }
