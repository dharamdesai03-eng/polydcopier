// Per-leader Manage view + callback handlers.
// Bolted on to bot.js v3 to deliver v4 features without rewriting that file.
// All copy text original.
const { stmt } = require('./db');
const { shortAddr } = require('./utils');

function escapeMd(s) {
  return String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
function fmt$(n) {
  if (n == null || isNaN(n)) return '\\—';
  const v = Number(n);
  const sign = v < 0 ? '\\-' : '';
  return `${sign}\\$${escapeMd(Math.abs(v).toFixed(2))}`;
}
function fmtCent(p) {
  if (p == null || isNaN(p)) return '\\—';
  return escapeMd((Number(p) * 100).toFixed(1)) + '¢';
}
function shortQ(q, n = 60) {
  q = String(q || '');
  return q.length > n ? q.slice(0, n - 1) + '…' : q;
}

const BACK = { text: '↩ Back to menu', callback_data: 'menu' };
const BACK_LIST = { text: '↩ Back to leader list', callback_data: 'lm:list' };

// ───────────────────── views ─────────────────────────────────────────
function viewManageList(chatId) {
  const leaders = stmt.listLeaders.all(chatId);
  if (!leaders.length) {
    return {
      text: `🔧 *Manage Leaders*\n\n_No leaders yet\\._\n\nAdd one with \`/addleader 0x…\` or browse 🧠 Smart Wallets\\.`,
      kb: [[BACK]],
    };
  }
  const lines = [];
  const btns = [];
  for (let i = 0; i < Math.min(leaders.length, 12); i++) {
    const l = leaders[i];
    const p = stmt.leaderPnl.get(chatId, l.address) || {};
    const pnl = Number(p.pnl || 0);
    const trades = Number(p.n || 0);
    const lbl = l.label ? escapeMd(l.label) : `\`${escapeMd(shortAddr(l.address))}\``;
    const status = l.paused ? '⏸' : l.muted ? '🔕' : '🟢';
    lines.push(`${status} *${i + 1}\\.* ${lbl}  ·  ${trades} trades  ·  PnL ${fmt$(pnl)}`);
    btns.push([{
      text: `⚙ Manage ${l.label || shortAddr(l.address)}  ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}$`,
      callback_data: `lm:open:${l.id}`,
    }]);
  }
  return {
    text: `🔧 *Manage Leaders*\n\n` + lines.join('\n') + `\n\n_Tap a leader to configure them individually_`,
    kb: [...btns, [BACK]],
  };
}

function viewLeaderDetail(chatId, leaderId) {
  const l = stmt.getLeaderById.get(leaderId, chatId);
  if (!l) return { text: '❌ Leader not found\\.', kb: [[BACK_LIST]] };
  const p = stmt.leaderPnl.get(chatId, l.address) || {};
  const id = l.id;

  const pnl = Number(p.pnl || 0);
  const trades = Number(p.n || 0);
  const vol = Number(p.vol || 0);
  const sizing = l.sizing_mode === 'FIXED_USDC'
    ? `Fixed ${fmt$(l.fixed_size_usdc)}`
    : l.sizing_mode === 'MATCH'
      ? 'Match leader 1:1'
      : `${((l.copy_size_pct ?? 0.1) * 100).toFixed(0)}% of leader`;
  const cap = l.max_trade_size_usdc != null ? fmt$(l.max_trade_size_usdc) : '\\—';
  const slip = l.slippage_pct != null ? `${l.slippage_pct}%` : 'default';
  const dailyN = l.daily_limit_trades != null ? `${l.daily_limit_trades} trades/day` : '∞';
  const dailyU = l.daily_limit_usdc != null ? fmt$(l.daily_limit_usdc) + '/day' : '∞';
  const pr = (l.filter_min_price != null || l.filter_max_price != null)
    ? `${l.filter_min_price ?? '0'}–${l.filter_max_price ?? '1'}`
    : 'any';
  const tp = l.auto_tp_pct != null ? `+${l.auto_tp_pct}%` : 'off';
  const sl = l.auto_sl_pct != null ? `\\-${l.auto_sl_pct}%` : 'off';
  const mode = l.mode_override || 'inherit';
  const status = l.paused ? '⏸ Paused' : l.muted ? '🔕 Muted \\(silent\\)' : '🟢 Active';
  const lbl = l.label ? escapeMd(l.label) : '\\(no label\\)';

  const text =
    `⚙ *Manage Leader*\n` +
    `${lbl}\n\`${escapeMd(l.address)}\`\n\n` +
    `Status: *${status}*\n` +
    `Mode: *${escapeMd(mode)}*\n` +
    `Sizing: *${escapeMd(sizing)}*\n` +
    `Single\\-trade cap: ${cap}\n` +
    `Slippage: ${escapeMd(slip)}\n` +
    `Price range: ${escapeMd(pr)}\n` +
    `Daily limit: ${escapeMd(String(dailyN))}  ·  ${dailyU}\n` +
    `Auto TP/SL: ${tp} / ${sl}\n\n` +
    `📈 PnL: ${fmt$(pnl)}  ·  ${trades} trades  ·  vol ${fmt$(vol)}`;

  const kb = [
    [
      { text: l.paused ? '▶ Resume' : '⏸ Pause', callback_data: `lm:pause:${id}` },
      { text: l.muted ? '🔔 Unmute' : '🔕 Mute', callback_data: `lm:mute:${id}` },
    ],
    [{ text: `🔁 Mode: ${mode}`, callback_data: `lm:mode:${id}` }],
    [
      { text: '📏 % of leader', callback_data: `lm:smode:${id}:PCT` },
      { text: '💵 Fixed $',     callback_data: `lm:smode:${id}:FIXED_USDC` },
      { text: '🎯 Match 1:1',   callback_data: `lm:smode:${id}:MATCH` },
    ],
    [
      { text: '5%', callback_data: `lm:size:${id}:5` },
      { text: '10%', callback_data: `lm:size:${id}:10` },
      { text: '25%', callback_data: `lm:size:${id}:25` },
      { text: '50%', callback_data: `lm:size:${id}:50` },
    ],
    [
      { text: '$25', callback_data: `lm:cap:${id}:25` },
      { text: '$50', callback_data: `lm:cap:${id}:50` },
      { text: '$100', callback_data: `lm:cap:${id}:100` },
      { text: '$250', callback_data: `lm:cap:${id}:250` },
    ],
    [
      { text: '🌊 Slippage 1%', callback_data: `lm:slip:${id}:1` },
      { text: '3%', callback_data: `lm:slip:${id}:3` },
      { text: '5%', callback_data: `lm:slip:${id}:5` },
    ],
    [
      { text: '📅 Daily 5 tx', callback_data: `lm:dailyn:${id}:5` },
      { text: '10', callback_data: `lm:dailyn:${id}:10` },
      { text: '20', callback_data: `lm:dailyn:${id}:20` },
      { text: '∞', callback_data: `lm:dailyn:${id}:0` },
    ],
    [
      { text: '💰 Daily $50', callback_data: `lm:dailyu:${id}:50` },
      { text: '$200', callback_data: `lm:dailyu:${id}:200` },
      { text: '$500', callback_data: `lm:dailyu:${id}:500` },
      { text: '∞', callback_data: `lm:dailyu:${id}:0` },
    ],
    [
      { text: '🛡 TP +25%', callback_data: `lm:tp:${id}:25` },
      { text: '+50%', callback_data: `lm:tp:${id}:50` },
      { text: '+100%', callback_data: `lm:tp:${id}:100` },
      { text: 'off', callback_data: `lm:tp:${id}:0` },
    ],
    [
      { text: '🛡 SL \\-10%', callback_data: `lm:sl:${id}:10` },
      { text: '\\-25%', callback_data: `lm:sl:${id}:25` },
      { text: '\\-50%', callback_data: `lm:sl:${id}:50` },
      { text: 'off', callback_data: `lm:sl:${id}:0` },
    ],
    [{ text: '🗑 Delete leader', callback_data: `lm:delete:${id}` }],
    [BACK_LIST, { text: '🏠 Main menu', callback_data: 'menu' }],
  ];
  return { text, kb };
}

// ─────────── send helper (mirrors bot.js) ─────────────────────────────
function send(bot, chatId, text, inlineKb) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    reply_markup: inlineKb ? { inline_keyboard: inlineKb } : undefined,
  });
}

// ─────────── callback handler — call this from bot.js ──────────────────
async function handleCallback(bot, chatId, data) {
  if (data === 'lm:list') {
    const v = viewManageList(chatId);
    return send(bot, chatId, v.text, v.kb);
  }
  if (data.startsWith('lm:open:')) {
    const id = +data.split(':')[2];
    const v = viewLeaderDetail(chatId, id);
    return send(bot, chatId, v.text, v.kb);
  }
  if (data.startsWith('lm:pause:')) {
    const id = +data.split(':')[2];
    const l = stmt.getLeaderById.get(id, chatId);
    if (l) stmt.setLeaderField('paused').run(l.paused ? 0 : 1, id, chatId);
  } else if (data.startsWith('lm:mute:')) {
    const id = +data.split(':')[2];
    const l = stmt.getLeaderById.get(id, chatId);
    if (l) stmt.setLeaderField('muted').run(l.muted ? 0 : 1, id, chatId);
  } else if (data.startsWith('lm:mode:')) {
    const id = +data.split(':')[2];
    const l = stmt.getLeaderById.get(id, chatId);
    const cur = l?.mode_override || 'inherit';
    const next = cur === 'inherit' ? 'COPY' : cur === 'COPY' ? 'ZIG' : cur === 'ZIG' ? 'PAUSE' : 'inherit';
    stmt.setLeaderField('mode_override').run(next === 'inherit' ? null : next, id, chatId);
  } else if (data.startsWith('lm:smode:')) {
    const [, , idS, mode] = data.split(':');
    stmt.setLeaderField('sizing_mode').run(mode, +idS, chatId);
  } else if (data.startsWith('lm:size:')) {
    const [, , idS, pctS] = data.split(':');
    stmt.setLeaderField('copy_size_pct').run(Number(pctS) / 100, +idS, chatId);
  } else if (data.startsWith('lm:cap:')) {
    const [, , idS, cs] = data.split(':');
    stmt.setLeaderField('max_trade_size_usdc').run(Number(cs), +idS, chatId);
  } else if (data.startsWith('lm:slip:')) {
    const [, , idS, ss] = data.split(':');
    stmt.setLeaderField('slippage_pct').run(Number(ss), +idS, chatId);
  } else if (data.startsWith('lm:dailyn:')) {
    const [, , idS, ns] = data.split(':');
    const n = Number(ns);
    stmt.setLeaderField('daily_limit_trades').run(n === 0 ? null : n, +idS, chatId);
  } else if (data.startsWith('lm:dailyu:')) {
    const [, , idS, us] = data.split(':');
    const u = Number(us);
    stmt.setLeaderField('daily_limit_usdc').run(u === 0 ? null : u, +idS, chatId);
  } else if (data.startsWith('lm:tp:')) {
    const [, , idS, ps] = data.split(':');
    const p = Number(ps);
    stmt.setLeaderField('auto_tp_pct').run(p === 0 ? null : p, +idS, chatId);
  } else if (data.startsWith('lm:sl:')) {
    const [, , idS, ps] = data.split(':');
    const p = Number(ps);
    stmt.setLeaderField('auto_sl_pct').run(p === 0 ? null : p, +idS, chatId);
  } else if (data.startsWith('lm:delete:')) {
    const id = +data.split(':')[2];
    const l = stmt.getLeaderById.get(id, chatId);
    if (l) stmt.removeLeader.run(chatId, l.address);
    const v = viewManageList(chatId);
    return send(bot, chatId, `🗑 Removed\\.\n\n` + v.text, v.kb);
  } else {
    return null;  // not an lm: callback
  }

  // After any state change, re-render the leader detail view
  const id = +data.split(':')[2];
  const v = viewLeaderDetail(chatId, id);
  return send(bot, chatId, v.text, v.kb);
}

module.exports = { viewManageList, viewLeaderDetail, handleCallback };
