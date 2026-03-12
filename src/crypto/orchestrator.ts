import { loadConfig } from '../config';
import { getCryptoBars, getLatestCryptoQuote, getPositions, getAccount } from '../services/alpaca';
import { analyzeTechnicalCrypto } from './technical';
import { analyzeCryptoSentiment } from './sentiment';
import { analyzeMomentum } from './momentum';
import { OrchestratorDecision, StrategyResult, PositionInfo, signalToScore } from '../types';
import { logger } from '../utils/logger';

export async function makeCryptoDecision(
  symbol: string,
  cachedPositions?: PositionInfo[],
): Promise<OrchestratorDecision> {
  const config = loadConfig();

  // Get hourly bars for crypto + current quote
  const [bars, quote, positions] = await Promise.all([
    getCryptoBars(symbol, '1Hour', 100),
    getLatestCryptoQuote(symbol),
    cachedPositions ? Promise.resolve(cachedPositions) : getPositions(),
  ]);

  // Run all 3 crypto strategies in parallel
  const account = await getAccount(); // needed for copy strategy (equity)
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

  // Lower thresholds for medium-frequency trading
  let action: 'BUY' | 'SELL' | 'HOLD';
  if (weightedScore > 0.04) {
    action = 'BUY';
  } else if (weightedScore < -0.04) {
    action = 'SELL';
  } else {
    action = 'HOLD';
  }

  const confidence = Math.min(1.0, Math.abs(weightedScore));

  // Normalize: config uses BTC/USD, Alpaca broker uses BTCUSD
  const normalizedSymbol = symbol.replace('/', '');

  // Skip symbols with no usable market data
  const currentPriceNum = quote ? quote.mid : 0;
  if (bars.length === 0 && !quote) {
    return {
      symbol, action: 'HOLD', quantity: 0, price: 0, confidence: 0,
      strategies, reasoning: 'No market data available',
      timestamp: new Date(),
    };
  }

  // Calculate quantity — crypto can be fractional
  let quantity = 0;
  if (action === 'BUY' && currentPriceNum > 0) {
    const maxValue = config.cryptoMaxPositionSize * confidence;
    quantity = Math.round((maxValue / currentPriceNum) * 10000) / 10000; // 4 decimal places
    if (quantity * currentPriceNum < 1) quantity = 0; // min $1 order
  } else if (action === 'BUY') {
    action = 'HOLD'; // No valid price
  } else if (action === 'SELL') {
    // Match by both BTC/USD and BTCUSD formats
    const position = positions.find(p => p.symbol === normalizedSymbol || p.symbol === symbol);
    if (position && position.qty > 0) {
      quantity = position.qty; // Always sell full position
    }
  }

  const currentPrice = currentPriceNum > 0 ? currentPriceNum.toFixed(2) : '?';
  const reasoning = strategies
    .map(s => `${s.strategy}: ${s.signal}(${s.confidence.toFixed(2)})`)
    .join(' + ') + ` → score=${weightedScore.toFixed(3)} @$${currentPrice}`;

  logger.info(`[CRYPTO] ${symbol}: ${action} x${quantity} (score: ${weightedScore.toFixed(3)}) — ${reasoning}`);

  return {
    symbol,
    action,
    quantity,
    price: currentPriceNum,
    confidence,
    strategies,
    reasoning,
    timestamp: new Date(),
  };
}
