import { getBars, AlpacaBar } from './alpaca';
import { logger } from '../utils/logger';

export interface BarData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function normalizeBar(bar: AlpacaBar): BarData {
  return {
    timestamp: bar.Timestamp,
    open: bar.OpenPrice,
    high: bar.HighPrice,
    low: bar.LowPrice,
    close: bar.ClosePrice,
    volume: bar.Volume,
  };
}

// Cache daily bars per symbol — they only change once a day
// Short TTL (5min) to pick up first bar of the new day without hammering API on every cycle
const BAR_CACHE_TTL_MS = 5 * 60 * 1000;
const barCache = new Map<string, { data: BarData[]; expiresAt: number }>();

export async function getHistoricalBars(symbol: string, limit: number = 100): Promise<BarData[]> {
  const key = `${symbol}:${limit}`;
  const cached = barCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const bars = await getBars(symbol, '1Day', limit);
    const data = bars.map(normalizeBar);
    barCache.set(key, { data, expiresAt: Date.now() + BAR_CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.error(`Failed to get historical bars for ${symbol}: ${err}`);
    return cached?.data ?? []; // Return stale on error rather than empty
  }
}

// Crypto intraday cache — 2min TTL (crypto moves fast)
const INTRADAY_CACHE_TTL_MS = 2 * 60 * 1000;
const intradayCache = new Map<string, { data: BarData[]; expiresAt: number }>();

export async function getIntradayBars(symbol: string, limit: number = 60): Promise<BarData[]> {
  const key = `${symbol}:intraday:${limit}`;
  const cached = intradayCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const bars = await getBars(symbol, '1Hour', limit);
    const data = bars.map(normalizeBar);
    intradayCache.set(key, { data, expiresAt: Date.now() + INTRADAY_CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.error(`Failed to get intraday bars for ${symbol}: ${err}`);
    return cached?.data ?? [];
  }
}
