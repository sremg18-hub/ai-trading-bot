import { loadConfig } from '../config';
import { getCryptoBars, getLatestCryptoQuote, getPositions, getAccount } from '../services/alpaca';
import { analyzeTechnicalCrypto } from './technical';
import { analyzeCryptoSentiment } from './sentiment';
import { analyzeMomentum } from './momentum';
import { getRSSSentiment } from '../services/rss-news';
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

  // Run all crypto strategies in parallel + FREE RSS sentiment
  const account = await getAccount();
  const [technical, sentiment, momentum, rssNews] = await Promise.all([
    analyzeTechnicalCrypto(symbol, bars),
    analyzeCryptoSentiment(symbol),
    analyzeMomentum(symbol, bars),
    getRSSSentiment(symbol), // FREE alternative data
  ]);

  const strategies: StrategyResult[] = [technical, sentiment, momentum];

  // Add RSS as additional boost if strong signal
  let rssBoost = 0;
  if (rssNews && Math.abs(rssNews.score) > 0.3) {
    rssBoost = rssNews.score * 0.1; // 10% boost
    logger.signal(`[CRYPTO/RSS] ${symbol}: ${rssNews.sentiment} boost (${rssNews.score.toFixed(2)})`);
  }

  // Weighted scoring + RSS boost
  const weightedScore =
    signalToScore(technical.signal) * config.cryptoWeightTechnical * technical.confidence +
    signalToScore(sentiment.signal) * config.cryptoWeightAiNews * sentiment.confidence +
    signalToScore(momentum.signal) * config.cryptoWeightMomentum * momentum.confidence +
    rssBoost;

  // AGGRESSIVE SCALPING: Very low thresholds for high-frequency crypto trading
  let action: 'BUY' | 'SELL' | 'HOLD';
  if (weightedScore > 0.03) {
    action = 'BUY';
  } else if (weightedScore < -0.03) {
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

  // AGGRESSIVE: Calculate quantity with minimum 60% position size
  let quantity = 0;
  if (action === 'BUY' && currentPriceNum > 0) {
    const positionScale = 0.6 + (confidence * 0.4); // Min 60%, max 100%
    const maxValue = config.cryptoMaxPositionSize * positionScale;
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
