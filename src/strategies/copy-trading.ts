import { PositionInfo, Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';

// Model portfolio — simulates following a whale/model allocator
const MODEL_PORTFOLIO: Record<string, number> = {
  'AAPL': 0.20,
  'MSFT': 0.20,
  'GOOGL': 0.15,
  'AMZN': 0.15,
  'NVDA': 0.15,
  'TSLA': 0.10,
  'META': 0.05,
};

export async function analyzeCopySignal(
  symbol: string,
  currentPositions: PositionInfo[],
  totalEquity: number,
): Promise<StrategyResult> {
  try {
    const targetWeight = MODEL_PORTFOLIO[symbol] || 0;

    if (targetWeight === 0) {
      // Symbol not in model portfolio — check if we hold it (should sell)
      const position = currentPositions.find(p => p.symbol === symbol);
      if (position && position.marketValue > 0) {
        return {
          strategy: 'copy',
          symbol,
          signal: 'SELL',
          confidence: 0.6,
          reasoning: `${symbol} not in model portfolio but we hold $${position.marketValue.toFixed(0)}`,
          timestamp: new Date(),
        };
      }
      return {
        strategy: 'copy',
        symbol,
        signal: 'HOLD',
        confidence: 0,
        reasoning: `${symbol} not in model portfolio`,
        timestamp: new Date(),
      };
    }

    const position = currentPositions.find(p => p.symbol === symbol);
    const currentValue = position ? position.marketValue : 0;
    const currentWeight = totalEquity > 0 ? currentValue / totalEquity : 0;

    const deviation = targetWeight - currentWeight;
    const deviationPercent = Math.abs(deviation) / targetWeight;

    let signal: Signal;
    let confidence: number;
    let reasoning: string;

    if (deviation > 0.03) {
      // Underweight by more than 3% — BUY
      signal = deviationPercent > 0.5 ? 'STRONG_BUY' : 'BUY';
      confidence = Math.min(1.0, deviationPercent);
      reasoning = `Underweight: current ${(currentWeight * 100).toFixed(1)}% vs target ${(targetWeight * 100).toFixed(1)}% (deviation: ${(deviation * 100).toFixed(1)}%)`;
    } else if (deviation < -0.03) {
      // Overweight by more than 3% — SELL
      signal = deviationPercent > 0.5 ? 'STRONG_SELL' : 'SELL';
      confidence = Math.min(1.0, deviationPercent);
      reasoning = `Overweight: current ${(currentWeight * 100).toFixed(1)}% vs target ${(targetWeight * 100).toFixed(1)}% (deviation: ${(deviation * 100).toFixed(1)}%)`;
    } else {
      signal = 'HOLD';
      confidence = 0.3;
      reasoning = `Near target: current ${(currentWeight * 100).toFixed(1)}% vs target ${(targetWeight * 100).toFixed(1)}%`;
    }

    logger.signal(`[COPY] ${symbol}: ${signal} (confidence: ${confidence.toFixed(2)}) — ${reasoning}`);

    return {
      strategy: 'copy',
      symbol,
      signal,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
      timestamp: new Date(),
    };
  } catch (err) {
    logger.error(`Copy trading analysis failed for ${symbol}: ${err}`);
    return {
      strategy: 'copy',
      symbol,
      signal: 'HOLD',
      confidence: 0,
      reasoning: `Error: ${err}`,
      timestamp: new Date(),
    };
  }
}
