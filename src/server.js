// Tiny Express HTTPS host:
// - serves /connect (the WalletConnect Mini App)
// - GET  /api/wallet/auth-request — returns ClobAuth typed-data + nonce
// - POST /api/wallet/connect      — verifies signature, derives Polymarket API key, persists
// - GET  /api/wallet/wc-project-id — returns WC project id from env
// - /healthz
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { stmt } = require('./db');
const { encrypt, isValidEthAddress } = require('./utils');
const { getClobAuthRequest, deriveApiKey } = require('./polymarket');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mini App route — same content as /public/connect.html, kept here for clarity.
app.get('/connect', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'connect.html'));
});

app.get('/api/wallet/wc-project-id', (req, res) => {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID || '';
  if (!projectId) return res.status(503).json({ error: 'WALLETCONNECT_PROJECT_ID not set' });
  res.json({ projectId });
});

app.get('/api/wallet/auth-request', (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!isValidEthAddress(address)) return res.status(400).json({ error: 'invalid_address' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = '0';
  const typedData = getClobAuthRequest(address, timestamp, nonce);
  // eth_signTypedData_v4 (used by WalletConnect / MetaMask extension via raw RPC)
  // requires EIP712Domain in the types map. ethers.js adds it implicitly so we
  // keep it out of CLOB_AUTH_TYPES, then layer it in here just for the wire response.
  typedData.types = {
    EIP712Domain: [
      { name: 'name',    type: 'string'  },
      { name: 'version', type: 'string'  },
      { name: 'chainId', type: 'uint256' },
    ],
    ...typedData.types,
  };
  res.json({ typedData, timestamp, nonce });
});

app.post('/api/wallet/connect', async (req, res) => {
  const reqNonce = String(req.query.nonce || '');
  const consumed = stmt.consumeNonce.get(reqNonce);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_nonce' });
  const chatId = consumed.chat_id;

  const { address, signature, timestamp, nonce } = req.body || {};
  if (!isValidEthAddress(address) || !signature || !timestamp) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    const creds = await deriveApiKey({ address, signature, timestamp, nonce });
    if (!creds || !creds.apiKey) {
      return res.status(400).json({ error: 'polymarket_did_not_return_api_key' });
    }

    // Note: with WalletConnect we DON'T have the user's private key on our
    // side. To actually submit orders the bot still needs a signing key. Two
    // routes:
    //   (A) ask user to also paste a per-bot trading key (most common, safer
    //       than seed phrase since it's a dedicated dust wallet)
    //   (B) keep the WC session alive and re-sign every order via
    //       wallet_request — way slower and breaks if user closes wallet.
    //
    // For now we go with route A: store the API key + proxy address now; the
    // user provides the trading-wallet key with /setkey or the bot operates
    // in alert-only mode until they do.
    stmt.setUserCreds.run(
      address,
      null,                          // encrypted_trading_key (filled by /setkey)
      creds.apiKey,
      creds.secret || creds.apiSecret,
      creds.passphrase,
      chatId,
    );

    // Notify user via the bot
    const TelegramBot = require('node-telegram-bot-api');
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (TELEGRAM_BOT_TOKEN) {
      try {
        const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
        await bot.sendMessage(chatId,
          `✅ Wallet linked: \`${address.slice(0,6)}…${address.slice(-4)}\`\n\n` +
          `Polymarket API credentials saved.\n\n` +
          `Last step — paste your trading-wallet private key with /setkey so the bot can sign orders. Use a *dedicated* wallet, not your main one.`,
          { parse_mode: 'Markdown' });
      } catch (e) {
        console.warn('[server] post-connect notify failed:', e.message);
      }
    }

    res.json({ ok: true, address, hasApiKey: true });
  } catch (e) {
    console.error('[server] /api/wallet/connect:', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (req, res) => res.redirect('/connect'));

function start(port) {
  return new Promise(resolve => {
    const server = app.listen(port, () => {
      console.log(`[server] listening on :${port}`);
      resolve(server);
    });
  });
}

module.exports = { app, start };
