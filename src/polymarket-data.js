// Polymarket public-data client. Fetches live markets, leaderboard, user
// positions, and USDC balance — used by the Telegram bot's UX layer to
// render a Polymarket-app-style experience inside Telegram.
//
// All endpoints are public (no auth) so this module is read-only and safe
// to call from any user context. Keeps a 30-second in-memory cache so we
// don't hammer the public APIs when many users are browsing.

const { ethers } = require('ethers');

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA  = 'https://data-api.polymarket.com';
const LB    = 'https://lb-api.polymarket.com';
const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];

const cache = new Map();
const TTL_MS = 30_000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.t) < TTL_MS) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function jget(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Top live markets, ordered by 24h volume. Returns shape:
//   { id, question, slug, yesPrice, noPrice, volume24hr, endDate, image }
async function getTopMarkets({ limit = 10, search } = {}) {
  return cached(`mkts:${limit}:${search || ''}`, async () => {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      archived: 'false',
      limit: String(limit),
      order: 'volume24hr',
      ascending: 'false',
    });
    if (search) params.set('search', search);
    const rows = await jget(`${GAMMA}/markets?${params.toString()}`);
    return (Array.isArray(rows) ? rows : []).map(simplifyMarket);
  });
}

function simplifyMarket(m) {
  // Polymarket gamma 'outcomePrices' is a JSON-encoded string like '["0.62","0.38"]'
  let prices = [];
  try { prices = JSON.parse(m.outcomePrices || m.outcome_prices || '[]'); } catch (_) {}
  const yes = prices[0] != null ? Number(prices[0]) : null;
  const no  = prices[1] != null ? Number(prices[1]) : null;
  return {
    id:        m.id || m.conditionId,
    question:  m.question || m.title || '',
    slug:      m.slug,
    yesPrice:  yes,
    noPrice:   no,
    volume24h: Number(m.volume24hr || m.volume24Hr || 0),
    volume:    Number(m.volume || 0),
    endDate:   m.endDate || m.end_date,
    category:  m.category || (Array.isArray(m.tags) ? m.tags[0] : null),
    image:     m.image || m.icon,
    url:       `https://polymarket.com/event/${m.slug || ''}`,
  };
}

// Top traders by recent profit. Returns shape:
//   { rank, name, address, profit, volume, winRate }
async function getLeaderboard({ limit = 10, period = '1d' } = {}) {
  return cached(`lb:${period}:${limit}`, async () => {
    // Try the official leaderboard endpoint first
    const candidates = [
      `${LB}/leaderboard?period=${period}&limit=${limit}`,
      `${DATA}/leaderboard?period=${period}&limit=${limit}`,
    ];
    for (const url of candidates) {
      try {
        const rows = await jget(url);
        const arr = Array.isArray(rows) ? rows : (rows.data || rows.leaderboard || []);
        if (arr.length === 0) continue;
        return arr.slice(0, limit).map((r, i) => ({
          rank:    r.rank || i + 1,
          name:    r.name || r.username || r.displayName || null,
          address: (r.address || r.proxy || r.proxyAddress || r.user || '').toLowerCase(),
          profit:  Number(r.profit ?? r.pnl ?? r.amount ?? 0),
          volume:  Number(r.volume || 0),
          winRate: r.winRate != null ? Number(r.winRate) : null,
        })).filter(x => x.address);
      } catch (_) { /* try next */ }
    }
    return [];
  });
}

// User active positions on Polymarket. Returns shape:
//   { market, outcome, size, entryPrice, currentPrice, pnl, pnlPct }
async function getPositions(address) {
  if (!address) return [];
  const addr = address.toLowerCase();
  return cached(`pos:${addr}`, async () => {
    const url = `${DATA}/positions?user=${addr}&sizeThreshold=0.1`;
    try {
      const rows = await jget(url);
      const arr = Array.isArray(rows) ? rows : (rows.data || []);
      return arr.map(p => ({
        market:       p.title || p.market || p.eventTitle || '',
        outcome:      p.outcome || (p.outcomeIndex === 1 ? 'NO' : 'YES'),
        size:         Number(p.size || 0),
        entryPrice:   Number(p.avgPrice || p.entryPrice || 0),
        currentPrice: Number(p.curPrice || p.currentPrice || 0),
        pnl:          Number(p.cashPnl ?? p.pnl ?? 0),
        pnlPct:       p.percentPnl != null ? Number(p.percentPnl) : null,
        slug:         p.slug,
      }));
    } catch (_) {
      return [];
    }
  });
}

// USDC balance on Polygon. Returns { native, bridged, total } in human dollars.
async function getUsdcBalance(address) {
  if (!address) return { native: 0, bridged: 0, total: 0 };
  const addr = address.toLowerCase();
  return cached(`bal:${addr}`, async () => {
    try {
      const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
      const [n, b] = await Promise.all([
        new ethers.Contract(USDC_NATIVE, ERC20_BAL_ABI, provider).balanceOf(address),
        new ethers.Contract(USDC_BRIDGED, ERC20_BAL_ABI, provider).balanceOf(address),
      ]);
      const native  = Number(ethers.formatUnits(n, 6));
      const bridged = Number(ethers.formatUnits(b, 6));
      return { native, bridged, total: native + bridged };
    } catch (e) {
      return { native: 0, bridged: 0, total: 0, err: e.message };
    }
  });
}

// User overall stats from data-api: total volume, total PnL, position count.
async function getUserSummary(address) {
  if (!address) return null;
  const addr = address.toLowerCase();
  return cached(`sum:${addr}`, async () => {
    try {
      const r = await jget(`${DATA}/value?user=${addr}`);
      return {
        equity:     Number(r.value ?? r.equity ?? 0),
        volume:     Number(r.volume ?? 0),
        profit:     Number(r.profit ?? r.pnl ?? 0),
        positions:  Number(r.openPositions ?? r.positions ?? 0),
      };
    } catch (_) {
      return null;
    }
  });
}

module.exports = {
  getTopMarkets,
  getLeaderboard,
  getPositions,
  getUsdcBalance,
  getUserSummary,
};
