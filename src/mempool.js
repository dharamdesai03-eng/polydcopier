// Polygon mempool watcher — Alchemy WebSocket.
//
// Why mempool: leader's order is submitted to Polymarket CLOB → CLOB matches
// it → Polymarket operator submits a `fillOrder`/`matchOrders` tx to the
// Exchange contract on Polygon. The instant that operator tx hits mempool
// (before it's even mined), the leader's fill is fully determined inside the
// calldata. We decode the calldata, extract maker addresses, and fire a
// 'leaderFill' event the millisecond we see a leader we're tracking.
//
// Latency budget for this layer: 50-150ms from operator tx submit -> our event.
const EventEmitter = require('events');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const { EXCHANGE_ADDRESS } = require('./polymarket');

// Polymarket Exchange ABI — only the order-matching functions we care about.
// The actual exchange exposes: fillOrder, fillOrders, matchOrders, fillAndMatchOrders.
// Order tuple matches the Polymarket CLOB Exchange contract layout on Polygon.
const ORDER_TUPLE = '(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)';

const EXCHANGE_ABI = [
  `function fillOrder(${ORDER_TUPLE} order, uint256 fillAmount)`,
  `function fillOrders(${ORDER_TUPLE}[] orders, uint256[] fillAmounts)`,
  `function matchOrders(${ORDER_TUPLE} takerOrder, ${ORDER_TUPLE}[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts)`,
];

const iface = new ethers.Interface(EXCHANGE_ABI);

class MempoolWatcher extends EventEmitter {
  constructor({ alchemyWsUrl, getWatchedAddresses }) {
    super();
    this.url = alchemyWsUrl;
    this.getWatchedAddresses = getWatchedAddresses;  // () => Set<lowercase address>
    this.ws = null;
    this.reqId = 1;
    this.subId = null;
    this.shouldRun = false;
    this.reconnectMs = 1000;
    this.reconnectMax = 30000;
    this.lastEventAt = 0;
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this._connect();
  }

  stop() {
    this.shouldRun = false;
    if (this.ws) try { this.ws.close(); } catch {}
    this.ws = null;
  }

  _connect() {
    if (!this.shouldRun) return;
    if (!this.url) {
      console.error('[mempool] ALCHEMY_WS_URL not set — mempool watcher disabled');
      return;
    }
    console.log('[mempool] connecting to', this.url.replace(/\/[^/]+$/, '/<key>'));
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      console.log('[mempool] connected');
      this.reconnectMs = 1000;
      this._subscribe();
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && msg.result && typeof msg.result === 'string') {
        // subscription confirmation
        this.subId = msg.result;
        console.log('[mempool] subscription id:', this.subId);
        this.emit('connected');
        return;
      }
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        this._onPendingTx(msg.params.result);
      }
    });

    this.ws.on('close', () => {
      console.log('[mempool] disconnected');
      this.emit('disconnected');
      if (this.shouldRun) this._scheduleReconnect();
    });

    this.ws.on('error', (e) => {
      console.error('[mempool] error:', e.message || e);
    });
  }

  _scheduleReconnect() {
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, this.reconnectMax);
    setTimeout(() => this._connect(), wait);
  }

  _subscribe() {
    // Alchemy's pendingTransactions WS, filtered to txs touching the
    // Polymarket Exchange. Vastly cheaper than firehose.
    const req = {
      jsonrpc: '2.0',
      id: this.reqId++,
      method: 'eth_subscribe',
      params: [
        'alchemy_pendingTransactions',
        {
          toAddress: [EXCHANGE_ADDRESS.toLowerCase()],
          hashesOnly: false,
        },
      ],
    };
    this.ws.send(JSON.stringify(req));
  }

  _onPendingTx(tx) {
    this.lastEventAt = Date.now();
    if (!tx || !tx.input || tx.input.length < 10) return;

    // Decode calldata against the Exchange ABI.
    let parsed;
    try {
      parsed = iface.parseTransaction({ data: tx.input, value: tx.value || '0x0' });
    } catch (e) {
      // Not an order-related call (could be governance, admin etc.) — ignore.
      return;
    }
    if (!parsed) return;

    const watched = this.getWatchedAddresses();
    if (!watched || watched.size === 0) return;

    // Extract every maker order from the call args.
    const makerOrders = [];
    const args = parsed.args;
    if (parsed.name === 'fillOrder') {
      makerOrders.push({ order: args[0], fillAmount: args[1] });
    } else if (parsed.name === 'fillOrders') {
      const orders = args[0];
      const fills = args[1];
      for (let i = 0; i < orders.length; i++) {
        makerOrders.push({ order: orders[i], fillAmount: fills[i] });
      }
    } else if (parsed.name === 'matchOrders') {
      // takerOrder + makerOrders. Both are interesting — leader could be either.
      makerOrders.push({ order: args[0], fillAmount: args[2] }); // taker
      const orders = args[1];
      const fills = args[3];
      for (let i = 0; i < orders.length; i++) {
        makerOrders.push({ order: orders[i], fillAmount: fills[i] });
      }
    } else {
      return;
    }

    // For each order in the batch, check if the maker is a watched leader.
    for (const item of makerOrders) {
      const o = item.order;
      const maker = (o.maker || o[1] || '').toString().toLowerCase();
      if (!maker || !watched.has(maker)) continue;

      const fillAmount = BigInt(item.fillAmount?.toString() || '0');
      const makerAmount = BigInt(o.makerAmount?.toString() || o[5]?.toString() || '0');
      const takerAmount = BigInt(o.takerAmount?.toString() || o[6]?.toString() || '0');
      const sideRaw = Number(o.side ?? o[10] ?? 0);

      // Reconstruct the leader's effective price + size from the order.
      // BUY:  makerAmount = USDC,  takerAmount = shares.  price = makerAmt/takerAmt
      // SELL: makerAmount = shares, takerAmount = USDC.    price = takerAmt/makerAmt
      let price, size;
      const isBuy = sideRaw === 0;
      if (isBuy) {
        size  = Number(takerAmount) / 1e6;
        price = Number(makerAmount) / Number(takerAmount);
      } else {
        size  = Number(makerAmount) / 1e6;
        price = Number(takerAmount) / Number(makerAmount);
      }
      // Honour partial fills if specified.
      if (fillAmount > 0n && fillAmount < (isBuy ? makerAmount : makerAmount)) {
        const ratio = Number(fillAmount) / Number(isBuy ? makerAmount : makerAmount);
        size = size * ratio;
      }

      const event = {
        leaderAddress: maker,
        tokenId:       (o.tokenId || o[4] || 0n).toString(),
        side:          isBuy ? 'BUY' : 'SELL',
        price:         Number.isFinite(price) ? price : null,
        size:          Number.isFinite(size) ? size : null,
        notional:      (Number.isFinite(price) && Number.isFinite(size)) ? price * size : null,
        txHash:        tx.hash,
        from:          tx.from,
        detectedAt:    Date.now(),
        rawOrder:      o,
        callName:      parsed.name,
      };

      this.emit('leaderFill', event);
    }
  }

  isHealthy() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

module.exports = { MempoolWatcher, EXCHANGE_ABI };
