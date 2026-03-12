import { loadConfig } from './config';
import { getHistoricalBars } from './services/market-data';
import { fetchRecentNews } from './services/news-fetcher';
import { getPositions, getAccount } from './services/alpaca';
import { analyzeTechnical } from './strategies/technical';
import { analyzeNews } from './strategies/ai-news';
import { analyzeCopySignal } from './strategies/copy-trading';
import { OrchestratorDecision, StrategyResult, signalToScore } from './types';
import { logger } from './utils/logger';

export async function makeDecision(symbol: string): Promise<OrchestratorDecision> {
  const config = loadConfig();

  // Gather data
  const [bars, news, positions, account] = await Promise.all([
    getHistoricalBars(symbol, 100),
    fetchRecentNews(symbol, 10),
    getPositions(),
    getAccount(),
  ]);

  // Run all 3 strategies in parallel
  const [technical, aiNews, copy] = await Promise.all([
    analyzeTechnical(symbol, bars),
    analyzeNews(symbol, news),
    analyzeCopySignal(symbol, positions, account.equity),
  ]);

  const strategies: StrategyResult[] = [technical, aiNews, copy];

  // Weighted scoring: score = Σ(score_i × weight_i × confidence_i)
  const weightedScore =
    signalToScore(technical.signal) * config.weightTechnical * technical.confidence +
    signalToScore(aiNews.signal) * config.weightAiNews * aiNews.confidence +
    signalToScore(copy.signal) * config.weightCopy * copy.confidence;

  // Determine action
  let action: 'BUY' | 'SELL' | 'HOLD';
  if (weightedScore > 0.3) {
    action = 'BUY';
  } else if (weightedScore < -0.3) {
    action = 'SELL';
  } else {
    action = 'HOLD';
  }

  // Calculate confidence as absolute weighted score normalized
  const confidence = Math.min(1.0, Math.abs(weightedScore));

  // Calculate quantity based on confidence and max position size
  let quantity = 0;
  if (action === 'BUY') {
    // Use latest bar close as price estimate
    const price = bars.length > 0 ? bars[bars.length - 1].close : 100;
    const maxShares = Math.floor(config.maxPositionSize / price);
    quantity = Math.max(1, Math.floor(maxShares * confidence));
  } else if (action === 'SELL') {
    const position = positions.find(p => p.symbol === symbol);
    if (position) {
      quantity = Math.max(1, Math.floor(position.qty * confidence));
    }
  }

  const reasoning = strategies
    .map(s => `${s.strategy}: ${s.signal}(${s.confidence.toFixed(2)})`)
    .join(' + ') + ` → score=${weightedScore.toFixed(3)}`;

  logger.info(`[ORCHESTRATOR] ${symbol}: ${action} x${quantity} (score: ${weightedScore.toFixed(3)}) — ${reasoning}`);

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
