# polyDcopier — Telegram

Sub-200ms Polymarket copy trading. Mempool-driven detection via Alchemy. Self-custodial. Telegram bot interface.

## What you'll need

Three free accounts and one paid host:

1. **Telegram bot** — talk to [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, give it a name, copy the token it returns. (Free.)
2. **Alchemy** account — sign up at [alchemy.com](https://www.alchemy.com/), create a Polygon Mainnet app, copy the WSS URL. Free tier is plenty (300M compute units/mo).
3. **WalletConnect Cloud** project — sign up at [cloud.walletconnect.com](https://cloud.walletconnect.com), create a project, copy the Project ID. (Free.)
4. **Render** — sign up at [render.com](https://render.com). The Starter plan ($7/mo) is needed because the free tier idles your service after 15 minutes of inactivity, which kills sub-200ms latency on the first trade after a quiet period.

## 4-step deploy

### Step 1 — push this folder to a fresh GitHub repo
- Go to github.com → New repository → name it whatever you want → Create
- On your repo's empty page click "uploading an existing file"
- Drag every file from this folder into the upload area (don't include `node_modules` or `.env` if you've run it locally)
- Commit

### Step 2 — connect Render
- In Render dashboard click New + → Web Service
- Connect your GitHub repo
- Render auto-detects `render.yaml` and proposes the right config — confirm it
- It will prompt you for the env vars marked `sync: false`:
  - `TELEGRAM_BOT_TOKEN` from BotFather
  - `ALCHEMY_WS_URL` like `wss://polygon-mainnet.g.alchemy.com/v2/<key>`
  - `WALLETCONNECT_PROJECT_ID` from WC Cloud
  - `PUBLIC_URL` — leave blank initially, Render fills your public URL after first deploy. Come back and set it to your service URL (e.g. `https://polydcopier.onrender.com`).
- Click Create. First build takes ~3 minutes (npm install, native sqlite compile).

### Step 3 — set `PUBLIC_URL`
- After Render shows your service URL at the top, copy it
- Settings → Environment → set `PUBLIC_URL` to that URL → Save (triggers redeploy)

### Step 4 — open Telegram and message your bot
- Find your bot by the username you gave BotFather
- Send `/start`
- Send `/connect` — it'll give you a link to a Mini App
- Sign with MetaMask Mobile (or any WalletConnect-supporting wallet)
- Back in Telegram, send `/setkey <your-trading-wallet-private-key>` (use a dedicated wallet with just the funds you want to trade — never your main wallet)
- Send `/addleader 0x<address>` for each Polymarket trader you want to copy
- Send `/setsize 10 50` (10% of leader's size, max $50/trade)
- Send `/mode COPY` to start

That's it. The bot is now mempool-watching from Frankfurt, signing orders with your encrypted wallet, and pinging your phone every time it fires.

## Commands cheatsheet

```
/start          welcome
/connect        link wallet via WalletConnect
/setkey <hex>   set the trading-wallet signing key
/addleader <addr> [label]
/listleaders
/removeleader <addr>
/mode COPY|ZIG|PAUSE
/setsize <pct> <max_usdc>
/setfilter <addr> key=value …
/filters
/pause /resume
/stats
/help
```

## What's safe and what isn't

**Safe by design:** your trading wallet's private key is encrypted with AES-256-GCM using a random 32-byte master key that Render generates per service. The key is decrypted JIT in memory at signing time and discarded immediately. The encrypted blob lives only on your Render persistent disk.

**Use a dedicated wallet.** Don't use your main wallet's key. Create a fresh wallet, fund it with only the USDC you want to copy-trade with, and use that wallet's key. If anything goes wrong (you fork up, the bot has a bug, Render gets compromised) the worst-case loss is what's on that one wallet, not your whole portfolio.

**Paper-trade first.** Set `PAPER_TRADE=1` for a few hours and watch trades print in the Telegram log without real submission. Once latency and detection look right, flip it to `0`.

## How fast is it really

Architecture target: **100-200ms** from Polymarket operator submitting a matched-orders tx to Polygon mempool, to our copy order being accepted by the CLOB.

Pipeline:
- Alchemy WS pushes pending tx → us: ~50-100ms
- Calldata decode + filter check + order build + sign: ~10-20ms
- HTTPS POST to clob.polymarket.com: ~30-50ms (Frankfurt → Cloudflare edge)

Realistic distribution: median ~150ms, 95th percentile ~300ms, occasional outliers from mempool noise.

Beats data-api polling (3-5s) by 10-20x. Matches the "<100ms server-side" architecture commercial copiers (Polymirror, MirrorCopy) use.

## Architecture

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Alchemy WS      │      │  Mempool watcher │      │  Orchestrator    │
│  alchemy_pending │ ───▶ │  (decode ABI)    │ ───▶ │  (filter, size,  │
│  filtered to     │      │                  │      │   sign, submit)  │
│  Exchange addr   │      │                  │      │                  │
└──────────────────┘      └──────────────────┘      └────────┬─────────┘
                                                              │
                                                              ▼
                                                    ┌──────────────────┐
                                                    │ clob.polymarket  │
                                                    │ /order (REST)    │
                                                    └──────────────────┘

         Telegram bot ◀──── notifications ──── Orchestrator
              │
              ▼
         user phone
```

## Files

```
src/
  index.js        entrypoint, wires everything together
  bot.js          Telegram command handlers
  server.js       Express HTTPS for Mini App + connect callback
  mempool.js      Alchemy WS subscriber + Polymarket calldata decoder
  orchestrator.js leaderFill → copy order pipeline
  polymarket.js   EIP-712 order builder, signer, submitter, L1 auth
  db.js           SQLite schema + prepared statements
  utils.js        AES-256-GCM, validators
public/
  connect.html    WalletConnect Mini App
render.yaml       one-click Render deploy
.env.example      env var template
```

## Troubleshooting

**Bot replies "WALLETCONNECT_PROJECT_ID not set"** — go to cloud.walletconnect.com, create a project, paste the ID into Render env vars.

**No trades firing** — check `/stats` for "Avg latency" and submitted count. If 0 across the board, check the Render service logs for `[mempool] connected` and a heartbeat showing `mempool=up`. Common cause: your Alchemy WS URL is wrong, or you haven't added any leaders yet.

**Trades show as "failed"** — open the Render log, search for the failed trade — usually a Polymarket auth issue (re-run `/connect` and `/setkey`) or insufficient balance on the trading wallet.

**Telegram says "polling_error"** — most often means another instance is running with the same token. Stop the local one or rotate the token via BotFather.

## License

This is your code. Do whatever you want with it.
