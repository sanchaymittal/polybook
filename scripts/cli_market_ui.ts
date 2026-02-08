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

function formatPriceProb(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const p = n / 1_000_000;
  return p.toFixed(4);
}

function formatSizeHuman(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const units = n / 1_000_000;
  if (units >= 100) return units.toFixed(0);
  if (units >= 10) return units.toFixed(1);
  return units
    .toFixed(3)
    .replace(/\.?0+$/, '');
}

function extractStartTs(slug: string): number | null {
  const match = slug.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function fitLine(text: string, width: number): string {
  const ansi = /\u001b\[[0-9;]*m/g;
  const plain = text.replace(ansi, '');
  if (plain.length === width) return text;
  if (plain.length < width) return text + ' '.repeat(width - plain.length);
  if (width <= 1) return text.slice(0, width);
  const target = width - 1;
  let out = '';
  let visible = 0;
  for (let i = 0; i < text.length && visible < target; i += 1) {
    const ch = text[i];
    if (ch === '\u001b') {
      const match = text.slice(i).match(/^\u001b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    out += ch;
    visible += 1;
  }
  return `${out}…`;
}

function terminalWidth(): number {
  const w = process.stdout.columns || 110;
  return Math.max(96, Math.min(160, w));
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

  const baselineY = baseline != null && Number.isFinite(baseline) ? toY(baseline) : null;
  if (baselineY != null) {
    for (let x = 0; x < width; x += 1) grid[baselineY][x] = '┄';
  }

  const ys = slice.map((v) => toY(v));
  for (let x = 0; x < ys.length; x += 1) {
    const y = ys[x];
    grid[y][x] = '●';
    if (x === 0) continue;
    const prevY = ys[x - 1];
    if (prevY === y) {
      grid[y][x - 1] = '─';
    } else {
      const step = prevY < y ? 1 : -1;
      for (let yy = prevY; yy !== y; yy += step) {
        grid[yy][x - 1] = '│';
      }
      grid[y][x - 1] = step === 1 ? '╮' : '╰';
    }
  }

  if (baselineY != null && ys.length > 0) {
    const xLast = ys.length - 1;
    const yLast = ys[xLast];
    if (yLast !== baselineY) {
      const step = yLast < baselineY ? 1 : -1;
      for (let yy = yLast; yy !== baselineY; yy += step) {
        if (grid[yy][xLast] === ' ') grid[yy][xLast] = '│';
      }
    }
    grid[baselineY][xLast] = '○';
    grid[yLast][xLast] = '◆';
  }

  return grid.map((row) => row.join(''));
}

function renderChartBox(lines: string[], width: number): string[] {
  const top = `┌${'─'.repeat(width)}┐`;
  const bottom = `└${'─'.repeat(width)}┘`;
  const boxed = lines.map((line) => `│${line.padEnd(width, ' ')}│`);
  return [top, ...boxed, bottom];
}

function sizeUnits(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / 1_000_000;
}

function makeBar(size: number, max: number, width: number): string {
  if (width <= 0) return '';
  if (max <= 0) return ' '.repeat(width);
  const filled = Math.round((size / max) * width);
  return '█'.repeat(Math.max(0, Math.min(width, filled))).padEnd(width, ' ');
}

function formatPastMarketLine(market: MarketMetadata): string {
  const arrow = market.payout_result === true ? '↑' : market.payout_result === false ? '↓' : '·';
  const ts = extractStartTs(market.slug);
  if (!ts) return arrow;
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${arrow} ${hh}:${mm} UTC`;
}

function formatBookCell(
  level: PriceLevel | undefined,
  color: string,
  priceWidth: number,
  sizeWidth: number,
  barWidth: number,
  maxSize: number
): string {
  const cellWidth = priceWidth + 1 + sizeWidth + 1 + barWidth;
  if (!level) return ' '.repeat(cellWidth);
  const price = formatPriceProb(level.price).padStart(priceWidth, ' ');
  const size = formatSizeHuman(level.quantity).padStart(sizeWidth, ' ');
  const bar = makeBar(sizeUnits(level.quantity), maxSize, barWidth);
  return `${color}${price} ${size} ${bar}${COLOR_RESET}`;
}

function headerCell(priceWidth: number, sizeWidth: number, barWidth: number): string {
  const price = 'Price'.padStart(priceWidth, ' ');
  const size = 'Size'.padStart(sizeWidth, ' ');
  const bar = 'Bar'.padEnd(barWidth, ' ');
  return `${price} ${size} ${bar}`;
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
  const total = terminalWidth();
  const sep = ' │ ';
  const minRight = 42;
  const leftWidth = Math.max(44, Math.min(Math.floor(total * 0.48), total - minRight - sep.length));
  const rightWidth = total - leftWidth - sep.length;

  console.log('POLYBOOK');
  console.log('─'.repeat(total));

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
    const expiry = startTs + MARKET_DURATION_SECONDS;
    left.push(`Expiry: ${formatUtcTime(expiry)}`);
    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = expiry - nowSec;
    left.push(`Time left: ${remaining > 0 ? formatTimeLeft(remaining) : 'EXPIRED'}`);
  }
  left.push('');
  left.push(`BTCUSD (${storkStatus})`);
  const seriesPrices = storkSeries.map((p) => p.price);
  const chartInnerWidth = Math.max(24, leftWidth - 4);
  const chart = renderLineChart(seriesPrices, chartInnerWidth, 8, startPrice);
  const chartBox = renderChartBox(chart, chartInnerWidth);
  for (const line of chartBox) left.push(line);
  if (startPrice != null) {
    left.push('Entry ○   Current ◆');
  }
  if (startPrice != null && currentPrice != null) {
    const delta = currentPrice - startPrice;
    const pct = startPrice ? (delta / startPrice) * 100 : 0;
    const sign = delta >= 0 ? '+' : '';
    left.push(`Start: ${startPrice.toFixed(2)}`);
    left.push(`Now:   ${currentPrice.toFixed(2)} (${sign}${delta.toFixed(2)} / ${sign}${pct.toFixed(2)}%)`);
  } else if (currentPrice != null) {
    left.push(`Now:   ${currentPrice.toFixed(2)}`);
  }
  left.push('');
  left.push('PAST MARKETS');
  const pastList = recentMarkets.slice(0, 4).map((m) => formatPastMarketLine(m));
  if (pastList.length === 0) left.push('—');
  left.push(...pastList);

  const right: string[] = [];
  right.push('ORDERBOOK');
  const priceWidth = 7;
  const sizeWidth = 6;
  const gap = '  ';
  const baseCell = priceWidth + 1 + sizeWidth + 1;
  const available = rightWidth - gap.length - baseCell * 2;
  const barWidth = Math.max(4, Math.min(14, Math.floor(available / 2)));
  const cellWidth = baseCell + barWidth;
  const header = headerCell(priceWidth, sizeWidth, barWidth);

  const upBids = snapshot?.yes.bids || [];
  const upAsks = snapshot?.yes.asks || [];
  const downBids = snapshot?.no.bids || [];
  const downAsks = snapshot?.no.asks || [];

  const maxUpBid = Math.max(1, ...upBids.map((l) => sizeUnits(l.quantity)));
  const maxUpAsk = Math.max(1, ...upAsks.map((l) => sizeUnits(l.quantity)));
  const maxDownBid = Math.max(1, ...downBids.map((l) => sizeUnits(l.quantity)));
  const maxDownAsk = Math.max(1, ...downAsks.map((l) => sizeUnits(l.quantity)));

  right.push(`${COLOR_YES}UP${COLOR_RESET}`);
  right.push(`${'BID'.padEnd(cellWidth, ' ')}${gap}${'ASK'.padEnd(cellWidth, ' ')}`);
  right.push(`${header}${gap}${header}`);
  const maxRows = 6;
  for (let i = 0; i < maxRows; i += 1) {
    const bid = formatBookCell(upBids[i], COLOR_YES, priceWidth, sizeWidth, barWidth, maxUpBid);
    const ask = formatBookCell(upAsks[i], COLOR_YES, priceWidth, sizeWidth, barWidth, maxUpAsk);
    right.push(`${bid}${gap}${ask}`);
  }
  right.push('');
  right.push(`${COLOR_NO}DOWN${COLOR_RESET}`);
  right.push(`${'BID'.padEnd(cellWidth, ' ')}${gap}${'ASK'.padEnd(cellWidth, ' ')}`);
  right.push(`${header}${gap}${header}`);
  for (let i = 0; i < maxRows; i += 1) {
    const bid = formatBookCell(downBids[i], COLOR_NO, priceWidth, sizeWidth, barWidth, maxDownBid);
    const ask = formatBookCell(downAsks[i], COLOR_NO, priceWidth, sizeWidth, barWidth, maxDownAsk);
    right.push(`${bid}${gap}${ask}`);
  }

  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i += 1) {
    const l = fitLine(left[i] || '', leftWidth);
    const r = fitLine(right[i] || '', rightWidth);
    console.log(`${l}${sep}${r}`);
  }

  console.log('─'.repeat(total));
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
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  let clobWs: WebSocket | null = null;
  let storkWs: WebSocket | null = null;

  const scheduleRender = (delay = 120) => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
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
    }, delay);
  };

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
        scheduleRender();
      } catch (_) {
        // ignore
      }
    });
    clobWs.on('error', () => {
      wsStatus = 'error';
      scheduleRender();
    });
    clobWs.on('close', () => {
      wsStatus = 'closed';
      scheduleRender();
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
            scheduleRender();
          }
        } catch (_) {
          // ignore
        }
      });
      storkWs.on('error', () => {
        storkStatus = 'error';
        scheduleRender();
      });
      storkWs.on('close', () => {
        storkStatus = 'closed';
        scheduleRender();
      });
    }

    scheduleRender(0);
  };

  await connectMarket(market);

  setInterval(async () => {
    try {
      const recent = await getRecentTrades(25);
      const byId = new Map<string, TradeResult>();
      for (const t of recent) byId.set(t.trade_id, t);
      const filtered = Array.from(byId.values())
        .filter((t) => t.token_id === market!.yes_token_id || t.token_id === market!.no_token_id)
        .sort((a, b) => {
          const ai = Number(a.trade_id.replace('trade-', '')) || 0;
          const bi = Number(b.trade_id.replace('trade-', '')) || 0;
          return bi - ai;
        });
      trades = filtered;
      tradeStatus = `ok/${trades.length}`;
      scheduleRender();
    } catch (_) {
      tradeStatus = 'error';
      scheduleRender();
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
        const next = pickLatestRotationMarket(rotation);
        if (next && next.market_id !== market!.market_id) {
          await connectMarket(next);
        }
      }
      scheduleRender();
    } catch (_) {
      // ignore
    }
  }, 5000);

  setInterval(() => {
    scheduleRender();
  }, 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
