export type Signal = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';

export interface StrategyResult {
  strategy: string;
  symbol: string;
  signal: Signal;
  confidence: number;
  reasoning: string;
  timestamp: Date;
}

export interface OrchestratorDecision {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  quantity: number;
  confidence: number;
  strategies: StrategyResult[];
  reasoning: string;
  timestamp: Date;
}

export interface TradeLog {
  id: string;
  decision: OrchestratorDecision;
  orderResult: Record<string, unknown>;
  status: 'EXECUTED' | 'FAILED' | 'SKIPPED';
  error?: string;
  timestamp: Date;
}

export interface PortfolioSnapshot {
  timestamp: Date;
  equity: number;
  cash: number;
  positions: PositionInfo[];
  dayPnl: number;
  totalPnl: number;
}

export interface PositionInfo {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface BotStatus {
  running: boolean;
  uptime: number;
  lastCheck: Date | null;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  portfolio: PortfolioSnapshot | null;
  recentTrades: TradeLog[];
  recentSignals: StrategyResult[];
}

export function signalToScore(signal: Signal): number {
  const scores: Record<Signal, number> = {
    'STRONG_BUY': 1.0,
    'BUY': 0.5,
    'HOLD': 0,
    'SELL': -0.5,
    'STRONG_SELL': -1.0,
  };
  return scores[signal];
}
