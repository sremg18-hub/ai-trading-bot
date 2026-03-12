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

export async function getHistoricalBars(symbol: string, limit: number = 100): Promise<BarData[]> {
  try {
    const bars = await getBars(symbol, '1Day', limit);
    return bars.map(normalizeBar);
  } catch (err) {
    logger.error(`Failed to get historical bars for ${symbol}: ${err}`);
    return [];
  }
}

export async function getIntradayBars(symbol: string, limit: number = 60): Promise<BarData[]> {
  try {
    const bars = await getBars(symbol, '1Hour', limit);
    return bars.map(normalizeBar);
  } catch (err) {
    logger.error(`Failed to get intraday bars for ${symbol}: ${err}`);
    return [];
  }
}
