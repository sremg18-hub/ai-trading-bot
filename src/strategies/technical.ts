import { RSI, EMA, BollingerBands, MACD } from 'technicalindicators';
import { BarData } from '../services/market-data';
import { Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';

interface SubSignal {
  name: string;
  score: number; // -1 to 1
  detail: string;
}

function analyzeRSI(closes: number[]): SubSignal {
  const rsiValues = RSI.calculate({ period: 14, values: closes });
  if (rsiValues.length === 0) return { name: 'RSI', score: 0, detail: 'insufficient data' };

  const current = rsiValues[rsiValues.length - 1];

  // AGGRESSIVE: More sensitive RSI thresholds for scalping
  if (current < 30) return { name: 'RSI', score: 1.0, detail: `RSI=${current.toFixed(1)} (strongly oversold)` };
  if (current < 40) return { name: 'RSI', score: 0.6, detail: `RSI=${current.toFixed(1)} (oversold)` };
  if (current < 45) return { name: 'RSI', score: 0.3, detail: `RSI=${current.toFixed(1)} (slightly oversold)` };
  if (current > 70) return { name: 'RSI', score: -1.0, detail: `RSI=${current.toFixed(1)} (strongly overbought)` };
  if (current > 60) return { name: 'RSI', score: -0.6, detail: `RSI=${current.toFixed(1)} (overbought)` };
  if (current > 55) return { name: 'RSI', score: -0.3, detail: `RSI=${current.toFixed(1)} (slightly overbought)` };
  return { name: 'RSI', score: 0, detail: `RSI=${current.toFixed(1)} (neutral)` };
}

function analyzeEMACrossover(closes: number[]): SubSignal {
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });

  if (ema9.length < 2 || ema21.length < 2) return { name: 'EMA', score: 0, detail: 'insufficient data' };

  // Align arrays — ema9 has more values than ema21
  const offset = ema9.length - ema21.length;
  const prev9 = ema9[ema9.length - 2];
  const curr9 = ema9[ema9.length - 1];
  const prev21 = ema21[ema21.length - 2];
  const curr21 = ema21[ema21.length - 1];

  // Bullish crossover: EMA9 crosses above EMA21
  if (prev9 <= prev21 && curr9 > curr21) {
    return { name: 'EMA', score: 1.0, detail: `EMA9(${curr9.toFixed(2)}) crossed above EMA21(${curr21.toFixed(2)})` };
  }
  // Bearish crossover
  if (prev9 >= prev21 && curr9 < curr21) {
    return { name: 'EMA', score: -1.0, detail: `EMA9(${curr9.toFixed(2)}) crossed below EMA21(${curr21.toFixed(2)})` };
  }
  // Bullish trend (EMA9 > EMA21)
  if (curr9 > curr21) {
    return { name: 'EMA', score: 0.3, detail: `EMA9(${curr9.toFixed(2)}) > EMA21(${curr21.toFixed(2)}) — bullish` };
  }
  // Bearish trend
  return { name: 'EMA', score: -0.3, detail: `EMA9(${curr9.toFixed(2)}) < EMA21(${curr21.toFixed(2)}) — bearish` };
}

function analyzeBollinger(closes: number[]): SubSignal {
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  if (bb.length === 0) return { name: 'BB', score: 0, detail: 'insufficient data' };

  const current = bb[bb.length - 1];
  const price = closes[closes.length - 1];

  if (price < current.lower) {
    return { name: 'BB', score: 0.8, detail: `Price(${price.toFixed(2)}) below lower band(${current.lower.toFixed(2)}) — oversold` };
  }
  if (price > current.upper) {
    return { name: 'BB', score: -0.8, detail: `Price(${price.toFixed(2)}) above upper band(${current.upper.toFixed(2)}) — overbought` };
  }
  // Position within bands (normalized -1 to 1)
  const range = current.upper - current.lower;
  if (range === 0) return { name: 'BB', score: 0, detail: 'zero range' };
  const position = ((price - current.lower) / range) * 2 - 1; // -1 at lower, +1 at upper
  return { name: 'BB', score: -position * 0.3, detail: `Price within bands (pb=${current.pb.toFixed(2)})` };
}

function analyzeMACD(closes: number[]): SubSignal {
  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (macdResult.length < 2) return { name: 'MACD', score: 0, detail: 'insufficient data' };

  const prev = macdResult[macdResult.length - 2];
  const curr = macdResult[macdResult.length - 1];

  if (curr.histogram === undefined || prev.histogram === undefined) {
    return { name: 'MACD', score: 0, detail: 'incomplete MACD data' };
  }

  // Bullish crossover (histogram turns positive)
  if (prev.histogram <= 0 && curr.histogram > 0) {
    return { name: 'MACD', score: 1.0, detail: `MACD bullish crossover (histogram=${curr.histogram.toFixed(4)})` };
  }
  // Bearish crossover
  if (prev.histogram >= 0 && curr.histogram < 0) {
    return { name: 'MACD', score: -1.0, detail: `MACD bearish crossover (histogram=${curr.histogram.toFixed(4)})` };
  }
  // Trend continuation
  if (curr.histogram > 0) {
    return { name: 'MACD', score: 0.3, detail: `MACD positive (histogram=${curr.histogram.toFixed(4)})` };
  }
  return { name: 'MACD', score: -0.3, detail: `MACD negative (histogram=${curr.histogram.toFixed(4)})` };
}

function scoreToSignal(score: number): Signal {
  // AGGRESSIVE SCALPING: Lower thresholds for more frequent signals
  if (score >= 0.4) return 'STRONG_BUY';
  if (score >= 0.1) return 'BUY';
  if (score <= -0.4) return 'STRONG_SELL';
  if (score <= -0.1) return 'SELL';
  return 'HOLD';
}

export async function analyzeTechnical(symbol: string, bars: BarData[]): Promise<StrategyResult> {
  try {
    if (bars.length < 30) {
      return {
        strategy: 'technical',
        symbol,
        signal: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient bar data for technical analysis',
        timestamp: new Date(),
      };
    }

    const closes = bars.map(b => b.close);

    const subSignals: SubSignal[] = [
      analyzeRSI(closes),
      analyzeEMACrossover(closes),
      analyzeBollinger(closes),
      analyzeMACD(closes),
    ];

    // AGGRESSIVE: Weighted score with more emphasis on recent signals
    const weights = [1.0, 1.0, 0.8, 0.8]; // RSI, EMA, BB, MACD
    const weightedSum = subSignals.reduce((sum, s, i) => sum + s.score * (weights[i] || 1), 0);
    const avgScore = weightedSum / subSignals.length;

    // AGGRESSIVE: Higher base confidence to encourage more trades
    const agreeing = subSignals.filter(s =>
      (avgScore > 0 && s.score > 0) || (avgScore < 0 && s.score < 0) || (avgScore === 0 && s.score === 0)
    ).length;
    const confidence = Math.min(1.0, (agreeing / subSignals.length) * Math.abs(avgScore) + 0.25);

    const signal = scoreToSignal(avgScore);
    const reasoning = subSignals.map(s => `${s.name}: ${s.detail}`).join(' | ');

    logger.signal(`[TECHNICAL] ${symbol}: ${signal} (confidence: ${confidence.toFixed(2)}) — ${reasoning}`);

    return {
      strategy: 'technical',
      symbol,
      signal,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      timestamp: new Date(),
    };
  } catch (err) {
    logger.error(`Technical analysis failed for ${symbol}: ${err}`);
    return {
      strategy: 'technical',
      symbol,
      signal: 'HOLD',
      confidence: 0,
      reasoning: `Error: ${err}`,
      timestamp: new Date(),
    };
  }
}
