import { RSI, EMA, BollingerBands, MACD } from 'technicalindicators';
import { CryptoBar } from '../services/alpaca';
import { Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';

// Same indicators as stocks but tuned for hourly crypto data
function scoreToSignal(score: number): Signal {
  if (score >= 0.6) return 'STRONG_BUY';
  if (score >= 0.2) return 'BUY';
  if (score <= -0.6) return 'STRONG_SELL';
  if (score <= -0.2) return 'SELL';
  return 'HOLD';
}

export async function analyzeTechnicalCrypto(symbol: string, bars: CryptoBar[]): Promise<StrategyResult> {
  try {
    if (bars.length < 30) {
      return {
        strategy: 'crypto_technical',
        symbol,
        signal: 'HOLD',
        confidence: 0,
        reasoning: 'Insufficient crypto bar data for technical analysis',
        timestamp: new Date(),
      };
    }

    const closes = bars.map(b => b.Close);

    // RSI(14)
    const rsiValues = RSI.calculate({ period: 14, values: closes });
    let rsiScore = 0;
    let rsiDetail = 'no data';
    if (rsiValues.length > 0) {
      const rsi = rsiValues[rsiValues.length - 1];
      if (rsi < 25) { rsiScore = 1.0; rsiDetail = `RSI=${rsi.toFixed(1)} (strongly oversold)`; }
      else if (rsi < 30) { rsiScore = 0.5; rsiDetail = `RSI=${rsi.toFixed(1)} (oversold)`; }
      else if (rsi > 75) { rsiScore = -1.0; rsiDetail = `RSI=${rsi.toFixed(1)} (strongly overbought)`; }
      else if (rsi > 70) { rsiScore = -0.5; rsiDetail = `RSI=${rsi.toFixed(1)} (overbought)`; }
      else { rsiScore = 0; rsiDetail = `RSI=${rsi.toFixed(1)} (neutral)`; }
    }

    // EMA(12/26) for crypto — faster than stocks
    const ema12 = EMA.calculate({ period: 12, values: closes });
    const ema26 = EMA.calculate({ period: 26, values: closes });
    let emaScore = 0;
    let emaDetail = 'no data';
    if (ema12.length >= 2 && ema26.length >= 2) {
      const curr12 = ema12[ema12.length - 1];
      const curr26 = ema26[ema26.length - 1];
      const prev12 = ema12[ema12.length - 2];
      const prev26 = ema26[ema26.length - 2];
      if (prev12 <= prev26 && curr12 > curr26) { emaScore = 1.0; emaDetail = `EMA12 crossed above EMA26 (bullish)`; }
      else if (prev12 >= prev26 && curr12 < curr26) { emaScore = -1.0; emaDetail = `EMA12 crossed below EMA26 (bearish)`; }
      else if (curr12 > curr26) { emaScore = 0.3; emaDetail = `EMA12 > EMA26 (bullish trend)`; }
      else { emaScore = -0.3; emaDetail = `EMA12 < EMA26 (bearish trend)`; }
    }

    // Bollinger Bands(20, 2)
    const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    let bbScore = 0;
    let bbDetail = 'no data';
    if (bb.length > 0) {
      const current = bb[bb.length - 1];
      const price = closes[closes.length - 1];
      if (price < current.lower) { bbScore = 0.8; bbDetail = `Below lower band (oversold)`; }
      else if (price > current.upper) { bbScore = -0.8; bbDetail = `Above upper band (overbought)`; }
      else {
        const range = current.upper - current.lower;
        const pos = range > 0 ? ((price - current.lower) / range) * 2 - 1 : 0;
        bbScore = -pos * 0.3;
        bbDetail = `Within bands (pb=${current.pb.toFixed(2)})`;
      }
    }

    // MACD
    const macdResult = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });
    let macdScore = 0;
    let macdDetail = 'no data';
    if (macdResult.length >= 2) {
      const prev = macdResult[macdResult.length - 2];
      const curr = macdResult[macdResult.length - 1];
      if (curr.histogram !== undefined && prev.histogram !== undefined) {
        if (prev.histogram <= 0 && curr.histogram > 0) { macdScore = 1.0; macdDetail = `Bullish crossover`; }
        else if (prev.histogram >= 0 && curr.histogram < 0) { macdScore = -1.0; macdDetail = `Bearish crossover`; }
        else if (curr.histogram > 0) { macdScore = 0.3; macdDetail = `Positive (${curr.histogram.toFixed(2)})`; }
        else { macdScore = -0.3; macdDetail = `Negative (${curr.histogram.toFixed(2)})`; }
      }
    }

    const scores = [rsiScore, emaScore, bbScore, macdScore];
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const agreeing = scores.filter(s => (avgScore > 0 && s > 0) || (avgScore < 0 && s < 0)).length;
    const confidence = Math.min(1.0, (agreeing / scores.length) * Math.abs(avgScore) + 0.1);

    const signal = scoreToSignal(avgScore);
    const reasoning = `RSI: ${rsiDetail} | EMA: ${emaDetail} | BB: ${bbDetail} | MACD: ${macdDetail}`;

    logger.signal(`[CRYPTO/TECH] ${symbol}: ${signal} (confidence: ${confidence.toFixed(2)})`);

    return {
      strategy: 'crypto_technical',
      symbol,
      signal,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      timestamp: new Date(),
    };
  } catch (err) {
    logger.error(`Crypto technical analysis failed for ${symbol}: ${err}`);
    return {
      strategy: 'crypto_technical',
      symbol,
      signal: 'HOLD',
      confidence: 0,
      reasoning: `Error: ${err}`,
      timestamp: new Date(),
    };
  }
}
