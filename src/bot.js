// Telegram bot command layer.
//
// Commands:
//   /start         show welcome + key actions
//   /connect       open WalletConnect Mini App to link a wallet
//   /addleader     add a Polymarket address to track
//   /listleaders   show currently tracked leaders
//   /removeleader  remove a leader
//   /setsize       set default copy size + max USDC per trade
//   /pause         stop copying
//   /resume        resume copying
//   /mode          switch COPY / ZIG / PAUSE
//   /stats         show overall stats + recent trades
//   /help          show all commands
//
// All replies use Telegram MarkdownV2 escaping rules.

const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { stmt } = require('./db');
const { isValidEthAddress, shortAddr } = require('./utils');

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';

const HELP = `*polyDcopier — commands*

🟢 Setup
  /connect — link MetaMask or any wallet
  /setkey — paste a trading-wallet key (advanced fallback)

📊 Leaders
  /addleader \`<address>\` \`[label]\` — track a wallet
  /listleaders — show your tracked leaders
  /removeleader \`<address>\`

⚙️ Copy settings
  /mode COPY | ZIG | PAUSE
  /setsize \`<percent>\` \`<max_usdc>\`
  /filters — show your active per\\-leader filters
  /pause /resume

📈 Activity
  /stats — overall numbers + recent trades
  /positions — your open positions

💡 /help — this menu`;

function escapeMd(s) {
  return String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtUsdc(n) {
  if (n == null || isNaN(n)) return '\\—';
  return `\\$${Number(n).toFixed(2)}`;
}

function setup(bot, orchestrator) {
  // ---- /start ---------------------------------------------------------
  bot.onText(/\/start(?:\s|$)/, (msg) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    bot.sendMessage(chatId,
      `*Welcome to polyDcopier* 🚀\n\n` +
      `Sub\\-200ms Polymarket copy\\-trading via mempool detection\\. Connect a wallet to begin\\.\n\n` +
      `Type /connect to link your wallet\n` +
      `Or /help for the full command list`,
      { parse_mode: 'MarkdownV2' });
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP, { parse_mode: 'MarkdownV2' });
  });

  // ---- /connect — issue a one-time signed link to the Mini App --------
  bot.onText(/\/connect/, (msg) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    const nonce = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Math.floor(Date.now() / 1000) + 600;  // 10 min
    stmt.newNonce.run(nonce, chatId, expiresAt);
    const url = `${PUBLIC_URL}/connect?nonce=${nonce}`;
    bot.sendMessage(chatId,
      `*Connect your wallet*\n\n` +
      `Tap the link below \\(opens WalletConnect — works with MetaMask, Coinbase Wallet, Rabby, Trust, Phantom, Rainbow, OKX, Brave, Frame\\)\\.\n\n` +
      `One signature unlocks Polymarket trading\\.\n\n` +
      `[👛 Connect wallet](${url})\n\n` +
      `Link expires in 10 minutes\\. Your seed phrase / private key stays on your phone — we only get a signature\\.`,
      { parse_mode: 'MarkdownV2', disable_web_page_preview: false });
  });

  // ---- /setkey — fallback for users who want to paste a private key ---
  bot.onText(/\/setkey(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    stmt.upsertUser.run(chatId, msg.from?.username || null);
    const arg = (match[1] || '').trim();

    if (!arg) {
      bot.sendMessage(chatId,
        `Usage: \`/setkey <0x...64hex>\`\n\n` +
        `⚠️ Use a *dedicated* trading wallet, not your main wallet\\.` +
        `Your key is encrypted with AES\\-256\\-GCM before being stored\\. ` +
        `It only ever exists in plaintext for milliseconds at signing time\\.\n\n` +
        `Recommended: use /connect with WalletConnect instead\\.`,
        { parse_mode: 'MarkdownV2' });
      return;
    }

    const { isValidPrivateKey, encrypt } = require('./utils');
    const { ethers } = require('ethers');
    if (!isValidPrivateKey(arg)) {
      bot.sendMessage(chatId, '❌ That doesn\\\'t look like a valid 64\\-hex private key\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    try {
      const wallet = new ethers.Wallet(arg.startsWith('0x') ? arg : '0x' + arg);
      const addr = wallet.address;
      const enc = encrypt(arg);

      // Derive Polymarket API key directly with this wallet.
      const { getClobAuthRequest, deriveApiKey } = require('./polymarket');
      const ts = String(Math.floor(Date.now() / 1000));
      const req = getClobAuthRequest(addr, ts);
      const sig = await wallet.signTypedData(req.domain, req.types, req.message);
      const creds = await deriveApiKey({ address: addr, signature: sig, timestamp: ts });

      stmt.setUserCreds.run(addr, enc, creds.apiKey, creds.secret || creds.apiSecret, creds.passphrase, chatId);
      bot.sendMessage(chatId,
        `✅ Wallet linked: \`${escapeMd(shortAddr(addr))}\`\n\n` +
        `Polymarket API key derived\\. You can now /addleader and start copying\\.\n\n` +
        `Tip: delete the message above containing your key for safety\\.`,
        { parse_mode: 'MarkdownV2' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Failed: ${escapeMd(e.message || String(e))}`, { parse_mode: 'MarkdownV2' });
    }
  });

  // ---- /addleader -----------------------------------------------------
  bot.onText(/\/addleader(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const addr = (match[1] || '').trim().toLowerCase();
    const label = (match[2] || '').trim() || null;

    if (!isValidEthAddress(addr)) {
      bot.sendMessage(chatId, 'Usage: `/addleader <0x...address> [label]`', { parse_mode: 'MarkdownV2' });
      return;
    }
    stmt.addLeader.run(chatId, addr, label);
    bot.sendMessage(chatId,
      `✅ Tracking \`${escapeMd(shortAddr(addr))}\`${label ? ` \\(${escapeMd(label)}\\)` : ''}\\.\n\n` +
      `Configure per\\-leader filters with /filters or just let it copy at default settings\\.`,
      { parse_mode: 'MarkdownV2' });
  });

  // ---- /listleaders ---------------------------------------------------
  bot.onText(/\/listleaders/, (msg) => {
    const rows = stmt.listLeaders.all(msg.chat.id);
    if (rows.length === 0) {
      bot.sendMessage(msg.chat.id, 'No leaders yet\\. Use `/addleader <address>` to start\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    const lines = rows.map(r => {
      const label = r.label ? ` *${escapeMd(r.label)}*` : '';
      const sizing = r.copy_size_pct != null ? ` ${r.copy_size_pct}% size` : '';
      const cap = r.max_trade_size_usdc != null ? ` cap ${fmtUsdc(r.max_trade_size_usdc)}` : '';
      return `• \`${escapeMd(shortAddr(r.address))}\`${label}${sizing}${cap}`;
    });
    bot.sendMessage(msg.chat.id, `*Tracked leaders \\(${rows.length}\\)*\n\n${lines.join('\n')}`,
      { parse_mode: 'MarkdownV2' });
  });

  // ---- /removeleader --------------------------------------------------
  bot.onText(/\/removeleader(?:\s+(\S+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    if (!isValidEthAddress(addr)) {
      bot.sendMessage(msg.chat.id, 'Usage: `/removeleader <0x...address>`', { parse_mode: 'MarkdownV2' });
      return;
    }
    stmt.removeLeader.run(msg.chat.id, addr);
    bot.sendMessage(msg.chat.id, `🗑 Removed \`${escapeMd(shortAddr(addr))}\``, { parse_mode: 'MarkdownV2' });
  });

  // ---- /mode ----------------------------------------------------------
  bot.onText(/\/mode(?:\s+(\S+))?/, (msg, match) => {
    const m = (match[1] || '').toUpperCase();
    if (!['COPY', 'ZIG', 'PAUSE'].includes(m)) {
      bot.sendMessage(msg.chat.id, 'Usage: `/mode COPY | ZIG | PAUSE`\n\nCOPY mirrors leader\\. ZIG fades \\(opposite outcome, same direction\\)\\. PAUSE stops copying\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    stmt.setMode.run(m, msg.chat.id);
    bot.sendMessage(msg.chat.id, `Mode set to *${m}*`, { parse_mode: 'MarkdownV2' });
  });

  // ---- /pause /resume -------------------------------------------------
  bot.onText(/\/pause/, (msg) => {
    stmt.setBotEnabled.run(0, msg.chat.id);
    bot.sendMessage(msg.chat.id, '⏸ Bot paused\\. /resume to start again\\.', { parse_mode: 'MarkdownV2' });
  });
  bot.onText(/\/resume/, (msg) => {
    stmt.setBotEnabled.run(1, msg.chat.id);
    bot.sendMessage(msg.chat.id, '▶️ Bot resumed\\.', { parse_mode: 'MarkdownV2' });
  });

  // ---- /setsize -------------------------------------------------------
  bot.onText(/\/setsize(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?/, (msg, match) => {
    const pct = parseFloat(match[1]);
    const max = parseFloat(match[2]);
    if (!isFinite(pct) || !isFinite(max)) {
      bot.sendMessage(msg.chat.id, 'Usage: `/setsize <percent> <max_usdc_per_trade>`\n\nExample: `/setsize 10 50` copies 10% of leader size, max $50/trade\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    stmt.setSizing.run(pct / 100, max, msg.chat.id);
    bot.sendMessage(msg.chat.id, `Size: *${pct}%* of leader, max ${fmtUsdc(max)} per trade\\.`, { parse_mode: 'MarkdownV2' });
  });

  // ---- /stats ---------------------------------------------------------
  bot.onText(/\/stats/, (msg) => {
    const s = stmt.statsForChat.get(msg.chat.id) || {};
    const recent = stmt.listRecentTrades.all(msg.chat.id, 5);
    const lines = recent.map(t => {
      const ts = new Date((t.detected_at || 0) * 1000);
      const time = ts.toISOString().slice(11, 16) + 'Z';
      const ic = t.status === 'submitted' ? '✅'
              : t.status === 'paper'     ? '📝'
              : t.status === 'failed'    ? '❌'
              : t.status === 'skipped'   ? '⏭'
              : '•';
      const market = (t.market_name || '').slice(0, 30);
      return `${ic} \`${escapeMd(time)}\` ${escapeMd(market)} ${t.side || ''} ${fmtUsdc(t.notional_usdc)}`;
    }).join('\n') || '_no trades yet_';

    const txt =
      `*polyDcopier stats*\n\n` +
      `Trades total: ${s.n_total || 0}\n` +
      `Submitted: ${s.n_submitted || 0}  ·  Failed: ${s.n_failed || 0}  ·  Skipped: ${s.n_skipped || 0}  ·  Paper: ${s.n_paper || 0}\n` +
      `Avg latency: ${s.avg_latency ? Math.round(s.avg_latency) + 'ms' : '\\—'}\n` +
      `P&L \\(realized\\): ${fmtUsdc(s.total_pnl)}\n\n` +
      `*Last 5 trades*\n${lines}`;
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'MarkdownV2' });
  });

  // ---- /filters — show active filter overrides ------------------------
  bot.onText(/\/filters/, (msg) => {
    const rows = stmt.listLeaders.all(msg.chat.id);
    if (rows.length === 0) {
      bot.sendMessage(msg.chat.id, 'No leaders yet\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    const lines = rows.map(r => {
      const filters = [];
      if (r.filter_min_price != null || r.filter_max_price != null) {
        filters.push(`price ${r.filter_min_price ?? '0'}–${r.filter_max_price ?? '1'}`);
      }
      if (r.filter_only_side) filters.push(r.filter_only_side + ' only');
      if (r.filter_only_outcome) filters.push(r.filter_only_outcome + ' only');
      if (r.filter_min_leader_usdc != null) filters.push(`min $${r.filter_min_leader_usdc}`);
      if (r.filter_cooldown_minutes) filters.push(`cooldown ${r.filter_cooldown_minutes}m`);
      if (r.filter_min_hours_to_close != null || r.filter_max_hours_to_close != null) {
        filters.push(`close in ${r.filter_min_hours_to_close ?? '0'}–${r.filter_max_hours_to_close ?? '∞'}h`);
      }
      const fs = filters.length ? ' · ' + filters.join(', ') : ' · no filters';
      return `\`${escapeMd(shortAddr(r.address))}\`${escapeMd(fs)}`;
    });
    bot.sendMessage(msg.chat.id, `*Per\\-leader filters*\n\n${lines.join('\n')}\n\n` +
      `Set with: \`/setfilter <address> <key>=<value>\` \\(see /help\\)`,
      { parse_mode: 'MarkdownV2' });
  });

  // ---- /setfilter <addr> key=value ... --------------------------------
  bot.onText(/\/setfilter(?:\s+(\S+))?(?:\s+(.+))?/, (msg, match) => {
    const addr = (match[1] || '').trim().toLowerCase();
    const rest = (match[2] || '').trim();
    if (!isValidEthAddress(addr) || !rest) {
      bot.sendMessage(msg.chat.id,
        'Usage: `/setfilter <addr> key=value [key=value...]`\n\n' +
        'Keys: `min_price` `max_price` `min_hours` `max_hours` `side` `outcome` `min_leader_usdc` `cooldown_min`\n\n' +
        'Example: `/setfilter 0xabc... min_price=0.10 max_price=0.90 cooldown_min=30`',
        { parse_mode: 'MarkdownV2' });
      return;
    }
    const rows = stmt.listLeaders.all(msg.chat.id).filter(r => r.address.toLowerCase() === addr);
    if (rows.length === 0) {
      bot.sendMessage(msg.chat.id, 'Not tracking that address\\. Use /addleader first\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
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
    bot.sendMessage(msg.chat.id, `Filters updated for \`${escapeMd(shortAddr(addr))}\`\\.`, { parse_mode: 'MarkdownV2' });
  });

  // ---- Live trade notifications ---------------------------------------
  orchestrator.on('trade', (p) => {
    if (p.status === 'submitted') {
      const market = (p.market || '').slice(0, 50);
      const ic = p.mode === 'ZIG' ? '↔️' : '⚡';
      bot.sendMessage(p.chat_id,
        `${ic} *${p.mode} fired*\n` +
        `${escapeMd(market)}\n` +
        `${p.side} ${escapeMd(String(p.outcome || ''))} @ ${(+p.price).toFixed(3)} · ` +
        `\\$${(+p.size * +p.price).toFixed(2)} · *${p.latency_ms}ms*`,
        { parse_mode: 'MarkdownV2' });
    } else if (p.status === 'paper') {
      bot.sendMessage(p.chat_id,
        `📝 *Paper trade* · ${escapeMd((p.market || '').slice(0, 50))} ${p.side} @ ${(+p.price).toFixed(3)}`,
        { parse_mode: 'MarkdownV2' });
    } else if (p.status === 'failed') {
      bot.sendMessage(p.chat_id, `❌ Trade failed: ${escapeMd((p.error_msg || '').slice(0, 200))}`,
        { parse_mode: 'MarkdownV2' });
    }
    // skipped: don't spam the user about every filter rejection
  });
}

module.exports = { setup };
