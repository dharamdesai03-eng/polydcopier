// Orchestrator — converts mempool 'leaderFill' events into copy orders.
// Per-user filters, per-leader sizing, ZIG/fade mode, paper-trade switch.
const EventEmitter = require('events');
const { stmt } = require('./db');
const { decrypt } = require('./utils');
const { buildOrder, signOrder, submitOrder, fetchMarketByTokenId } = require('./polymarket');

const MAX_RETRIES = 1;  // mempool events are time-critical, don't burn budget retrying
const PAPER_TRADE = process.env.PAPER_TRADE === '1' || process.env.PAPER_TRADE === 'true';

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.marketCache = new Map();   // tokenId -> market
    this.recentlyHandled = new Map();  // dedup composite key -> ts (txHash+tokenId+side+size+price)
  }

  /** Returns Set<lowercase address> of leaders any user is currently copying. */
  getWatchedAddresses() {
    const rows = stmt.listAllActiveLeaders.all();
    const set = new Set();
    for (const r of rows) set.add(r.address.toLowerCase());
    return set;
  }

  /** Mempool handler — fan out one leader fill to every subscribed user. */
  async onLeaderFill(ev) {
    // Dedup — Polymarket batches multiple fills into one tx.
    const key = [ev.txHash, ev.tokenId, ev.side, ev.size, ev.price].join('|');
    if (this.recentlyHandled.has(key)) return;
    this.recentlyHandled.set(key, Date.now());
    if (this.recentlyHandled.size > 5000) {
      // Drop oldest half to bound memory.
      const arr = [...this.recentlyHandled.entries()].sort((a, b) => a[1] - b[1]);
      this.recentlyHandled = new Map(arr.slice(arr.length / 2));
    }

    // Look up market once, share across users.
    let market = this.marketCache.get(ev.tokenId);
    if (!market) {
      market = await fetchMarketByTokenId(ev.tokenId).catch(() => null);
      if (market) this.marketCache.set(ev.tokenId, market);
    }

    // All active subs on this leader.
    const allSubs = stmt.listAllActiveLeaders.all()
      .filter(r => r.address.toLowerCase() === ev.leaderAddress);
    if (allSubs.length === 0) return;

    await Promise.allSettled(allSubs.map(sub => this._copyForUser(sub, ev, market)));
  }

  async _copyForUser(sub, ev, market) {
    const detectedAt = ev.detectedAt;
    const userMode = sub.mode_override || sub.user_mode || 'COPY';
    if (userMode === 'PAUSE') return;

    // Filters
    const leaderUsdc = (ev.price || 0) * (ev.size || 0);
    const skip = (reason) => {
      this._record(sub, ev, market, userMode, 'skipped', reason, detectedAt, {});
    };

    if (sub.filter_min_price != null && ev.price < sub.filter_min_price)
      return skip(`price ${ev.price.toFixed(3)} < min ${sub.filter_min_price}`);
    if (sub.filter_max_price != null && ev.price > sub.filter_max_price)
      return skip(`price ${ev.price.toFixed(3)} > max ${sub.filter_max_price}`);
    if (sub.filter_only_side && ev.side !== sub.filter_only_side)
      return skip(`side ${ev.side} ≠ ${sub.filter_only_side}`);
    if (sub.filter_min_leader_usdc != null && leaderUsdc < sub.filter_min_leader_usdc)
      return skip(`leader spent $${leaderUsdc.toFixed(2)} < $${sub.filter_min_leader_usdc}`);
    if (sub.filter_cooldown_minutes && sub.last_copied_at) {
      const sinceMin = (Date.now() / 1000 - sub.last_copied_at) / 60;
      if (sinceMin < sub.filter_cooldown_minutes)
        return skip(`cooldown ${sinceMin.toFixed(1)}m < ${sub.filter_cooldown_minutes}m`);
    }
    if (market) {
      // Outcome filter (YES/NO) needs market.tokens lookup
      if (sub.filter_only_outcome && Array.isArray(market.tokens)) {
        const tk = market.tokens.find(t => t.token_id === ev.tokenId);
        const outcome = (tk?.outcome || '').toUpperCase();
        if (outcome && outcome !== sub.filter_only_outcome)
          return skip(`outcome ${outcome} ≠ ${sub.filter_only_outcome}`);
      }
      const closeIso = market.end_date_iso || market.endDate;
      if (closeIso) {
        const hours = (new Date(closeIso).getTime() - Date.now()) / 3_600_000;
        if (sub.filter_min_hours_to_close != null && hours < sub.filter_min_hours_to_close)
          return skip(`closes in ${hours.toFixed(1)}h < min ${sub.filter_min_hours_to_close}h`);
        if (sub.filter_max_hours_to_close != null && hours > sub.filter_max_hours_to_close)
          return skip(`closes in ${hours.toFixed(1)}h > max ${sub.filter_max_hours_to_close}h`);
      }
    }

    // ZIG: take the opposite outcome token.
    let myTokenId = ev.tokenId;
    let mySide = ev.side;
    if (userMode === 'ZIG') {
      if (market && Array.isArray(market.tokens)) {
        const opposite = market.tokens.find(t => t.token_id !== ev.tokenId);
        if (opposite) myTokenId = opposite.token_id;
      } else {
        return this._record(sub, ev, market, userMode, 'skipped', 'no_market_metadata', detectedAt, {});
      }
    }

    // Sizing — per-leader override OR user default.
    const sizePct = sub.copy_size_pct != null ? sub.copy_size_pct / 100 : (sub.size_multiplier || 1);
    const maxUsd = sub.max_trade_size_usdc != null ? sub.max_trade_size_usdc : (sub.user_max_usdc || 50);
    const scaledShares = ev.size * sizePct;
    const maxShares = maxUsd / Math.max(ev.price, 0.01);
    const mySize = Math.min(scaledShares, maxShares);
    if (mySize < 5) return skip(`below_min_size (${mySize.toFixed(1)})`);

    // Decrypt JIT
    let privateKey;
    try { privateKey = decrypt(sub.encrypted_trading_key); }
    catch (e) {
      return this._record(sub, ev, market, userMode, 'failed', 'decrypt_failed', detectedAt, {});
    }

    // Build / sign / submit
    let attempt = 0, lastErr = null;
    while (attempt <= MAX_RETRIES) {
      try {
        const order = buildOrder({
          makerAddress: sub.proxy_address,
          signerAddress: sub.proxy_address,
          tokenId: myTokenId,
          price: Number(ev.price.toFixed(3)),
          size: Math.floor(mySize),
          side: mySide,
          expirationSec: 0, feeRateBps: 0, signatureType: 0,
        });
        const signed = await signOrder(order, privateKey);

        if (PAPER_TRADE) {
          const submittedAt = Date.now();
          this._record(sub, ev, market, userMode, 'paper', null, detectedAt, {
            mySide, myTokenId, mySize, price: ev.price,
            botOrderId: 'paper-' + signed.salt.slice(-8),
            submittedAt, latency: submittedAt - detectedAt,
          });
          return;
        }

        const result = await submitOrder(signed, {
          address: sub.proxy_address,
          apiKey: sub.polymarket_api_key,
          apiSecret: sub.polymarket_api_secret,
          apiPassphrase: sub.polymarket_api_passphrase,
        });
        const submittedAt = Date.now();
        const latency = submittedAt - detectedAt;

        if (result.ok) {
          if (sub.id) try { stmt.markLeaderCopied.run(Math.floor(Date.now() / 1000), sub.id); } catch {}
          this._record(sub, ev, market, userMode, 'submitted', null, detectedAt, {
            mySide, myTokenId, mySize, price: ev.price,
            botOrderId: result.body?.orderID || result.body?.id,
            submittedAt, latency,
          });
          return;
        }
        lastErr = (result.body?.error) || JSON.stringify(result.body);
        if (result.status === 401 || result.status === 403) break;  // auth error, no retry
      } catch (e) {
        lastErr = e.message || String(e);
      }
      attempt++;
      await new Promise(r => setTimeout(r, 60));
    }
    this._record(sub, ev, market, userMode, 'failed', lastErr || 'unknown', detectedAt, {});
  }

  _record(sub, ev, market, mode, status, errMsg, detectedAt, extra) {
    const marketName = market?.question || market?.slug || null;
    const outcome = (() => {
      if (!market || !Array.isArray(market.tokens)) return null;
      const tk = market.tokens.find(t => t.token_id === (extra.myTokenId || ev.tokenId));
      return tk?.outcome || null;
    })();
    try {
      stmt.recordTrade.run(
        sub.chat_id,
        ev.leaderAddress,
        market?.condition_id || market?.conditionId || null,
        marketName,
        extra.mySide || ev.side,
        outcome,
        extra.price ?? ev.price ?? null,
        extra.mySize ?? ev.size ?? null,
        (extra.price ?? ev.price ?? 0) * (extra.mySize ?? ev.size ?? 0),
        mode,
        status,
        errMsg,
        ev.txHash || null,
        extra.botOrderId || null,
        Math.floor(detectedAt / 1000),
        extra.submittedAt ? Math.floor(extra.submittedAt / 1000) : null,
        extra.latency || null,
      );
    } catch (e) {
      console.error('[orch] recordTrade failed:', e.message);
    }
    this.emit('trade', {
      chat_id: sub.chat_id,
      leader: ev.leaderAddress,
      mode, status,
      side: extra.mySide || ev.side,
      price: extra.price ?? ev.price,
      size: extra.mySize ?? ev.size,
      market: marketName,
      outcome,
      latency_ms: extra.latency || null,
      error_msg: errMsg,
    });
  }
}

module.exports = { Orchestrator, PAPER_TRADE };
