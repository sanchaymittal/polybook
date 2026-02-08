import axios from 'axios';
import WebSocket from 'ws';
import 'dotenv/config';

const CLOB_API_URL = process.env.CLOB_API_URL || 'http://localhost:3030';
const CLOB_WS_MARKET_URL = process.env.CLOB_WS_MARKET_URL || 'ws://localhost:3030/ws/orderbook/market';
const MARKET_DURATION_SECONDS = parseInt(process.env.MARKET_DURATION_SECONDS || '300', 10);
const STORK_API_KEY = process.env.STORK_API_KEY || '';
const STORK_REST_URL = process.env.STORK_REST_URL || 'https://rest.jp.stork-oracle.network';
const STORK_WS_URL = process.env.STORK_WS_URL || 'wss://api.jp.stork-oracle.network/evm/subscribe';
const STORK_ASSET = process.env.STORK_ASSET || 'BTCUSD';
const COLOR_YES = '\u001b[32m';
const COLOR_NO = '\u001b[31m';
const COLOR_DIM = '\u001b[2m';
const COLOR_RESET = '\u001b[0m';

type PriceLevel = { price: string; quantity: string; order_count: number };

type OrderBookState = {
  token_id: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

type MarketOrderBookState = {
  market_id: string;
  yes: OrderBookState;
  no: OrderBookState;
};

type MarketMetadata = {
  market_id: string;
  slug: string;
  question: string;
  yes_token_id: string;
  no_token_id: string;
  status: string;
  payout_result?: boolean | null;
};

type TradeResult = {
  trade_id: string;
  token_id: string;
  price: string;
  quantity: string;
  buyer: string;
  seller: string;
};

type StorkPricePoint = {
  ts: number;
  price: number;
};

async function getActiveMarkets(): Promise<MarketMetadata[]> {
  const res = await axios.get(`${CLOB_API_URL}/markets?status=ACTIVE`);
  return res.data.markets || [];
}

async function getAllMarkets(): Promise<MarketMetadata[]> {
  const res = await axios.get(`${CLOB_API_URL}/markets`);
  return res.data.markets || [];
}

async function getRecentTrades(limit: number): Promise<TradeResult[]> {
  const res = await axios.get(`${CLOB_API_URL}/trades`, { params: { limit } });
  return res.data.trades || [];
}

function pickLatestRotationMarket(markets: MarketMetadata[]): MarketMetadata | null {
  const rotation = markets.filter((m) => m.slug.startsWith('btc-up-and-down-5min-'));
  if (rotation.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const withTs = rotation.map((m) => {
    const ts = extractStartTs(m.slug) || 0;
    const expiry = ts + MARKET_DURATION_SECONDS;
    return { m, ts, expiry };
  });
  const future = withTs.filter((x) => x.expiry > now);
  if (future.length > 0) {
    future.sort((a, b) => a.expiry - b.expiry);
    return future[0].m;
  }
  withTs.sort((a, b) => b.ts - a.ts);
  return withTs[0].m;
}

function formatNum(value: string, width: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value).padStart(width, ' ');
  const s = Math.trunc(n).toLocaleString('en-US');
  return s.padStart(width, ' ');
}

function formatPriceProb(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const p = n / 1_000_000;
  return p.toFixed(4);
}

function formatSizeHuman(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const human = n / 1_000_000;
  if (human >= 1000) return `${human.toFixed(0)}`;
  if (human >= 100) return `${human.toFixed(1)}`;
  if (human >= 10) return `${human.toFixed(2)}`;
  return `${human.toFixed(3)}`;
}

function extractStartTs(slug: string): number | null {
  const match = slug.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function formatUtcTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toUTCString().replace('GMT', 'UTC');
}

function formatTimeLeft(seconds: number): string {
  if (seconds <= 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function toPriceFloat(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / 1e18;
}

function renderLineChart(values: number[], width: number, height: number, baseline: number | null): string[] {
  if (values.length === 0) return Array.from({ length: height }, () => ' '.repeat(width));
  const slice = values.slice(-width);
  const minVal = Math.min(...slice, baseline ?? Infinity);
  const maxVal = Math.max(...slice, baseline ?? -Infinity);
  const range = maxVal - minVal || 1;

  const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
  const toY = (v: number) => {
    const t = (v - minVal) / range;
    const y = Math.round((height - 1) - t * (height - 1));
    return Math.max(0, Math.min(height - 1, y));
  };

  if (baseline != null && Number.isFinite(baseline)) {
    const by = toY(baseline);
    for (let x = 0; x < width; x += 1) grid[by][x] = '─';
  }

  for (let x = 0; x < slice.length; x += 1) {
    const y = toY(slice[x]);
    grid[y][x] = '●';
  }

  return grid.map((row) => row.join(''));
}

async function fetchStartPrice(startTs: number): Promise<number | null> {
  if (!STORK_API_KEY) return null;
  const headers = { Authorization: `Basic ${STORK_API_KEY}` };
  try {
    const res = await axios.get(`${STORK_REST_URL}/v1/prices/recent`, {
      headers,
      params: { timestamp: startTs, assets: STORK_ASSET },
    });
    const data = res.data?.data?.value?.[STORK_ASSET] || res.data?.data?.[STORK_ASSET];
    if (data?.price) return toPriceFloat(data.price);
  } catch (_) {
    // fall through to history
  }

  try {
    const from = Math.max(0, startTs - 120);
    const to = startTs + 120;
    const res = await axios.get(`${STORK_REST_URL}/v1/tradingview/history`, {
      headers,
      params: { from, to, resolution: '1', symbol: STORK_ASSET },
    });
    const t = res.data?.t;
    const c = res.data?.c;
    if (Array.isArray(t) && Array.isArray(c) && t.length === c.length && t.length > 0) {
      let bestIdx = 0;
      let bestDelta = Math.abs(t[0] - startTs);
      for (let i = 1; i < t.length; i += 1) {
        const delta = Math.abs(t[i] - startTs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      }
      return Number(c[bestIdx]) / 1e18;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

function renderScreen(
  market: MarketMetadata,
  snapshot: MarketOrderBookState | null,
  wsStatus: string,
  lastUpdate: string | null,
  storkStatus: string,
  storkSeries: StorkPricePoint[],
  startPrice: number | null,
  currentPrice: number | null,
  tradeStatus: string,
  trades: TradeResult[],
  recentMarkets: MarketMetadata[]
): void {
  console.clear();
  console.log('Polybook');
  console.log('');

  const left: string[] = [];
  left.push('MARKET');
  left.push('');
  left.push('BTC ↑ / ↓ (5 min)');
  left.push('──────────────');
  left.push(`Status: ${market.status || 'UNKNOWN'}`);
  left.push('Oracle: Stork');
  left.push('Strike: Price at expiry');
  const startTs = extractStartTs(market.slug);
  if (startTs !== null) {
    const expiry = (startTs as number) + MARKET_DURATION_SECONDS;
    left.push(`Expiry: ${formatUtcTime(expiry)}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = expiry - nowSec;
    left.push(`Time left: ${remaining > 0 ? formatTimeLeft(remaining) : 'EXPIRED'}`);
  }
  left.push('');
  left.push(`BTCUSD (${storkStatus})`);
  const seriesPrices = storkSeries.map((p) => p.price);
  const chart = renderLineChart(seriesPrices, 28, 6, startPrice);
  for (const line of chart) left.push(line);
  if (startPrice != null && currentPrice != null) {
    const delta = currentPrice - startPrice;
    const pct = startPrice ? (delta / startPrice) * 100 : 0;
    const sign = delta >= 0 ? '+' : '';
    left.push(`Start: ${startPrice.toFixed(2)}`);
    left.push(`Now:   ${currentPrice.toFixed(2)} (${sign}${delta.toFixed(2)} / ${sign}${pct.toFixed(2)}%)`);
  } else if (currentPrice != null) {
    left.push(`Now:   ${currentPrice.toFixed(2)}`);
  } else if (startTs != null) {
    left.push(`Start: ${startTs}`);
  }
  left.push('');
  left.push('PAST MARKETS');
  const pastList = recentMarkets.slice(0, 4).map((m) => {
    const arrow = m.payout_result === true ? '↑' : m.payout_result === false ? '↓' : '·';
    const ts = extractStartTs(m.slug);
    return `${arrow} ${ts ?? ''}`.trim();
  });
  if (pastList.length === 0) left.push('—');
  left.push(...pastList);

  const yesRows = snapshot ? formatSideRows(snapshot.yes.bids, true) : [];
  const noRows = snapshot ? formatSideRows(snapshot.no.asks, false) : [];

  const right: string[] = [];
  right.push('ORDERBOOK (YES / NO)');
  right.push(`${COLOR_YES}YES${COLOR_RESET}                 ${COLOR_NO}NO${COLOR_RESET}`);
  right.push('Price     Size      Price     Size');

  const maxRows = 12;
  const yesLevels = snapshot?.yes.bids || [];
  const noLevels = snapshot?.no.asks || [];
  for (let i = 0; i < maxRows; i += 1) {
    const y = yesLevels[i];
    const n = noLevels[i];
    const yLine = y
      ? `${COLOR_YES}${formatPriceProb(y.price).padStart(6, ' ')}  ${formatSizeHuman(y.quantity).padStart(6, ' ')}${COLOR_RESET}`
      : ' '.repeat(15);
    const nLine = n
      ? `${COLOR_NO}${formatPriceProb(n.price).padStart(6, ' ')}  ${formatSizeHuman(n.quantity).padStart(6, ' ')}${COLOR_RESET}`
      : '';
    right.push(`${yLine}  ${nLine}`);
  }

  const leftWidth = 40;
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i += 1) {
    const l = (left[i] || '').padEnd(leftWidth, ' ');
    const r = right[i] || '';
    console.log(`${l} ${r}`);
  }

  console.log('──────────────────────────────────────────────────────────────────────────────');
  const tradeLine = trades
    .slice(0, 5)
    .map((t) => `${formatPriceProb(t.price)} x ${formatSizeHuman(t.quantity)}`)
    .join('    ');
  console.log(`TRADES (${tradeStatus})`);
  console.log(tradeLine || '—');

  const footer = [
    `WS: ${wsStatus}`,
    `Last update: ${lastUpdate || '—'}`,
    `Market: ${market.market_id}`,
  ].join('  |  ');
  console.log('');
  console.log(`${COLOR_DIM}${footer}${COLOR_RESET}`);
}

async function main() {
  const argMarketId = process.argv[2];
  const markets = await getActiveMarkets();
  let market = argMarketId ? markets.find((m) => m.market_id === argMarketId) : null;
  if (!market) {
    market = pickLatestRotationMarket(markets);
  }

  if (!market) {
    console.error('No active BTC 5-min market found.');
    process.exit(1);
  }

  let lastSnapshot: MarketOrderBookState | null = null;
  let wsStatus = 'connecting';
  let lastUpdate: string | null = null;
  let storkStatus = STORK_API_KEY ? 'connecting' : 'disabled';
  const storkSeries: StorkPricePoint[] = [];
  let startPrice: number | null = null;
  let currentPrice: number | null = null;
  let tradeStatus = 'loading';
  let trades: TradeResult[] = [];
  let recentMarkets: MarketMetadata[] = [];

  let clobWs: WebSocket | null = null;
  let storkWs: WebSocket | null = null;

  const connectMarket = async (m: MarketMetadata) => {
    market = m;
    lastSnapshot = null;
    wsStatus = 'connecting';
    lastUpdate = null;
    storkStatus = STORK_API_KEY ? 'connecting' : 'disabled';
    storkSeries.length = 0;
    startPrice = null;
    currentPrice = null;
    trades = [];

    if (clobWs) clobWs.close();
    if (storkWs) storkWs.close();

    const wsUrl = `${CLOB_WS_MARKET_URL.replace(/\/$/, '')}/${market.market_id}`;
    console.log(`Connecting to ${wsUrl}`);

    clobWs = new WebSocket(wsUrl);
    clobWs.on('open', () => {
      wsStatus = 'connected';
    });
    clobWs.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as MarketOrderBookState;
        lastSnapshot = msg;
        lastUpdate = new Date().toLocaleTimeString();
      } catch (_) {
        // ignore
      }
    });
    clobWs.on('error', () => {
      wsStatus = 'error';
    });
    clobWs.on('close', () => {
      wsStatus = 'closed';
    });

    const startTs = extractStartTs(market.slug);
    if (STORK_API_KEY && startTs) {
      startPrice = await fetchStartPrice(startTs);
    }

    if (STORK_API_KEY) {
      storkWs = new WebSocket(STORK_WS_URL, {
        headers: { Authorization: `Basic ${STORK_API_KEY}` },
      });
      storkWs.on('open', () => {
        storkStatus = 'connected';
        const subscribe = { type: 'subscribe', data: [STORK_ASSET] };
        storkWs?.send(JSON.stringify(subscribe));
      });
      storkWs.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          const updates = msg.data;
          let priceRaw: string | null = null;
          let ts: number | null = null;

          if (Array.isArray(updates)) {
            for (const u of updates) {
              if (u?.asset_id === STORK_ASSET && u?.price) {
                priceRaw = u.price;
                ts = u.timestamp ? Math.floor(Number(u.timestamp) / 1e9) : Math.floor(Date.now() / 1000);
                break;
              }
            }
          } else if (updates && updates[STORK_ASSET]) {
            const u = updates[STORK_ASSET];
            priceRaw = u.price;
            ts = u.timestamp ? Math.floor(Number(u.timestamp) / 1e9) : Math.floor(Date.now() / 1000);
          }

          if (priceRaw) {
            const price = toPriceFloat(priceRaw);
            currentPrice = price;
            storkSeries.push({ ts: ts || Math.floor(Date.now() / 1000), price });
            while (storkSeries.length > 60) storkSeries.shift();
          }
        } catch (_) {
          // ignore
        }
      });
      storkWs.on('error', () => {
        storkStatus = 'error';
      });
      storkWs.on('close', () => {
        storkStatus = 'closed';
      });
    }
  };

  await connectMarket(market);

  setInterval(async () => {
    try {
      const recent = await getRecentTrades(25);
      const byId = new Map<string, TradeResult>();
      for (const t of recent) byId.set(t.trade_id, t);
      const filtered = Array.from(byId.values())
        .filter((t) => t.token_id === market.yes_token_id || t.token_id === market.no_token_id)
        .sort((a, b) => {
          const ai = Number(a.trade_id.replace('trade-', '')) || 0;
          const bi = Number(b.trade_id.replace('trade-', '')) || 0;
          return bi - ai;
        });
      trades = filtered;
      tradeStatus = `ok/${trades.length}`;
    } catch (_) {
      tradeStatus = 'error';
    }
  }, 3000);

  setInterval(async () => {
    try {
      const all = await getAllMarkets();
      const rotation = all.filter((m) => m.slug.startsWith('btc-up-and-down-5min-'));
      const now = Math.floor(Date.now() / 1000);
      const past = rotation
        .filter((m) => {
          const ts = extractStartTs(m.slug) || 0;
          return ts + MARKET_DURATION_SECONDS <= now;
        })
        .sort((a, b) => (extractStartTs(b.slug) || 0) - (extractStartTs(a.slug) || 0));
      recentMarkets = past;

      if (!argMarketId) {
        const active = all.filter((m) => m.status.toUpperCase() === 'ACTIVE');
        const next = pickLatestRotationMarket(active);
        if (next && next.market_id !== market.market_id) {
          await connectMarket(next);
        }
      }
    } catch (_) {
      // ignore
    }
  }, 5000);

  setInterval(() => {
    renderScreen(
      market as MarketMetadata,
      lastSnapshot,
      wsStatus,
      lastUpdate,
      storkStatus,
      storkSeries,
      startPrice,
      currentPrice,
      tradeStatus,
      trades,
      recentMarkets
    );
  }, 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
