import { loadConfig } from './config';
import { getHistoricalBars } from './services/market-data';
import { fetchRecentNews } from './services/news-fetcher';
import { getPositions, getAccount } from './services/alpaca';
import { analyzeTechnical } from './strategies/technical';
import { analyzeNews } from './strategies/ai-news';
import { analyzeCopySignal } from './strategies/copy-trading';
import { getRedditMentions } from './services/reddit';
import { OrchestratorDecision, StrategyResult, PositionInfo, signalToScore } from './types';
import { logger } from './utils/logger';

type CachedAccount = { equity: number; buying_power: number; last_equity: number };

export async function makeDecision(
  symbol: string,
  cachedPositions?: PositionInfo[],
  cachedAccount?: CachedAccount,
): Promise<OrchestratorDecision> {
  const config = loadConfig();

  // Use cached data when available — avoids 49 redundant API calls per cycle
  const [bars, news, positions, account, reddit] = await Promise.all([
    getHistoricalBars(symbol, 100),
    fetchRecentNews(symbol, 10),
    cachedPositions ? Promise.resolve(cachedPositions) : getPositions(),
    cachedAccount ? Promise.resolve(cachedAccount) : getAccount(),
    getRedditMentions(symbol),
  ]);

  // Run all 3 strategies in parallel
  const [technical, aiNews, copy] = await Promise.all([
    analyzeTechnical(symbol, bars),
    analyzeNews(symbol, news),
    analyzeCopySignal(symbol, positions, account.equity),
  ]);

  const strategies: StrategyResult[] = [technical, aiNews, copy];

  // Weighted scoring: score = Σ(score_i × weight_i × confidence_i)
  let weightedScore =
    signalToScore(technical.signal) * config.weightTechnical * technical.confidence +
    signalToScore(aiNews.signal) * config.weightAiNews * aiNews.confidence +
    signalToScore(copy.signal) * config.weightCopy * copy.confidence;

  // Reddit modifier: adds up to ±15% to the score (non-critical, boosts conviction)
  let redditNote = '';
  if (reddit && reddit.mentions >= 2) {
    const redditBoost = reddit.score * 0.15;
    weightedScore += redditBoost;
    redditNote = ` | WSB:${reddit.mentions}posts(${reddit.score > 0 ? '+' : ''}${reddit.score.toFixed(2)})`;
  }

  // Determine action
  let action: 'BUY' | 'SELL' | 'HOLD';
  if (weightedScore > 0.15) {
    action = 'BUY';
  } else if (weightedScore < -0.15) {
    action = 'SELL';
  } else {
    action = 'HOLD';
  }

  const confidence = Math.min(1.0, Math.abs(weightedScore));

  // Calculate quantity based on confidence and max position size
  const price = bars.length > 0 ? bars[bars.length - 1].close : 0;
  let quantity = 0;
  if (action === 'BUY' && price > 0) {
    const maxShares = Math.floor(config.maxPositionSize / price);
    quantity = Math.max(1, Math.floor(maxShares * confidence));
  } else if (action === 'BUY') {
    action = 'HOLD'; // No price data — can't size
  } else if (action === 'SELL') {
    const position = positions.find(p => p.symbol === symbol);
    if (position && position.qty > 0) {
      quantity = position.qty; // Always sell full position — don't leave partial losers
    }
  }

  const reasoning = strategies
    .map(s => `${s.strategy}: ${s.signal}(${s.confidence.toFixed(2)})`)
    .join(' + ') + ` → score=${weightedScore.toFixed(3)}${redditNote}`;

  logger.info(`[ORCHESTRATOR] ${symbol}: ${action} x${quantity} @$${price.toFixed(2)} (score: ${weightedScore.toFixed(3)}) — ${reasoning}`);

  return {
    symbol,
    action,
    quantity,
    price,
    confidence,
    strategies,
    reasoning,
    timestamp: new Date(),
  };
}
