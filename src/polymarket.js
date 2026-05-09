// Polymarket CLOB client.
// - EIP-712 order construction + signing (ethers v6)
// - L2 auth header builder (HMAC-SHA256)
// - Order submission via keep-alive HTTPS
// - Wallet-auth for deriving the user's API key from a single signed message
const { ethers } = require('ethers');
const crypto = require('crypto');
const https = require('https');
const fetchLib = require('node-fetch');

const CLOB_REST  = process.env.POLYMARKET_CLOB_REST  || 'https://clob.polymarket.com';
const GAMMA_API  = process.env.POLYMARKET_GAMMA_API  || 'https://gamma-api.polymarket.com';

// Polygon mainnet Polymarket CTF Exchange contract
const EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CHAIN_ID = 137;

// Persistent keep-alive agent — reuses TLS sessions across submits, saves
// 50-100ms per order vs cold connect.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 60000,
});

const fetch = (url, opts = {}) => {
  if (typeof fetchLib === 'function') {
    return fetchLib(url, { agent: keepAliveAgent, ...opts });
  }
  // node-fetch v3 is ESM — handle both shapes.
  return import('node-fetch').then(m => m.default(url, { agent: keepAliveAgent, ...opts }));
};

const fetchJson = async (url, opts = {}) => {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { ok: r.ok, status: r.status, body };
};

// EIP-712 domain & types for Polymarket Order
const ORDER_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: EXCHANGE_ADDRESS,
};
const ORDER_TYPES = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'taker',         type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'expiration',    type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
    { name: 'feeRateBps',    type: 'uint256' },
    { name: 'side',          type: 'uint8'   },  // 0=BUY, 1=SELL
    { name: 'signatureType', type: 'uint8'   },  // 0=EOA
  ],
};

const toScaled = n => BigInt(Math.round(Number(n) * 1e6));
const randomSalt = () => BigInt('0x' + crypto.randomBytes(32).toString('hex'));

function buildOrder({
  makerAddress, signerAddress, tokenId, price, size, side,
  expirationSec = 0, feeRateBps = 0, signatureType = 0,
}) {
  const isBuy = (side === 'BUY' || side === 0);
  const sharesScaled = toScaled(size);
  const usdcScaled   = toScaled(price * size);
  const makerAmount = isBuy ? usdcScaled  : sharesScaled;
  const takerAmount = isBuy ? sharesScaled : usdcScaled;
  return {
    salt:          randomSalt().toString(),
    maker:         ethers.getAddress(makerAddress),
    signer:        ethers.getAddress(signerAddress),
    taker:         '0x0000000000000000000000000000000000000000',
    tokenId:       String(tokenId),
    makerAmount:   makerAmount.toString(),
    takerAmount:   takerAmount.toString(),
    expiration:    String(expirationSec),
    nonce:         '0',
    feeRateBps:    String(feeRateBps),
    side:          isBuy ? 0 : 1,
    signatureType: signatureType,
  };
}

async function signOrder(order, privateKey) {
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
  const sig = await wallet.signTypedData(ORDER_DOMAIN, ORDER_TYPES, order);
  return { ...order, signature: sig };
}

function buildL2Headers({ address, apiKey, apiSecret, apiPassphrase, method, path, body }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = ts + method + path + (body ? JSON.stringify(body) : '');
  const secret = Buffer.from(apiSecret, 'base64');
  const sig = crypto.createHmac('sha256', secret).update(message).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  return {
    'POLY_ADDRESS':    address,
    'POLY_API_KEY':    apiKey,
    'POLY_PASSPHRASE': apiPassphrase,
    'POLY_TIMESTAMP':  ts,
    'POLY_SIGNATURE':  sig,
    'Content-Type':    'application/json',
  };
}

async function submitOrder(signedOrder, l2Auth) {
  const path = '/order';
  const body = { order: signedOrder, owner: l2Auth.apiKey, orderType: 'GTC' };
  const headers = buildL2Headers({
    address: l2Auth.address,
    apiKey: l2Auth.apiKey,
    apiSecret: l2Auth.apiSecret,
    apiPassphrase: l2Auth.apiPassphrase,
    method: 'POST',
    path,
    body,
  });
  const t0 = Date.now();
  const { ok, status, body: resp } = await fetchJson(CLOB_REST + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { ok, status, body: resp, latency: Date.now() - t0 };
}

async function fetchMarket(conditionId) {
  if (!conditionId) return null;
  const url = `${GAMMA_API}/markets?condition_ids=${conditionId}`;
  const { ok, body } = await fetchJson(url);
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0];
}

async function fetchMarketByTokenId(tokenId) {
  if (!tokenId) return null;
  const url = `${GAMMA_API}/markets?clob_token_ids=${tokenId}`;
  const { ok, body } = await fetchJson(url);
  if (!ok) return null;
  const arr = Array.isArray(body) ? body : (body?.data || []);
  return arr[0] || null;
}

// L1 wallet auth — user signs ClobAuth typed message, we exchange for API key.
const CLOB_AUTH_DOMAIN = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address',   type: 'address' },
    { name: 'timestamp', type: 'string'  },
    { name: 'nonce',     type: 'uint256' },
    { name: 'message',   type: 'string'  },
  ],
};
const CLOB_AUTH_MESSAGE = 'This message attests that I control the given wallet';

function getClobAuthRequest(address, timestamp, nonce = '0') {
  return {
    domain:      CLOB_AUTH_DOMAIN,
    types:       CLOB_AUTH_TYPES,
    primaryType: 'ClobAuth',
    message: {
      address,
      timestamp: String(timestamp),
      nonce:     String(nonce),
      message:   CLOB_AUTH_MESSAGE,
    },
  };
}

async function deriveApiKey({ address, signature, timestamp, nonce = '0' }) {
  const headers = {
    'POLY_ADDRESS':   ethers.getAddress(address),
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': String(timestamp),
    'POLY_NONCE':     String(nonce),
    'Content-Type':   'application/json',
  };
  let r = await fetchJson(`${CLOB_REST}/auth/derive-api-key`, { method: 'GET', headers });
  if (r.ok && r.body?.apiKey) return r.body;
  r = await fetchJson(`${CLOB_REST}/auth/api-key`, { method: 'POST', headers });
  if (!r.ok) throw new Error(`Polymarket auth failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body;
}

module.exports = {
  EXCHANGE_ADDRESS, CHAIN_ID, CLOB_REST, GAMMA_API,
  buildOrder, signOrder, submitOrder, buildL2Headers,
  fetchMarket, fetchMarketByTokenId,
  getClobAuthRequest, deriveApiKey,
  ORDER_DOMAIN, ORDER_TYPES,
};
