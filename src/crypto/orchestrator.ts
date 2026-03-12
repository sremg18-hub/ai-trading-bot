import { loadConfig } from '../config';
import { getCryptoBars, getLatestCryptoQuote, getPositions, getAccount } from '../services/alpaca';
import { analyzeTechnicalCrypto } from './technical';
import { analyzeCryptoSentiment } from './sentiment';
import { analyzeMomentum } from './momentum';
import { OrchestratorDecision, StrategyResult, signalToScore } from '../types';
import { logger } from '../utils/logger';

export async function makeCryptoDecision(symbol: string): Promise<OrchestratorDecision> {
  const config = loadConfig();

  // Get hourly bars for crypto (more granular than daily)
  const [bars, quote, positions, account] = await Promise.all([
    getCryptoBars(symbol, '1Hour', 100),
    getLatestCryptoQuote(symbol),
    getPositions(),
    getAccount(),
  ]);

  // Run all 3 crypto strategies in parallel
  const [technical, sentiment, momentum] = await Promise.all([
    analyzeTechnicalCrypto(symbol, bars),
    analyzeCryptoSentiment(symbol),
    analyzeMomentum(symbol, bars),
  ]);

  const strategies: StrategyResult[] = [technical, sentiment, momentum];

  // Weighted scoring
  const weightedScore =
    signalToScore(technical.signal) * config.cryptoWeightTechnical * technical.confidence +
    signalToScore(sentiment.signal) * config.cryptoWeightAiNews * sentiment.confidence +
    signalToScore(momentum.signal) * config.cryptoWeightMomentum * momentum.confidence;

  let action: 'BUY' | 'SELL' | 'HOLD';
  if (weightedScore > 0.08) {
    action = 'BUY';
  } else if (weightedScore < -0.08) {
    action = 'SELL';
  } else {
    action = 'HOLD';
  }

  const confidence = Math.min(1.0, Math.abs(weightedScore));

  // Calculate quantity — crypto can be fractional
  let quantity = 0;
  if (action === 'BUY' && quote) {
    const maxValue = config.cryptoMaxPositionSize * confidence;
    quantity = Math.round((maxValue / quote.mid) * 10000) / 10000; // 4 decimal places
    if (quantity * quote.mid < 1) quantity = 0; // min $1 order
  } else if (action === 'SELL') {
    const position = positions.find(p => p.symbol === symbol);
    if (position) {
      quantity = Math.round(position.qty * confidence * 10000) / 10000;
    }
  }

  const currentPrice = quote ? quote.mid.toFixed(2) : '?';
  const reasoning = strategies
    .map(s => `${s.strategy}: ${s.signal}(${s.confidence.toFixed(2)})`)
    .join(' + ') + ` → score=${weightedScore.toFixed(3)} @$${currentPrice}`;

  logger.info(`[CRYPTO] ${symbol}: ${action} x${quantity} (score: ${weightedScore.toFixed(3)}) — ${reasoning}`);

  return {
    symbol,
    action,
    quantity,
    confidence,
    strategies,
    reasoning,
    timestamp: new Date(),
  };
}
