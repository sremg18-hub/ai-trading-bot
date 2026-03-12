import Alpaca from '@alpacahq/alpaca-trade-api';
import { loadConfig } from '../config';
import { PositionInfo } from '../types';
import { logger } from '../utils/logger';

const config = loadConfig();

const alpaca = new Alpaca({
  keyId: config.alpacaKeyId,
  secretKey: config.alpacaSecretKey,
  paper: true, // HARDCODED — NEVER real money
  usePolygon: false,
});

export interface AlpacaAccount {
  equity: number;
  cash: number;
  buying_power: number;
  portfolio_value: number;
  last_equity: number;
}

export interface AlpacaBar {
  Timestamp: string;
  OpenPrice: number;
  HighPrice: number;
  LowPrice: number;
  ClosePrice: number;
  Volume: number;
}

export async function getAccount(): Promise<AlpacaAccount> {
  try {
    const account = await alpaca.getAccount();
    return {
      equity: parseFloat(account.equity),
      cash: parseFloat(account.cash),
      buying_power: parseFloat(account.buying_power),
      portfolio_value: parseFloat(account.portfolio_value),
      last_equity: parseFloat(account.last_equity),
    };
  } catch (err) {
    logger.error(`Failed to get account: ${err}`);
    throw err;
  }
}

export async function getPositions(): Promise<PositionInfo[]> {
  try {
    const positions = await alpaca.getPositions();
    return positions.map((p: Record<string, string>) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPnl: parseFloat(p.unrealized_pl),
      unrealizedPnlPercent: parseFloat(p.unrealized_plpc) * 100,
    }));
  } catch (err) {
    logger.error(`Failed to get positions: ${err}`);
    throw err;
  }
}

export async function getBars(symbol: string, timeframe: string = '1Day', limit: number = 100): Promise<AlpacaBar[]> {
  try {
    const bars: AlpacaBar[] = [];
    // Calculate start date — go back enough days to get `limit` bars
    const daysBack = timeframe === '1Hour' ? Math.ceil(limit / 7) + 5 : limit + 30;
    const start = new Date();
    start.setDate(start.getDate() - daysBack);

    const barIterator = alpaca.getBarsV2(symbol, {
      timeframe,
      limit,
      start: start.toISOString().split('T')[0],
      end: new Date().toISOString().split('T')[0],
      feed: 'iex',
    });
    for await (const bar of barIterator) {
      bars.push(bar);
    }
    logger.info(`Got ${bars.length} bars for ${symbol} (${timeframe})`);
    return bars;
  } catch (err) {
    logger.error(`Failed to get bars for ${symbol}: ${err}`);
    throw err;
  }
}

export async function getNews(symbol: string, limit: number = 10): Promise<Array<{ headline: string; summary: string; created_at: string }>> {
  try {
    const news = await alpaca.getNews({
      symbols: [symbol],
      limit,
    });
    return news.map((n) => ({
      headline: n.Headline || '',
      summary: n.Summary || '',
      created_at: n.CreatedAt || '',
    }));
  } catch (err) {
    logger.error(`Failed to get news for ${symbol}: ${err}`);
    return [];
  }
}

export async function submitOrder(
  symbol: string,
  qty: number,
  side: 'buy' | 'sell',
  type: 'market' | 'limit' = 'market'
): Promise<Record<string, unknown>> {
  try {
    const order = await alpaca.createOrder({
      symbol,
      qty,
      side,
      type,
      time_in_force: 'day',
    });
    logger.trade(`${side.toUpperCase()} ${symbol} x${qty} — Order ID: ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`Failed to submit order ${side} ${symbol} x${qty}: ${err}`);
    throw err;
  }
}

export async function getOrderStatus(orderId: string): Promise<Record<string, unknown>> {
  try {
    return await alpaca.getOrder(orderId);
  } catch (err) {
    logger.error(`Failed to get order status ${orderId}: ${err}`);
    throw err;
  }
}

// --- Crypto ---

export interface CryptoBar {
  Timestamp: string;
  Open: number;
  High: number;
  Low: number;
  Close: number;
  Volume: number;
  VWAP: number;
  TradeCount: number;
}

export async function getCryptoBars(symbol: string, timeframe: string = '1Hour', limit: number = 100): Promise<CryptoBar[]> {
  try {
    const daysBack = timeframe === '1Day' ? limit + 10 : Math.ceil(limit / 24) + 5;
    const start = new Date();
    start.setDate(start.getDate() - daysBack);

    const barsMap = await alpaca.getCryptoBars(
      [symbol],
      {
        timeframe,
        start: start.toISOString(),
        limit,
      },
    );
    const bars = barsMap.get(symbol) || [];
    logger.info(`Got ${bars.length} crypto bars for ${symbol} (${timeframe})`);
    return bars as CryptoBar[];
  } catch (err) {
    logger.error(`Failed to get crypto bars for ${symbol}: ${err}`);
    return [];
  }
}

export async function getLatestCryptoQuote(symbol: string): Promise<{ bid: number; ask: number; mid: number } | null> {
  try {
    const quotes = await alpaca.getLatestCryptoQuotes([symbol]);
    const q = quotes.get(symbol);
    if (!q) return null;
    return {
      bid: q.BidPrice,
      ask: q.AskPrice,
      mid: (q.BidPrice + q.AskPrice) / 2,
    };
  } catch (err) {
    logger.error(`Failed to get crypto quote for ${symbol}: ${err}`);
    return null;
  }
}

export async function submitCryptoOrder(
  symbol: string,
  qty: number,
  side: 'buy' | 'sell',
): Promise<Record<string, unknown>> {
  try {
    const order = await alpaca.createOrder({
      symbol,
      qty: qty.toString(),
      side,
      type: 'market',
      time_in_force: 'gtc',
    });
    logger.trade(`[CRYPTO] ${side.toUpperCase()} ${symbol} x${qty} — Order ID: ${order.id}`);
    return order;
  } catch (err) {
    logger.error(`Failed to submit crypto order ${side} ${symbol} x${qty}: ${err}`);
    throw err;
  }
}

export async function getClock(): Promise<{ is_open: boolean; next_open: string; next_close: string }> {
  try {
    const clock = await alpaca.getClock();
    return {
      is_open: clock.is_open,
      next_open: clock.next_open,
      next_close: clock.next_close,
    };
  } catch (err) {
    logger.error(`Failed to get clock: ${err}`);
    throw err;
  }
}
