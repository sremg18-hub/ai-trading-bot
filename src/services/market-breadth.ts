/**
 * Market Breadth & Correlation Analysis
 * Free alternative data for better decisions
 * Tracks sector rotation, market internals, correlations
 */

import { logger } from '../utils/logger';
import { getHistoricalBars } from './market-data';
import { getYahooIntraday } from './yahoo-finance';

// Market internals cache
const internalsCache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

export interface MarketInternals {
  timestamp: Date;
  spyTrend: 'bullish' | 'bearish' | 'neutral';
  qqqTrend: 'bullish' | 'bearish' | 'neutral';
  vixLevel: 'low' | 'normal' | 'high' | 'extreme';
  riskOnRiskOff: 'risk-on' | 'risk-off' | 'neutral';
  sectorRotation: string[]; // Leading sectors
}

export interface CorrelationMatrix {
  symbol: string;
  correlations: Record<string, number>; // -1 to 1
  betaToSPY: number;
  sectorMomentum: 'leading' | 'lagging' | 'neutral';
}

/**
 * Calculate correlation between two price series
 * Pearson correlation coefficient
 */
function calculateCorrelation(pricesA: number[], pricesB: number[]): number {
  if (pricesA.length !== pricesB.length || pricesA.length < 10) return 0;

  const n = pricesA.length;
  const sumA = pricesA.reduce((a, b) => a + b, 0);
  const sumB = pricesB.reduce((a, b) => a + b, 0);
  const sumAA = pricesA.reduce((a, b) => a + b * b, 0);
  const sumBB = pricesB.reduce((a, b) => a + b * b, 0);
  const sumAB = pricesA.reduce((sum, a, i) => sum + a * pricesB[i], 0);

  const numerator = n * sumAB - sumA * sumB;
  const denominator = Math.sqrt((n * sumAA - sumA * sumA) * (n * sumBB - sumB * sumB));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Get market trend from SPY/QQQ
 */
export async function getMarketTrend(): Promise<MarketInternals | null> {
  const cacheKey = 'market_trend';
  const cached = internalsCache.get(cacheKey);
  if (cached && Date.now() < (cached.expiresAt as number)) {
    return cached.data as MarketInternals;
  }

  try {
    // Get SPY, QQQ, VIX bars
    const [spyBars, qqqBars] = await Promise.all([
      getHistoricalBars('SPY', 20),
      getHistoricalBars('QQQ', 20),
    ]);

    if (spyBars.length < 10 || qqqBars.length < 10) return null;

    const spyCloses = spyBars.map(b => b.close);
    const qqqCloses = qqqBars.map(b => b.close);

    // Calculate 5-day vs 20-day moving averages for trend
    const spy5 = spyCloses.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const spy20 = spyCloses.reduce((a, b) => a + b, 0) / spyCloses.length;
    const spyTrend = spy5 > spy20 * 1.01 ? 'bullish' : spy5 < spy20 * 0.99 ? 'bearish' : 'neutral';

    const qqq5 = qqqCloses.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const qqq20 = qqqCloses.reduce((a, b) => a + b, 0) / qqqCloses.length;
    const qqqTrend = qqq5 > qqq20 * 1.01 ? 'bullish' : qqq5 < qqq20 * 0.99 ? 'bearish' : 'neutral';

    // Risk on/off based on QQQ vs SPY performance
    const spyChange = (spyCloses[spyCloses.length - 1] - spyCloses[0]) / spyCloses[0];
    const qqqChange = (qqqCloses[qqqCloses.length - 1] - qqqCloses[0]) / qqqCloses[0];
    
    let riskOnRiskOff: 'risk-on' | 'risk-off' | 'neutral' = 'neutral';
    if (qqqChange > spyChange + 0.02) riskOnRiskOff = 'risk-on';
    else if (qqqChange < spyChange - 0.02) riskOnRiskOff = 'risk-off';

    const result: MarketInternals = {
      timestamp: new Date(),
      spyTrend,
      qqqTrend,
      vixLevel: 'normal', // Would need VIX data
      riskOnRiskOff,
      sectorRotation: [],
    };

    internalsCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.warn(`[BREADTH] Market trend error: ${err}`);
    return null;
  }
}

/**
 * Calculate correlation of a symbol with major indices
 */
export async function getCorrelationAnalysis(symbol: string): Promise<CorrelationMatrix | null> {
  if (symbol === 'SPY' || symbol === 'QQQ') return null;

  try {
    const [symbolBars, spyBars] = await Promise.all([
      getHistoricalBars(symbol, 20),
      getHistoricalBars('SPY', 20),
    ]);

    if (symbolBars.length < 15 || spyBars.length < 15) return null;

    const symbolCloses = symbolBars.map(b => b.close);
    const spyCloses = spyBars.map(b => b.close);

    const correlation = calculateCorrelation(symbolCloses, spyCloses);

    // Calculate beta (sensitivity to market)
    const symbolReturns = symbolCloses.slice(1).map((p, i) => (p - symbolCloses[i]) / symbolCloses[i]);
    const spyReturns = spyCloses.slice(1).map((p, i) => (p - spyCloses[i]) / spyCloses[i]);

    const covariance = calculateCorrelation(symbolReturns, spyReturns);
    const spyVariance = spyReturns.reduce((sum, r) => sum + r * r, 0) / spyReturns.length;
    const beta = spyVariance > 0 ? covariance / spyVariance : 1;

    // Determine if leading or lagging
    const symbol5Day = (symbolCloses[symbolCloses.length - 1] - symbolCloses[symbolCloses.length - 5]) / symbolCloses[symbolCloses.length - 5];
    const spy5Day = (spyCloses[spyCloses.length - 1] - spyCloses[spyCloses.length - 5]) / spyCloses[spyCloses.length - 5];

    let sectorMomentum: 'leading' | 'lagging' | 'neutral' = 'neutral';
    if (symbol5Day > spy5Day + 0.02) sectorMomentum = 'leading';
    else if (symbol5Day < spy5Day - 0.02) sectorMomentum = 'lagging';

    if (Math.abs(correlation) > 0.7) {
      logger.info(`[BREADTH] ${symbol}: correlation=${correlation.toFixed(2)}, beta=${beta.toFixed(2)}, ${sectorMomentum}`);
    }

    return {
      symbol,
      correlations: { SPY: correlation },
      betaToSPY: beta,
      sectorMomentum,
    };
  } catch (err) {
    logger.warn(`[BREADTH] Correlation error for ${symbol}: ${err}`);
    return null;
  }
}

/**
 * Detect if stock is breaking out relative to market
 */
export async function detectRelativeBreakout(symbol: string): Promise<{
  isBreakout: boolean;
  direction: 'up' | 'down';
  strength: number; // 0-1
  relativePerformance: number; // vs SPY
} | null> {
  try {
    const [symbolBars, spyBars] = await Promise.all([
      getHistoricalBars(symbol, 30),
      getHistoricalBars('SPY', 30),
    ]);

    if (symbolBars.length < 20 || spyBars.length < 20) return null;

    const symbolCloses = symbolBars.map(b => b.close);
    const spyCloses = spyBars.map(b => b.close);

    // Calculate relative strength
    const symbolChange = (symbolCloses[symbolCloses.length - 1] - symbolCloses[0]) / symbolCloses[0];
    const spyChange = (spyCloses[spyCloses.length - 1] - spyCloses[0]) / spyCloses[0];
    const relativePerformance = symbolChange - spyChange;

    // Check for recent breakout (last 3 days)
    const symbolRecent = symbolCloses.slice(-3);
    const symbolAvg20 = symbolCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const symbolHigh20 = Math.max(...symbolCloses.slice(-20));
    const symbolLow20 = Math.min(...symbolCloses.slice(-20));

    const currentPrice = symbolRecent[symbolRecent.length - 1];
    const range = symbolHigh20 - symbolLow20;
    
    let isBreakout = false;
    let direction: 'up' | 'down' = 'up';
    let strength = 0;

    if (range > 0) {
      const position = (currentPrice - symbolLow20) / range;
      
      // Breakout above 20-day high
      if (currentPrice > symbolHigh20 * 0.995 && relativePerformance > 0.01) {
        isBreakout = true;
        direction = 'up';
        strength = position;
      }
      // Breakdown below 20-day low
      else if (currentPrice < symbolLow20 * 1.005 && relativePerformance < -0.01) {
        isBreakout = true;
        direction = 'down';
        strength = 1 - position;
      }
    }

    if (isBreakout) {
      logger.signal(`[BREADTH/BREAKOUT] ${symbol}: ${direction.toUpperCase()} breakout, vs SPY: ${(relativePerformance * 100).toFixed(1)}%`);
    }

    return { isBreakout, direction, strength, relativePerformance };
  } catch (err) {
    return null;
  }
}

/**
 * Get market breadth score (-1 to 1)
 * Combines multiple factors
 */
export async function getMarketBreadthScore(): Promise<number> {
  const trend = await getMarketTrend();
  if (!trend) return 0;

  let score = 0;

  if (trend.spyTrend === 'bullish') score += 0.3;
  else if (trend.spyTrend === 'bearish') score -= 0.3;

  if (trend.qqqTrend === 'bullish') score += 0.3;
  else if (trend.qqqTrend === 'bearish') score -= 0.3;

  if (trend.riskOnRiskOff === 'risk-on') score += 0.2;
  else if (trend.riskOnRiskOff === 'risk-off') score -= 0.2;

  return Math.max(-1, Math.min(1, score));
}
