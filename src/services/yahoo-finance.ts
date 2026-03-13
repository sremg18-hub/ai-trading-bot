/**
 * Yahoo Finance Data Service
 * Free market data without API keys
 * Provides additional context: fundamentals, analyst ratings, short interest
 */

import { logger } from '../utils/logger';

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_QUOTE = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary';

export interface YahooBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  avgVolume3Month: number;
  marketCap?: number;
  peRatio?: number;
  eps?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  targetPrice?: number;
  recommendation?: string; // BUY, HOLD, SELL
  shortRatio?: number;
}

// Cache to avoid rate limiting
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function fetchWithCache<T>(url: string): Promise<T | null> {
  const cached = cache.get(url);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data as T;
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        logger.warn('[YAHOO] Rate limited, using cache if available');
        return cached?.data as T || null;
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as T;
    cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.warn(`[YAHOO] Fetch failed: ${err}`);
    return cached?.data as T || null;
  }
}

/**
 * Get real-time quote with volume analysis
 */
export async function getYahooQuote(symbol: string): Promise<YahooQuote | null> {
  const cleanSymbol = symbol.replace(/\//g, '-'); // Handle crypto like BTC-USD
  const url = `${YAHOO_QUOTE}/${cleanSymbol}?modules=price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend`;
  
  const data = await fetchWithCache<Record<string, unknown>>(url);
  if (!data) return null;

  try {
    const result = (data as { quoteSummary?: { result?: unknown[] } }).quoteSummary?.result?.[0] as {
      price?: { regularMarketPrice?: { raw: number }; regularMarketChange?: { raw: number }; regularMarketChangePercent?: { raw: number }; symbol?: string };
      summaryDetail?: { volume?: { raw: number }; averageVolume3Month?: { raw: number }; marketCap?: { raw: number }; fiftyTwoWeekHigh?: { raw: number }; fiftyTwoWeekLow?: { raw: number }; shortRatio?: { raw: number } };
      defaultKeyStatistics?: { trailingPE?: { raw: number }; trailingEps?: { raw: number } };
      financialData?: { targetMeanPrice?: { raw: number }; recommendationKey?: string };
    };

    if (!result) return null;

    const price = result.price?.regularMarketPrice?.raw || 0;
    const avgVolume = result.summaryDetail?.averageVolume3Month?.raw || 0;
    const currentVolume = result.summaryDetail?.volume?.raw || 0;

    return {
      symbol: result.price?.symbol || cleanSymbol,
      price,
      change: result.price?.regularMarketChange?.raw || 0,
      changePercent: result.price?.regularMarketChangePercent?.raw || 0,
      volume: currentVolume,
      avgVolume3Month: avgVolume,
      marketCap: result.summaryDetail?.marketCap?.raw,
      peRatio: result.defaultKeyStatistics?.trailingPE?.raw,
      eps: result.defaultKeyStatistics?.trailingEps?.raw,
      fiftyTwoWeekHigh: result.summaryDetail?.fiftyTwoWeekHigh?.raw,
      fiftyTwoWeekLow: result.summaryDetail?.fiftyTwoWeekLow?.raw,
      targetPrice: result.financialData?.targetMeanPrice?.raw,
      recommendation: result.financialData?.recommendationKey,
      shortRatio: result.summaryDetail?.shortRatio?.raw,
    };
  } catch (err) {
    logger.error(`[YAHOO] Parse error: ${err}`);
    return null;
  }
}

/**
 * Get intraday bars for volume spike detection
 */
export async function getYahooIntraday(symbol: string, interval: '1m' | '5m' | '15m' | '1h' = '5m', range: '1d' | '5d' = '1d'): Promise<YahooBar[]> {
  const cleanSymbol = symbol.replace(/\//g, '-');
  const url = `${YAHOO_BASE}/${cleanSymbol}?interval=${interval}&range=${range}&includeAdjustedClose=true`;
  
  const data = await fetchWithCache<Record<string, unknown>>(url);
  if (!data) return [];

  try {
    const result = (data as { chart?: { result?: unknown[] } }).chart?.result?.[0] as {
      timestamp?: number[];
      indicators?: { quote?: { open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }[] };
    };

    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];

    return timestamps.map((ts, i) => ({
      timestamp: ts,
      open: quote.open?.[i] || 0,
      high: quote.high?.[i] || 0,
      low: quote.low?.[i] || 0,
      close: quote.close?.[i] || 0,
      volume: quote.volume?.[i] || 0,
    })).filter(b => b.close > 0);
  } catch (err) {
    logger.error(`[YAHOO] Intraday parse error: ${err}`);
    return [];
  }
}

/**
 * Detect volume spike relative to average
 * Returns ratio > 1.0 means above average
 */
export async function detectVolumeSpike(symbol: string): Promise<{ spikeRatio: number; isSpike: boolean; direction: 'up' | 'down' | 'neutral' } | null> {
  const [quote, intraday] = await Promise.all([
    getYahooQuote(symbol),
    getYahooIntraday(symbol, '5m', '1d'),
  ]);

  if (!quote || !intraday.length) return null;

  // Calculate current volume vs average
  const currentVolume = quote.volume;
  const avgVolume = quote.avgVolume3Month;
  
  if (!avgVolume || avgVolume === 0) return null;

  const spikeRatio = currentVolume / avgVolume;

  // Determine direction based on recent price action
  const recentBars = intraday.slice(-6); // Last 30 minutes
  if (recentBars.length < 2) return { spikeRatio, isSpike: spikeRatio > 2, direction: 'neutral' };

  const startPrice = recentBars[0].close;
  const endPrice = recentBars[recentBars.length - 1].close;
  const change = (endPrice - startPrice) / startPrice;

  let direction: 'up' | 'down' | 'neutral' = 'neutral';
  if (change > 0.005) direction = 'up';
  else if (change < -0.005) direction = 'down';

  // Spike threshold: 2x average volume
  const isSpike = spikeRatio > 2.0;

  if (isSpike) {
    logger.signal(`[YAHOO/VOLUME] ${symbol}: ${spikeRatio.toFixed(1)}x avg volume, ${direction} trend`);
  }

  return { spikeRatio, isSpike, direction };
}

/**
 * Get analyst sentiment from Yahoo
 * Returns score -1 to 1
 */
export async function getAnalystSentiment(symbol: string): Promise<{ score: number; consensus: string; targetUpside: number } | null> {
  const quote = await getYahooQuote(symbol);
  if (!quote || !quote.recommendation) return null;

  const recMap: Record<string, number> = {
    'strong_buy': 1.0,
    'buy': 0.6,
    'hold': 0,
    'sell': -0.6,
    'strong_sell': -1.0,
  };

  const score = recMap[quote.recommendation.toLowerCase()] || 0;
  
  let targetUpside = 0;
  if (quote.targetPrice && quote.price) {
    targetUpside = (quote.targetPrice - quote.price) / quote.price;
  }

  return {
    score,
    consensus: quote.recommendation.toUpperCase(),
    targetUpside,
  };
}

/**
 * Detect unusual options activity proxy (using short ratio and volume)
 */
export async function detectUnusualActivity(symbol: string): Promise<{
  unusualVolume: boolean;
  unusualShortInterest: boolean;
  near52WeekLow: boolean;
  near52WeekHigh: boolean;
  score: number; // -1 to 1, higher = more bullish signals
} | null> {
  const quote = await getYahooQuote(symbol);
  if (!quote) return null;

  const volumeRatio = quote.avgVolume3Month > 0 ? quote.volume / quote.avgVolume3Month : 0;
  const unusualVolume = volumeRatio > 2.5;

  const shortRatio = quote.shortRatio || 0;
  const unusualShortInterest = shortRatio > 5; // High short interest can lead to squeezes

  let near52WeekLow = false;
  let near52WeekHigh = false;
  
  if (quote.fiftyTwoWeekHigh && quote.fiftyTwoWeekLow && quote.price) {
    const range = quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow;
    const position = (quote.price - quote.fiftyTwoWeekLow) / range;
    near52WeekLow = position < 0.1;
    near52WeekHigh = position > 0.9;
  }

  // Calculate composite score
  let score = 0;
  if (unusualVolume) score += 0.3;
  if (unusualShortInterest && quote.changePercent > 2) score += 0.4; // Potential squeeze
  if (near52WeekLow && unusualVolume) score += 0.3; // Capitulation + reversal
  if (near52WeekHigh && unusualVolume) score -= 0.3; // Distribution at highs

  if (unusualVolume || unusualShortInterest) {
    logger.signal(`[YAHOO/ACTIVITY] ${symbol}: vol=${volumeRatio.toFixed(1)}x, short=${shortRatio.toFixed(1)}, score=${score.toFixed(2)}`);
  }

  return {
    unusualVolume,
    unusualShortInterest,
    near52WeekLow,
    near52WeekHigh,
    score: Math.max(-1, Math.min(1, score)),
  };
}
