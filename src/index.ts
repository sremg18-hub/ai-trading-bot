import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { loadConfig, validateConfig } from './config';
import { BotStatus, TradeLog, StrategyResult, PortfolioSnapshot } from './types';
import { makeDecision } from './orchestrator';
import { makeCryptoDecision } from './crypto/orchestrator';
import { getAccount, getPositions, submitOrder, submitCryptoOrder, getClock, getRecentOrders } from './services/alpaca';
import { canTrade } from './utils/risk-manager';
import { logger } from './utils/logger';

const config = loadConfig();
const app = express();

// --- Race-condition guard: tracks symbols currently being closed ---
// Prevents exit monitor AND trading cycle from both submitting close orders simultaneously
const closingPositions = new Set<string>();

// --- Blocked symbols: 403/unsupported assets — skip forever this session ---
const blockedSymbols = new Set<string>();

// --- Market Schedule (Eastern Time) ---
const PRE_MARKET_HOUR = 9;
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;
const SLEEP_CHECK_MS = 30000; // Check more frequently when sleeping

function getETNow(): Date {
  const now = new Date();
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etString);
}

function isWeekday(): boolean {
  const et = getETNow();
  const day = et.getDay();
  return day >= 1 && day <= 5;
}

function isPreMarketOrOpen(): boolean {
  if (!isWeekday()) return false;
  const et = getETNow();
  return et.getHours() >= PRE_MARKET_HOUR && et.getHours() < MARKET_CLOSE_HOUR;
}

function isMarketHours(): boolean {
  if (!isWeekday()) return false;
  const et = getETNow();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  return timeVal >= (MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN) && timeVal < (MARKET_CLOSE_HOUR * 60);
}

function getNextWakeTime(): Date {
  const et = getETNow();
  const next = new Date(et);
  if (et.getHours() >= MARKET_CLOSE_HOUR || !isWeekday()) {
    next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
  }
  next.setHours(PRE_MARKET_HOUR, 0, 0, 0);
  return next;
}

function formatTimeUntil(target: Date): string {
  const et = getETNow();
  const diff = target.getTime() - et.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${mins}m`;
}

// --- Shared State ---
const startTime = Date.now();
let latestPortfolio: PortfolioSnapshot | null = null;
let startingEquity = 0; // Set on first account load — baseline for total P&L

// --- Daily Loss Circuit Breaker ---
let dailyHalted = false;
let dailyHaltDate = ''; // 'YYYY-MM-DD' in ET — resets each new day

function checkDailyHalt(equity: number, lastEquity: number): boolean {
  const et = getETNow();
  const today = `${et.getFullYear()}-${et.getMonth()}-${et.getDate()}`;

  // Reset halt at start of new trading day
  if (dailyHaltDate !== today) {
    dailyHalted = false;
    dailyHaltDate = today;
  }

  if (dailyHalted) return true;

  if (lastEquity > 0) {
    const dailyLossPct = ((equity - lastEquity) / lastEquity) * 100;
    if (dailyLossPct <= -config.maxDailyLossPercent) {
      dailyHalted = true;
      logger.warn(`[CIRCUIT BREAKER] Daily loss ${dailyLossPct.toFixed(2)}% exceeded limit -${config.maxDailyLossPercent}%. Halting trading for today.`);
      return true;
    }
  }
  return false;
}

// --- Stocks State ---
let stocksBotRunning = false;
let stocksTimer: ReturnType<typeof setTimeout> | null = null;
let stocksLastCheck: Date | null = null;
let stocksMode: 'ACTIVE' | 'SLEEPING' | 'PRE_MARKET' | 'STOPPED' = 'STOPPED';
let stocksTotalTrades = 0;
let stocksSuccessfulTrades = 0;
let stocksFailedTrades = 0;
const stocksTrades: TradeLog[] = [];
const stocksSignals: StrategyResult[] = [];

// --- Crypto State ---
let cryptoBotRunning = false;
let cryptoTimer: ReturnType<typeof setTimeout> | null = null;
let cryptoLastCheck: Date | null = null;
let cryptoTotalTrades = 0;
let cryptoSuccessfulTrades = 0;
let cryptoFailedTrades = 0;
const cryptoTrades: TradeLog[] = [];
const cryptoSignals: StrategyResult[] = [];

const MAX_LOG = 100;

// --- Persistent State ---
function saveState(): void {
  try {
    const dir = path.dirname(config.stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const state = {
      stocksTrades: stocksTrades.slice(-MAX_LOG),
      cryptoTrades: cryptoTrades.slice(-MAX_LOG),
      stocksTotalTrades, stocksSuccessfulTrades, stocksFailedTrades,
      cryptoTotalTrades, cryptoSuccessfulTrades, cryptoFailedTrades,
      startingEquity,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch {
    // Silently skip if path not available (local dev without /data)
  }
}

function loadSavedState(): void {
  try {
    if (!fs.existsSync(config.stateFile)) return;
    const raw = fs.readFileSync(config.stateFile, 'utf-8');
    const state = JSON.parse(raw);
    if (state.stocksTrades) stocksTrades.push(...state.stocksTrades);
    if (state.cryptoTrades) cryptoTrades.push(...state.cryptoTrades);
    stocksTotalTrades = state.stocksTotalTrades || 0;
    stocksSuccessfulTrades = state.stocksSuccessfulTrades || 0;
    stocksFailedTrades = state.stocksFailedTrades || 0;
    cryptoTotalTrades = state.cryptoTotalTrades || 0;
    cryptoSuccessfulTrades = state.cryptoSuccessfulTrades || 0;
    cryptoFailedTrades = state.cryptoFailedTrades || 0;
    if (state.startingEquity > 0) startingEquity = state.startingEquity;
    logger.info(`Loaded saved state from ${config.stateFile} (saved at ${state.savedAt})`);
  } catch (err) {
    logger.warn(`Could not load saved state: ${err}`);
  }
}

// Save state every minute
setInterval(saveState, 60000);

// --- Helper: take-profit / stop-loss auto-exit ---
async function checkPositionExits(positions: ReturnType<typeof getPositions> extends Promise<infer T> ? T : never, isCrypto: boolean): Promise<void> {
  const tp = config.takeProfitPercent;
  const sl = config.stopLossPercent;

  for (const pos of positions) {
    const isCryptoPos = pos.assetClass === 'crypto';
    if (isCryptoPos !== isCrypto) continue;
    if (pos.qty <= 0) continue;

    const pnlPct = pos.unrealizedPnlPercent;
    let reason = '';

    if (pnlPct >= tp) {
      reason = `Take-profit: +${pnlPct.toFixed(2)}% >= +${tp}%`;
    } else if (pnlPct <= -sl) {
      reason = `Stop-loss: ${pnlPct.toFixed(2)}% <= -${sl}%`;
    }

    if (!reason) continue;

    // Skip if already being closed by another concurrent loop
    if (closingPositions.has(pos.symbol)) continue;
    // Skip symbols that returned 403 (unsupported or market closed)
    if (blockedSymbols.has(pos.symbol)) continue;

    closingPositions.add(pos.symbol);
    logger.trade(`[EXIT] Closing ${pos.symbol} — ${reason} (P&L: $${pos.unrealizedPnl.toFixed(2)})`);
    try {
      if (isCrypto) {
        await submitCryptoOrder(pos.symbol, pos.qty, 'sell');
        cryptoTotalTrades++; cryptoSuccessfulTrades++;
      } else {
        await submitOrder(pos.symbol, pos.qty, 'sell');
        stocksTotalTrades++; stocksSuccessfulTrades++;
      }
      saveState();
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('403') || errStr.includes('forbidden') || errStr.includes('not tradable')) {
        blockedSymbols.add(pos.symbol);
        logger.warn(`[EXIT] ${pos.symbol} blocked (403) — will skip this session. Check if Alpaca paper trading supports this symbol.`);
      } else {
        logger.error(`[EXIT] Failed to close ${pos.symbol}: ${err}`);
      }
    } finally {
      closingPositions.delete(pos.symbol);
    }
  }
}

// --- Rebalance: reduce crypto exposure if over limit (sell worst performers first) ---
async function rebalanceCryptoIfOverExposed(positions: Awaited<ReturnType<typeof getPositions>>): Promise<void> {
  const cryptoPos = positions.filter(p => p.assetClass === 'crypto' && p.qty > 0);
  const totalExposure = cryptoPos.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  const limit = config.cryptoMaxTotalExposure;

  if (totalExposure <= limit * 1.05) return; // Only act if >5% over limit

  const excess = totalExposure - limit;
  logger.warn(`[REBALANCE] Crypto over-exposed: $${totalExposure.toFixed(0)} > $${limit} (excess: $${excess.toFixed(0)}). Reducing...`);

  // Sort by worst PnL first (cut losers, keep winners)
  const sorted = [...cryptoPos].sort((a, b) => a.unrealizedPnlPercent - b.unrealizedPnlPercent);

  let toReduce = excess;
  for (const pos of sorted) {
    if (toReduce <= 0) break;
    const sellValue = Math.min(Math.abs(pos.marketValue), toReduce * 1.1);
    const sellQty = Math.round((sellValue / pos.currentPrice) * 10000) / 10000;
    if (sellQty <= 0 || pos.currentPrice <= 0) continue;

    logger.trade(`[REBALANCE] Selling ${pos.symbol} x${sellQty} to reduce exposure ($${sellValue.toFixed(0)})`);
    try {
      await submitCryptoOrder(pos.symbol, Math.min(sellQty, pos.qty), 'sell');
      cryptoTotalTrades++; cryptoSuccessfulTrades++;
      toReduce -= sellValue;
      saveState();
    } catch (err) {
      logger.error(`[REBALANCE] Failed to sell ${pos.symbol}: ${err}`);
    }
  }
}

// --- Fast Exit Monitor — runs every EXIT_CHECK_MS (default 30s) independently ---
async function exitMonitorLoop(): Promise<void> {
  try {
    const [positions, account] = await Promise.all([getPositions(), getAccount()]);

    // Set starting equity if not yet set
    if (startingEquity === 0 && account.equity > 0) {
      startingEquity = account.equity;
      logger.info(`[INIT] Starting equity set to $${startingEquity.toFixed(2)}`);
    }

    // Update portfolio so dashboard always has fresh data
    latestPortfolio = {
      timestamp: new Date(),
      equity: account.equity,
      cash: account.cash,
      positions,
      dayPnl: account.equity - account.last_equity,
      totalPnl: account.equity - startingEquity,
    };

    // Always check crypto (24/7)
    if (cryptoBotRunning) {
      await checkPositionExits(positions, true);
      await rebalanceCryptoIfOverExposed(positions);
    }
    // Check stocks only during market hours
    if (stocksBotRunning && stocksMode === 'ACTIVE') await checkPositionExits(positions, false);
  } catch (err) {
    logger.error(`[EXIT_MONITOR] Error: ${err}`);
  }
  setTimeout(exitMonitorLoop, config.exitCheckMs);
}

// --- Helper: update portfolio ---
async function updatePortfolio(): Promise<void> {
  try {
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);
    if (startingEquity === 0 && account.equity > 0) startingEquity = account.equity;
    latestPortfolio = {
      timestamp: new Date(),
      equity: account.equity,
      cash: account.cash,
      positions,
      dayPnl: account.equity - account.last_equity,
      totalPnl: account.equity - startingEquity,
    };
  } catch (err) {
    logger.error(`Portfolio update failed: ${err}`);
  }
}

// ============================================================
// STOCKS LOOP
// ============================================================
async function runStocksCycle(): Promise<void> {
  logger.info('[STOCKS] Starting cycle...');
  stocksLastCheck = new Date();

  try {
    const [account, positions, clock] = await Promise.all([getAccount(), getPositions(), getClock()]);

    if (startingEquity === 0 && account.equity > 0) startingEquity = account.equity;

    const dayPnl = account.equity - account.last_equity;
    latestPortfolio = {
      timestamp: new Date(), equity: account.equity, cash: account.cash,
      positions, dayPnl, totalPnl: account.equity - startingEquity,
    };

    // Circuit breaker: halt if daily loss limit hit
    if (checkDailyHalt(account.equity, account.last_equity)) {
      logger.warn('[STOCKS] Cycle skipped — daily loss limit reached');
      return;
    }

    logger.info(`Portfolio: equity=$${account.equity.toFixed(2)}, cash=$${account.cash.toFixed(2)}, dayPnL=${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)}`);

    // Phase 1: Make ALL decisions in parallel (bars/news cached, AI cached → fast)
    const decisions = await Promise.all(
      config.tradeSymbols.map(async (symbol) => {
        try {
          return await makeDecision(symbol, positions, account);
        } catch (err) {
          logger.error(`[STOCKS] Decision failed for ${symbol}: ${err}`);
          return null;
        }
      })
    );

    // Phase 2: Execute trades sequentially (risk checks depend on running totals)
    for (const decision of decisions) {
      if (!decision) continue;

      for (const s of decision.strategies) {
        stocksSignals.push(s);
        if (stocksSignals.length > MAX_LOG * 2) stocksSignals.shift();
      }

      const riskCheck = canTrade(decision, positions, account.equity, account.buying_power, clock.is_open);

      if (decision.action !== 'HOLD' && riskCheck.allowed) {
        // Skip if exit monitor is already closing this position
        if (closingPositions.has(decision.symbol)) {
          logger.warn(`[STOCKS] Skipped ${decision.symbol}: position is being closed by exit monitor`);
          continue;
        }
        // Skip if symbol is blocked (403 from Alpaca)
        if (blockedSymbols.has(decision.symbol)) {
          logger.warn(`[STOCKS] Skipped ${decision.symbol}: symbol blocked (403)`);
          continue;
        }

        stocksTotalTrades++;
        const tradeLog: TradeLog = {
          id: `stock-${Date.now()}-${decision.symbol}`, decision, orderResult: {},
          status: 'EXECUTED', timestamp: new Date(),
        };
        try {
          tradeLog.orderResult = await submitOrder(decision.symbol, decision.quantity, decision.action === 'BUY' ? 'buy' : 'sell') as Record<string, unknown>;
          stocksSuccessfulTrades++;
          logger.trade(`[STOCKS] ${decision.action} ${decision.symbol} x${decision.quantity} @~$${decision.price.toFixed(2)}`);
        } catch (err) {
          tradeLog.status = 'FAILED'; tradeLog.error = String(err); stocksFailedTrades++;
          const errStr = String(err);
          if (errStr.includes('403') || errStr.includes('forbidden') || errStr.includes('not tradable')) {
            blockedSymbols.add(decision.symbol);
            logger.warn(`[STOCKS] ${decision.symbol} blocked (403) — skipping this session`);
          }
        }
        stocksTrades.push(tradeLog);
        if (stocksTrades.length > MAX_LOG) stocksTrades.shift();
        saveState();
      } else if (decision.action !== 'HOLD') {
        logger.warn(`[STOCKS] Skipped ${decision.symbol}: ${riskCheck.reason}`);
        stocksTrades.push({
          id: `stock-${Date.now()}-${decision.symbol}`, decision, orderResult: {},
          status: 'SKIPPED', error: riskCheck.reason, timestamp: new Date(),
        });
        if (stocksTrades.length > MAX_LOG) stocksTrades.shift();
      }
    }
    logger.info('[STOCKS] Cycle complete.');
  } catch (err) {
    logger.error(`[STOCKS] Cycle error: ${err}`);
  }
}

async function stocksSmartLoop(): Promise<void> {
  if (!stocksBotRunning) return;

  if (isPreMarketOrOpen()) {
    const inMarket = isMarketHours();
    stocksMode = inMarket ? 'ACTIVE' : 'PRE_MARKET';
    const et = getETNow();
    logger.info(`[STOCKS/${stocksMode}] ET: ${et.toLocaleTimeString('en-US')}`);
    await runStocksCycle();
    const interval = inMarket ? config.checkIntervalMs : 15000; // 15s pre-market (AGGRESSIVE)
    if (stocksBotRunning) stocksTimer = setTimeout(stocksSmartLoop, interval);
  } else {
    stocksMode = 'SLEEPING';
    const nextWake = getNextWakeTime();
    logger.info(`[STOCKS/SLEEPING] Next wake: ${nextWake.toLocaleDateString('en-US', { weekday: 'short' })} 9:00 AM ET (${formatTimeUntil(nextWake)})`);
    await updatePortfolio();
    if (stocksBotRunning) stocksTimer = setTimeout(stocksSmartLoop, SLEEP_CHECK_MS);
  }
}

// ============================================================
// CRYPTO LOOP — Runs 24/7
// ============================================================
async function runCryptoCycle(): Promise<void> {
  logger.info('[CRYPTO] Starting cycle...');
  cryptoLastCheck = new Date();

  try {
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);
    const cryptoPositions = positions.filter(p => p.assetClass === 'crypto');

    if (startingEquity === 0 && account.equity > 0) startingEquity = account.equity;

    latestPortfolio = {
      timestamp: new Date(), equity: account.equity, cash: account.cash,
      positions, dayPnl: account.equity - account.last_equity, totalPnl: account.equity - startingEquity,
    };

    // Phase 1: Make all crypto decisions in parallel (quotes fetched per-symbol, strategies cached)
    const decisions = await Promise.all(
      config.cryptoSymbols.map(async (symbol) => {
        try {
          return await makeCryptoDecision(symbol, positions);
        } catch (err) {
          logger.error(`[CRYPTO] Decision failed for ${symbol}: ${err}`);
          return null;
        }
      })
    );

    // Phase 2: Execute crypto trades sequentially
    for (const decision of decisions) {
      if (!decision) continue;

      for (const s of decision.strategies) {
        cryptoSignals.push(s);
        if (cryptoSignals.length > MAX_LOG * 2) cryptoSignals.shift();
      }

      // Normalize: config symbol is BTC/USD, position symbol is BTCUSD
      const normalizedSymbol = decision.symbol.replace('/', '');
      const totalCryptoExposure = cryptoPositions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
      const position = cryptoPositions.find(p => p.symbol === normalizedSymbol || p.symbol === decision.symbol);
      const positionValue = position ? Math.abs(position.marketValue) : 0;

      let allowed = true;
      let reason = '';

      if (decision.action === 'HOLD' || decision.quantity <= 0) {
        allowed = false;
        reason = 'No action needed';
      } else if (decision.action === 'BUY') {
        if (positionValue >= config.cryptoMaxPositionSize) {
          allowed = false;
          reason = `Max position size reached ($${positionValue.toFixed(0)}/$${config.cryptoMaxPositionSize})`;
        } else if (totalCryptoExposure >= config.cryptoMaxTotalExposure) {
          allowed = false;
          reason = `Max crypto exposure reached ($${totalCryptoExposure.toFixed(0)}/$${config.cryptoMaxTotalExposure})`;
        }
      } else if (decision.action === 'SELL' && (!position || position.qty <= 0)) {
        allowed = false;
        reason = `No ${decision.symbol} position to sell`;
      }

      if (allowed) {
        const orderSymbol = position ? position.symbol : decision.symbol;

        // Skip if exit monitor is already closing this position
        if (closingPositions.has(orderSymbol)) {
          logger.warn(`[CRYPTO] Skipped ${decision.symbol}: position is being closed by exit monitor`);
          continue;
        }
        // Skip 403-blocked symbols
        if (blockedSymbols.has(orderSymbol) || blockedSymbols.has(decision.symbol)) {
          logger.warn(`[CRYPTO] Skipped ${decision.symbol}: symbol blocked (403/unsupported)`);
          continue;
        }

        cryptoTotalTrades++;
        const tradeLog: TradeLog = {
          id: `crypto-${Date.now()}-${decision.symbol}`, decision, orderResult: {},
          status: 'EXECUTED', timestamp: new Date(),
        };
        try {
          tradeLog.orderResult = await submitCryptoOrder(orderSymbol, decision.quantity, decision.action === 'BUY' ? 'buy' : 'sell') as Record<string, unknown>;
          cryptoSuccessfulTrades++;
          logger.trade(`[CRYPTO] ${decision.action} ${decision.symbol} x${decision.quantity}`);
        } catch (err) {
          tradeLog.status = 'FAILED'; tradeLog.error = String(err); cryptoFailedTrades++;
          const errStr = String(err);
          if (errStr.includes('403') || errStr.includes('forbidden') || errStr.includes('not tradable')) {
            blockedSymbols.add(orderSymbol);
            blockedSymbols.add(decision.symbol);
            logger.warn(`[CRYPTO] ${decision.symbol} blocked (403) — skipping this session. Not supported on Alpaca paper trading.`);
          } else {
            logger.error(`[CRYPTO] Order failed: ${err}`);
          }
        }
        cryptoTrades.push(tradeLog);
        if (cryptoTrades.length > MAX_LOG) cryptoTrades.shift();
        saveState();
      } else if (decision.action !== 'HOLD') {
        logger.warn(`[CRYPTO] Skipped ${decision.symbol}: ${reason}`);
      }
    }
    logger.info(`[CRYPTO] Cycle complete. Next in ${config.cryptoCheckIntervalMs / 1000}s`);
  } catch (err) {
    logger.error(`[CRYPTO] Cycle error: ${err}`);
  }
}

async function cryptoLoop(): Promise<void> {
  if (!cryptoBotRunning) return;
  await runCryptoCycle();
  if (cryptoBotRunning) {
    cryptoTimer = setTimeout(cryptoLoop, config.cryptoCheckIntervalMs);
  }
}

// --- Controls ---
function startStocks(): void {
  if (stocksBotRunning) return;
  stocksBotRunning = true;
  logger.info('[STOCKS] Bot started');
  stocksSmartLoop();
}

function stopStocks(): void {
  stocksBotRunning = false;
  stocksMode = 'STOPPED';
  if (stocksTimer) { clearTimeout(stocksTimer); stocksTimer = null; }
  logger.info('[STOCKS] Bot stopped');
}

function startCrypto(): void {
  if (cryptoBotRunning || !config.cryptoEnabled) return;
  cryptoBotRunning = true;
  logger.info('[CRYPTO] Bot started — 24/7 mode');
  cryptoLoop();
}

function stopCrypto(): void {
  cryptoBotRunning = false;
  if (cryptoTimer) { clearTimeout(cryptoTimer); cryptoTimer = null; }
  logger.info('[CRYPTO] Bot stopped');
}

// --- API Routes ---
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Stocks API
app.get('/api/status', (_req, res) => {
  const et = getETNow();
  const nextWake = stocksMode === 'SLEEPING' ? getNextWakeTime() : null;
  res.json({
    running: stocksBotRunning,
    mode: stocksMode,
    dailyHalted,
    etTime: et.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
    nextWake: nextWake ? `${nextWake.toLocaleDateString('en-US', { weekday: 'short' })} 9:00 AM ET (${formatTimeUntil(nextWake)})` : null,
    uptime: Date.now() - startTime,
    lastCheck: stocksLastCheck,
    totalTrades: stocksTotalTrades,
    successfulTrades: stocksSuccessfulTrades,
    failedTrades: stocksFailedTrades,
    portfolio: latestPortfolio,
    startingEquity,
    recentTrades: [...stocksTrades].reverse(),
    recentSignals: [...stocksSignals].reverse(),
  });
});

app.get('/api/trades', (_req, res) => res.json([...stocksTrades].reverse()));
app.get('/api/signals', (_req, res) => res.json([...stocksSignals].reverse()));

app.get('/api/portfolio', async (_req, res) => {
  try {
    await updatePortfolio();
    res.json(latestPortfolio);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/logs', (_req, res) => res.json(logger.getLogs(200)));
app.get('/api/blocked', (_req, res) => res.json([...blockedSymbols]));
app.post('/api/bot/start', (_req, res) => { startStocks(); res.json({ status: 'started' }); });
app.post('/api/bot/stop', (_req, res) => { stopStocks(); res.json({ status: 'stopped' }); });

// Crypto API
app.get('/api/crypto/status', (_req, res) => {
  res.json({
    running: cryptoBotRunning,
    enabled: config.cryptoEnabled,
    symbols: config.cryptoSymbols,
    lastCheck: cryptoLastCheck,
    checkIntervalMs: config.cryptoCheckIntervalMs,
    totalTrades: cryptoTotalTrades,
    successfulTrades: cryptoSuccessfulTrades,
    failedTrades: cryptoFailedTrades,
    recentTrades: [...cryptoTrades].reverse(),
    recentSignals: [...cryptoSignals].reverse(),
    positions: latestPortfolio?.positions.filter(p => p.assetClass === 'crypto') || [],
  });
});

app.get('/api/crypto/trades', (_req, res) => res.json([...cryptoTrades].reverse()));
app.get('/api/crypto/signals', (_req, res) => res.json([...cryptoSignals].reverse()));
app.post('/api/crypto/start', (_req, res) => { startCrypto(); res.json({ status: 'started' }); });
app.post('/api/crypto/stop', (_req, res) => { stopCrypto(); res.json({ status: 'stopped' }); });

// --- Start ---
const errors = validateConfig(config);
if (errors.length > 0) {
  logger.error(`Config errors: ${errors.join(', ')}`);
  process.exit(1);
}

if (config.perplexityApiKey) {
  logger.info('Sonar (Perplexity) configured as primary AI provider');
} else if (config.anthropicApiKey) {
  logger.info('Claude (Anthropic) configured as AI provider');
} else {
  logger.warn('No AI API keys set — AI strategies will return HOLD');
}

async function restoreState(): Promise<void> {
  logger.info('Restoring state from Alpaca...');
  try {
    const [orders, account, positions] = await Promise.all([
      getRecentOrders(50),
      getAccount(),
      getPositions(),
    ]);

    // Set starting equity: use saved value if available, otherwise use current equity
    if (startingEquity === 0) {
      startingEquity = account.equity;
      logger.info(`[INIT] Starting equity: $${startingEquity.toFixed(2)}`);
    }

    // Restore portfolio
    latestPortfolio = {
      timestamp: new Date(),
      equity: account.equity,
      cash: account.cash,
      positions,
      dayPnl: account.equity - account.last_equity,
      totalPnl: account.equity - startingEquity,
    };

    let alpacaStockCount = 0;
    let alpacaCryptoCount = 0;

    for (const order of orders) {
      if (order.status !== 'filled' && order.status !== 'partially_filled') continue;
      const isCrypto = order.symbol.includes('/') || order.symbol.match(/^(BTC|ETH|SOL|DOGE|AVAX|LINK|LTC|BCH|SHIB|UNI|XRP|AAVE|DOT|MATIC|ADA|ALGO|ATOM|CRV|GRT|MKR|SUSHI|BAT|COMP|SNX|YFI|BAL|LRC|XTZ|FIL|ZRX|BNB|HBAR|ICP|JUP|STX|TRX|BONK|INJ|FLOKI|VET|NEAR|JASMY|OP|WIF|TON|ONDO|PEPE|ARB|APT)USD$/i) !== null;
      const tradeLog: TradeLog = {
        id: order.id,
        decision: {
          symbol: order.symbol,
          action: order.side === 'buy' ? 'BUY' : 'SELL',
          quantity: order.filled_qty,
          price: order.filled_avg_price || 0,
          confidence: 0,
          strategies: [],
          reasoning: `Restored from Alpaca history — filled @ $${order.filled_avg_price}`,
          timestamp: new Date(order.created_at),
        },
        orderResult: order as unknown as Record<string, unknown>,
        status: 'EXECUTED',
        timestamp: new Date(order.created_at),
      };

      if (isCrypto) {
        cryptoTrades.push(tradeLog);
        alpacaCryptoCount++;
      } else {
        stocksTrades.push(tradeLog);
        alpacaStockCount++;
      }
    }

    if (alpacaStockCount > stocksTotalTrades) { stocksTotalTrades = alpacaStockCount; stocksSuccessfulTrades = alpacaStockCount; }
    if (alpacaCryptoCount > cryptoTotalTrades) { cryptoTotalTrades = alpacaCryptoCount; cryptoSuccessfulTrades = alpacaCryptoCount; }

    logger.info(`State restored: ${stocksTotalTrades} stock orders, ${cryptoTotalTrades} crypto orders, ${positions.length} open positions`);
  } catch (err) {
    logger.error(`Failed to restore state: ${err}`);
  }
}

app.listen(config.port, async () => {
  logger.info(`Dashboard running at http://localhost:${config.port}`);
  logger.info(`[STOCKS] Symbols: ${config.tradeSymbols.join(', ')} | Schedule: 9:00 AM–4:00 PM ET`);
  if (config.cryptoEnabled) {
    logger.info(`[CRYPTO] Symbols: ${config.cryptoSymbols.join(', ')} | 24/7 every ${config.cryptoCheckIntervalMs / 1000}s`);
  }
  logger.info(`Paper trading: ALWAYS (hardcoded)`);
  logger.info(`Take-profit: +${config.takeProfitPercent}% | Stop-loss: -${config.stopLossPercent}% | Exit check: every ${config.exitCheckMs / 1000}s | Daily loss limit: -${config.maxDailyLossPercent}%`);

  loadSavedState();
  await restoreState();

  // Start fast exit monitor
  setTimeout(exitMonitorLoop, config.exitCheckMs);

  startStocks();
  if (config.cryptoEnabled) startCrypto();
});
