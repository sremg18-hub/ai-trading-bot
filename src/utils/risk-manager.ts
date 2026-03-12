import { loadConfig } from '../config';
import { OrchestratorDecision, PositionInfo } from '../types';
import { logger } from './logger';

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
}

export function canTrade(
  decision: OrchestratorDecision,
  positions: PositionInfo[],
  equity: number,
  buyingPower: number,
  marketOpen: boolean,
): RiskCheckResult {
  const config = loadConfig();

  // Must have a non-HOLD action
  if (decision.action === 'HOLD') {
    return { allowed: false, reason: 'Action is HOLD — no trade needed' };
  }

  // Market must be open
  if (!marketOpen) {
    return { allowed: false, reason: 'Market is closed' };
  }

  // Check buying power for BUY orders
  if (decision.action === 'BUY') {
    const existingPosition = positions.find(p => p.symbol === decision.symbol);
    const existingValue = existingPosition ? existingPosition.marketValue : 0;

    // Estimate order cost (rough — use latest price from position or assume $100)
    const estimatedPrice = existingPosition ? existingPosition.currentPrice : 100;
    const orderCost = decision.quantity * estimatedPrice;

    // Check position size limit
    if (existingValue + orderCost > config.maxPositionSize) {
      return {
        allowed: false,
        reason: `Would exceed MAX_POSITION_SIZE ($${config.maxPositionSize}). Current: $${existingValue.toFixed(0)}, order: $${orderCost.toFixed(0)}`,
      };
    }

    // Check total exposure limit
    const totalExposure = positions.reduce((sum, p) => sum + p.marketValue, 0);
    if (totalExposure + orderCost > config.maxTotalExposure) {
      return {
        allowed: false,
        reason: `Would exceed MAX_TOTAL_EXPOSURE ($${config.maxTotalExposure}). Current: $${totalExposure.toFixed(0)}, order: $${orderCost.toFixed(0)}`,
      };
    }

    // Check buying power
    if (orderCost > buyingPower) {
      return {
        allowed: false,
        reason: `Insufficient buying power. Need $${orderCost.toFixed(0)}, have $${buyingPower.toFixed(0)}`,
      };
    }
  }

  // Check stop-loss: don't buy more if we're already losing on this position
  if (decision.action === 'BUY') {
    const existingPosition = positions.find(p => p.symbol === decision.symbol);
    if (existingPosition && existingPosition.unrealizedPnlPercent < -config.stopLossPercent) {
      return {
        allowed: false,
        reason: `Stop-loss triggered: ${decision.symbol} is down ${existingPosition.unrealizedPnlPercent.toFixed(1)}% (limit: -${config.stopLossPercent}%)`,
      };
    }
  }

  // Quantity must be positive
  if (decision.quantity <= 0) {
    return { allowed: false, reason: 'Quantity must be positive' };
  }

  // Check we actually hold the position if selling
  if (decision.action === 'SELL') {
    const existingPosition = positions.find(p => p.symbol === decision.symbol);
    if (!existingPosition || existingPosition.qty <= 0) {
      return { allowed: false, reason: `No position in ${decision.symbol} to sell` };
    }
    // Don't sell more than we have
    if (decision.quantity > existingPosition.qty) {
      logger.warn(`Reducing sell quantity from ${decision.quantity} to ${existingPosition.qty} for ${decision.symbol}`);
      decision.quantity = existingPosition.qty;
    }
  }

  return { allowed: true, reason: 'All risk checks passed' };
}
