/**
 * Alternative Data Strategy
 * Combines free data sources: Yahoo Finance, RSS News, Market Breadth
 * No AI APIs required - pure data-driven signals
 */

import { Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';
import {
  detectVolumeSpike,
  getAnalystSentiment,
  detectUnusualActivity,
  getYahooQuote,
} from '../services/yahoo-finance';
import { getRSSSentiment, checkCriticalNews } from '../services/rss-news';
import {
  detectRelativeBreakout,
  getCorrelationAnalysis,
  getMarketBreadthScore,
} from '../services/market-breadth';

interface SubSignal {
  source: string;
  score: number; // -1 to 1
  confidence: number;
  detail: string;
}

/**
 * Main alternative data analysis
 * Combines all free data sources into trading signal
 */
export async function analyzeAlternativeData(symbol: string): Promise<StrategyResult> {
  const subSignals: SubSignal[] = [];

  try {
    // 1. Check for critical news first (immediate action required)
    const criticalNews = await checkCriticalNews(symbol);
    if (criticalNews?.isCritical) {
      const signal: Signal = criticalNews.action === 'sell' ? 'STRONG_SELL' : 'HOLD';
      logger.warn(`[ALT/CRITICAL] ${symbol}: ${criticalNews.reason}`);
      return {
        strategy: 'alternative_data',
        symbol,
        signal,
        confidence: 0.9,
        reasoning: `Critical news: ${criticalNews.reason}`,
        timestamp: new Date(),
      };
    }

    // 2. Volume spike analysis
    const volumeData = await detectVolumeSpike(symbol);
    if (volumeData?.isSpike) {
      const volumeScore = volumeData.direction === 'up' ? 0.6 : volumeData.direction === 'down' ? -0.6 : 0;
      subSignals.push({
        source: 'volume_spike',
        score: volumeScore,
        confidence: Math.min(1, volumeData.spikeRatio / 3),
        detail: `${volumeData.spikeRatio.toFixed(1)}x volume, ${volumeData.direction} trend`,
      });
    }

    // 3. RSS News sentiment (free alternative to AI)
    const rssSentiment = await getRSSSentiment(symbol);
    if (rssSentiment) {
      subSignals.push({
        source: 'rss_sentiment',
        score: rssSentiment.score,
        confidence: rssSentiment.confidence,
        detail: `${rssSentiment.sentiment} (${rssSentiment.count} articles)`,
      });
    }

    // 4. Analyst ratings from Yahoo
    const analystData = await getAnalystSentiment(symbol);
    if (analystData) {
      let analystScore = analystData.score;
      // Boost score if target price suggests big upside
      if (analystData.targetUpside > 0.2) analystScore += 0.2;
      else if (analystData.targetUpside < -0.2) analystScore -= 0.2;

      subSignals.push({
        source: 'analyst_ratings',
        score: Math.max(-1, Math.min(1, analystScore)),
        confidence: 0.7,
        detail: `Consensus: ${analystData.consensus}, target upside: ${(analystData.targetUpside * 100).toFixed(1)}%`,
      });
    }

    // 5. Unusual activity detection
    const unusual = await detectUnusualActivity(symbol);
    if (unusual) {
      subSignals.push({
        source: 'unusual_activity',
        score: unusual.score,
        confidence: (unusual.unusualVolume ? 0.5 : 0) + (unusual.unusualShortInterest ? 0.3 : 0),
        detail: `vol_spike=${unusual.unusualVolume}, short_int=${unusual.unusualShortInterest}`,
      });
    }

    // 6. Relative breakout detection
    const breakout = await detectRelativeBreakout(symbol);
    if (breakout?.isBreakout) {
      const breakoutScore = breakout.direction === 'up' ? 0.8 : -0.8;
      subSignals.push({
        source: 'breakout',
        score: breakoutScore,
        confidence: breakout.strength,
        detail: `${breakout.direction} breakout, vs SPY: ${(breakout.relativePerformance * 100).toFixed(1)}%`,
      });
    }

    // 7. Market correlation context
    const correlation = await getCorrelationAnalysis(symbol);
    if (correlation) {
      // If leading the market, boost signal
      if (correlation.sectorMomentum === 'leading') {
        subSignals.push({
          source: 'market_leadership',
          score: 0.3,
          confidence: 0.6,
          detail: 'Leading market (beta: ' + correlation.betaToSPY.toFixed(2) + ')',
        });
      }
      // If high beta and market is bullish, boost
      if (correlation.betaToSPY > 1.2) {
        const marketScore = await getMarketBreadthScore();
        if (marketScore > 0.2) {
          subSignals.push({
            source: 'high_beta_bull',
            score: 0.2,
            confidence: 0.5,
            detail: 'High beta in bull market',
          });
        }
      }
    }

    // Combine all signals
    if (subSignals.length === 0) {
      return {
        strategy: 'alternative_data',
        symbol,
        signal: 'HOLD',
        confidence: 0,
        reasoning: 'No alternative data signals available',
        timestamp: new Date(),
      };
    }

    // Weighted average of signals
    const totalWeight = subSignals.reduce((sum, s) => sum + s.confidence, 0);
    const weightedScore = subSignals.reduce((sum, s) => sum + s.score * s.confidence, 0) / totalWeight;
    const avgConfidence = totalWeight / subSignals.length;

    // Determine final signal
    let signal: Signal = 'HOLD';
    if (weightedScore > 0.5) signal = 'STRONG_BUY';
    else if (weightedScore > 0.15) signal = 'BUY';
    else if (weightedScore < -0.5) signal = 'STRONG_SELL';
    else if (weightedScore < -0.15) signal = 'SELL';

    const reasoning = subSignals.map(s => `${s.source}: ${s.detail}`).join(' | ');

    logger.signal(`[ALT/DATA] ${symbol}: ${signal} (score: ${weightedScore.toFixed(2)}, conf: ${avgConfidence.toFixed(2)})`);

    return {
      strategy: 'alternative_data',
      symbol,
      signal,
      confidence: Math.round(avgConfidence * 100) / 100,
      reasoning,
      timestamp: new Date(),
    };
  } catch (err) {
    logger.error(`[ALT/DATA] Error analyzing ${symbol}: ${err}`);
    return {
      strategy: 'alternative_data',
      symbol,
      signal: 'HOLD',
      confidence: 0,
      reasoning: `Error: ${err}`,
      timestamp: new Date(),
    };
  }
}

/**
 * Quick signal for high-frequency trading
 * Uses only fastest data sources (cache-friendly)
 */
export async function getQuickAlternativeSignal(symbol: string): Promise<{ signal: Signal; score: number } | null> {
  try {
    const [volume, rss] = await Promise.all([
      detectVolumeSpike(symbol),
      getRSSSentiment(symbol),
    ]);

    let score = 0;
    let count = 0;

    if (volume?.isSpike) {
      score += volume.direction === 'up' ? 0.5 : -0.5;
      count++;
    }

    if (rss && Math.abs(rss.score) > 0.2) {
      score += rss.score;
      count++;
    }

    if (count === 0) return null;

    score = score / count;
    
    let signal: Signal = 'HOLD';
    if (score > 0.4) signal = 'STRONG_BUY';
    else if (score > 0.15) signal = 'BUY';
    else if (score < -0.4) signal = 'STRONG_SELL';
    else if (score < -0.15) signal = 'SELL';

    return { signal, score };
  } catch {
    return null;
  }
}
