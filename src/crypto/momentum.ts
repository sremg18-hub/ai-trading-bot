import { CryptoBar } from '../services/alpaca';
import { Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';

// Volume-Weighted Momentum strategy for crypto
// Analyzes: volume spikes, VWAP deviation, trade count momentum

interface MomentumSignal {
  name: string;
  score: number;
  detail: string;
}

function analyzeVolumeMomentum(bars: CryptoBar[]): MomentumSignal {
  if (bars.length < 20) return { name: 'VOL', score: 0, detail: 'insufficient data' };

  const volumes = bars.map(b => b.Volume);
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;

  if (avgVol === 0) return { name: 'VOL', score: 0, detail: 'zero volume' };

  const ratio = recentVol / avgVol;
  // Price direction during volume spike
  const recentClose = bars[bars.length - 1].Close;
  const prevClose = bars[bars.length - 6].Close;
  const priceUp = recentClose > prevClose;

  if (ratio > 2.0) {
    const score = priceUp ? 0.8 : -0.8;
    return { name: 'VOL', score, detail: `Volume spike ${ratio.toFixed(1)}x avg (price ${priceUp ? 'up' : 'down'})` };
  }
  if (ratio > 1.5) {
    const score = priceUp ? 0.4 : -0.4;
    return { name: 'VOL', score, detail: `Elevated volume ${ratio.toFixed(1)}x avg` };
  }
  if (ratio < 0.5) {
    return { name: 'VOL', score: 0, detail: `Low volume ${ratio.toFixed(1)}x avg — no conviction` };
  }
  return { name: 'VOL', score: 0, detail: `Normal volume ${ratio.toFixed(1)}x avg` };
}

function analyzeVWAPDeviation(bars: CryptoBar[]): MomentumSignal {
  if (bars.length < 5) return { name: 'VWAP', score: 0, detail: 'insufficient data' };

  const latest = bars[bars.length - 1];
  if (!latest.VWAP || latest.VWAP === 0) return { name: 'VWAP', score: 0, detail: 'no VWAP data' };

  const deviation = ((latest.Close - latest.VWAP) / latest.VWAP) * 100;

  // Price significantly below VWAP = potential buy (discount)
  // Price significantly above VWAP = potential overbought
  if (deviation < -2) {
    return { name: 'VWAP', score: 0.7, detail: `Price ${deviation.toFixed(1)}% below VWAP — potential buy` };
  }
  if (deviation < -1) {
    return { name: 'VWAP', score: 0.3, detail: `Price ${deviation.toFixed(1)}% below VWAP` };
  }
  if (deviation > 2) {
    return { name: 'VWAP', score: -0.7, detail: `Price +${deviation.toFixed(1)}% above VWAP — overbought` };
  }
  if (deviation > 1) {
    return { name: 'VWAP', score: -0.3, detail: `Price +${deviation.toFixed(1)}% above VWAP` };
  }
  return { name: 'VWAP', score: 0, detail: `Price near VWAP (${deviation.toFixed(1)}%)` };
}

function analyzePriceMomentum(bars: CryptoBar[]): MomentumSignal {
  if (bars.length < 20) return { name: 'MOM', score: 0, detail: 'insufficient data' };

  const closes = bars.map(b => b.Close);

  // Rate of change (ROC) over last 10 and 20 periods
  const roc10 = ((closes[closes.length - 1] - closes[closes.length - 11]) / closes[closes.length - 11]) * 100;
  const roc20 = ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;

  // Acceleration: ROC10 vs ROC20 direction
  const accelerating = Math.abs(roc10) > Math.abs(roc20) && Math.sign(roc10) === Math.sign(roc20);

  let score = 0;
  if (roc10 > 5) score = 0.8;
  else if (roc10 > 2) score = 0.4;
  else if (roc10 < -5) score = -0.8;
  else if (roc10 < -2) score = -0.4;

  if (accelerating) score *= 1.2;
  score = Math.max(-1, Math.min(1, score));

  return {
    name: 'MOM',
    score,
    detail: `ROC10=${roc10.toFixed(1)}% ROC20=${roc20.toFixed(1)}%${accelerating ? ' (accelerating)' : ''}`,
  };
}

function analyzeTradeActivity(bars: CryptoBar[]): MomentumSignal {
  if (bars.length < 10) return { name: 'TRADES', score: 0, detail: 'insufficient data' };

  const counts = bars.map(b => b.TradeCount);
  const recent = counts.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const avg = counts.slice(-10).reduce((a, b) => a + b, 0) / 10;

  if (avg === 0) return { name: 'TRADES', score: 0, detail: 'no trade count data' };

  const ratio = recent / avg;
  const priceUp = bars[bars.length - 1].Close > bars[bars.length - 4].Close;

  if (ratio > 2.0) {
    return { name: 'TRADES', score: priceUp ? 0.5 : -0.5, detail: `Trade activity ${ratio.toFixed(1)}x normal` };
  }
  return { name: 'TRADES', score: 0, detail: `Trade activity ${ratio.toFixed(1)}x normal` };
}

function scoreToSignal(score: number): Signal {
  if (score >= 0.6) return 'STRONG_BUY';
  if (score >= 0.2) return 'BUY';
  if (score <= -0.6) return 'STRONG_SELL';
  if (score <= -0.2) return 'SELL';
  return 'HOLD';
}

export async function analyzeMomentum(symbol: string, bars: CryptoBar[]): Promise<StrategyResult> {
  try {
    if (bars.length < 25) {
      return {
        strategy: 'crypto_momentum',
        symbol,
        signal: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient crypto bar data',
        timestamp: new Date(),
      };
    }

    const subSignals: MomentumSignal[] = [
      analyzeVolumeMomentum(bars),
      analyzeVWAPDeviation(bars),
      analyzePriceMomentum(bars),
      analyzeTradeActivity(bars),
    ];

    const avgScore = subSignals.reduce((sum, s) => sum + s.score, 0) / subSignals.length;
    const agreeing = subSignals.filter(s =>
      (avgScore > 0 && s.score > 0) || (avgScore < 0 && s.score < 0)
    ).length;
    const confidence = Math.min(1.0, (agreeing / subSignals.length) * Math.abs(avgScore) + 0.1);

    const signal = scoreToSignal(avgScore);
    const reasoning = subSignals.map(s => `${s.name}: ${s.detail}`).join(' | ');

    logger.signal(`[CRYPTO/MOMENTUM] ${symbol}: ${signal} (confidence: ${confidence.toFixed(2)}) — ${reasoning}`);

    return {
      strategy: 'crypto_momentum',
      symbol,
      signal,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      timestamp: new Date(),
    };
  } catch (err) {
    logger.error(`Crypto momentum analysis failed for ${symbol}: ${err}`);
    return {
      strategy: 'crypto_momentum',
      symbol,
      signal: 'HOLD',
      confidence: 0,
      reasoning: `Error: ${err}`,
      timestamp: new Date(),
    };
  }
}
