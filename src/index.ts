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

// --- Market Schedule (Eastern Time) ---
const PRE_MARKET_HOUR = 9;
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;
const SLEEP_CHECK_MS = 60000;

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
      logger.error(`[EXIT] Failed to close ${pos.symbol}: ${err}`);
    }
  }
}

// --- Fast Exit Monitor — runs every EXIT_CHECK_MS (default 30s) independently ---
async function exitMonitorLoop(): Promise<void> {
  try {
    const positions = await getPositions();
    // Always check crypto (24/7)
    if (cryptoBotRunning) await checkPositionExits(positions, true);
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
    latestPortfolio = {
      timestamp: new Date(),
      equity: account.equity,
      cash: account.cash,
      positions,
      dayPnl: account.equity - account.last_equity,
      totalPnl: account.equity - 100000,
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
    const dayPnl = account.equity - account.last_equity;
    latestPortfolio = {
      timestamp: new Date(), equity: account.equity, cash: account.cash,
      positions, dayPnl, totalPnl: account.equity - 100000,
    };

    logger.info(`Portfolio: equity=$${account.equity.toFixed(2)}, cash=$${account.cash.toFixed(2)}`);

    for (const symbol of config.tradeSymbols) {
      try {
        const decision = await makeDecision(symbol);
        for (const s of decision.strategies) {
          stocksSignals.push(s);
          if (stocksSignals.length > MAX_LOG * 2) stocksSignals.shift();
        }

        const riskCheck = canTrade(decision, positions, account.equity, account.buying_power, clock.is_open);

        if (decision.action !== 'HOLD' && riskCheck.allowed) {
          stocksTotalTrades++;
          const tradeLog: TradeLog = {
            id: `stock-${Date.now()}-${symbol}`, decision, orderResult: {},
            status: 'EXECUTED', timestamp: new Date(),
          };
          try {
            tradeLog.orderResult = await submitOrder(symbol, decision.quantity, decision.action === 'BUY' ? 'buy' : 'sell') as Record<string, unknown>;
            stocksSuccessfulTrades++;
            logger.trade(`[STOCKS] ${decision.action} ${symbol} x${decision.quantity}`);
          } catch (err) {
            tradeLog.status = 'FAILED'; tradeLog.error = String(err); stocksFailedTrades++;
          }
          stocksTrades.push(tradeLog);
          if (stocksTrades.length > MAX_LOG) stocksTrades.shift();
          saveState();
        } else if (decision.action !== 'HOLD') {
          logger.warn(`[STOCKS] Skipped ${symbol}: ${riskCheck.reason}`);
          stocksTrades.push({
            id: `stock-${Date.now()}-${symbol}`, decision, orderResult: {},
            status: 'SKIPPED', error: riskCheck.reason, timestamp: new Date(),
          });
          if (stocksTrades.length > MAX_LOG) stocksTrades.shift();
        }
      } catch (err) {
        logger.error(`[STOCKS] Decision failed for ${symbol}: ${err}`);
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
    const interval = inMarket ? config.checkIntervalMs : 5 * 60 * 1000;
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
    latestPortfolio = {
      timestamp: new Date(), equity: account.equity, cash: account.cash,
      positions, dayPnl: account.equity - account.last_equity, totalPnl: account.equity - 100000,
    };

    for (const symbol of config.cryptoSymbols) {
      try {
        const decision = await makeCryptoDecision(symbol);
        for (const s of decision.strategies) {
          cryptoSignals.push(s);
          if (cryptoSignals.length > MAX_LOG * 2) cryptoSignals.shift();
        }

        // Normalize: config symbol is BTC/USD, position symbol is BTCUSD
        const normalizedSymbol = symbol.replace('/', '');
        const totalCryptoExposure = cryptoPositions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
        const position = cryptoPositions.find(p => p.symbol === normalizedSymbol || p.symbol === symbol);
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
          reason = `No ${symbol} position to sell`;
        }

        if (allowed) {
          cryptoTotalTrades++;
          const tradeLog: TradeLog = {
            id: `crypto-${Date.now()}-${symbol}`, decision, orderResult: {},
            status: 'EXECUTED', timestamp: new Date(),
          };
          try {
            // Use position symbol if found (Alpaca broker format), otherwise use config symbol
            const orderSymbol = position ? position.symbol : symbol;
            tradeLog.orderResult = await submitCryptoOrder(orderSymbol, decision.quantity, decision.action === 'BUY' ? 'buy' : 'sell') as Record<string, unknown>;
            cryptoSuccessfulTrades++;
            logger.trade(`[CRYPTO] ${decision.action} ${symbol} x${decision.quantity}`);
          } catch (err) {
            tradeLog.status = 'FAILED'; tradeLog.error = String(err); cryptoFailedTrades++;
            logger.error(`[CRYPTO] Order failed: ${err}`);
          }
          cryptoTrades.push(tradeLog);
          if (cryptoTrades.length > MAX_LOG) cryptoTrades.shift();
          saveState();
        } else if (decision.action !== 'HOLD') {
          logger.warn(`[CRYPTO] Skipped ${symbol}: ${reason}`);
        }
      } catch (err) {
        logger.error(`[CRYPTO] Decision failed for ${symbol}: ${err}`);
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
    etTime: et.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
    nextWake: nextWake ? `${nextWake.toLocaleDateString('en-US', { weekday: 'short' })} 9:00 AM ET (${formatTimeUntil(nextWake)})` : null,
    uptime: Date.now() - startTime,
    lastCheck: stocksLastCheck,
    totalTrades: stocksTotalTrades,
    successfulTrades: stocksSuccessfulTrades,
    failedTrades: stocksFailedTrades,
    portfolio: latestPortfolio,
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

    // Restore portfolio
    latestPortfolio = {
      timestamp: new Date(),
      equity: account.equity,
      cash: account.cash,
      positions,
      dayPnl: account.equity - account.last_equity,
      totalPnl: account.equity - 100000,
    };

    // Alpaca orders take priority over saved file (more recent)
    // Overwrite counts with what Alpaca reports
    let alpacaStockCount = 0;
    let alpacaCryptoCount = 0;

    for (const order of orders) {
      if (order.status !== 'filled' && order.status !== 'partially_filled') continue;
      const isCrypto = order.symbol.includes('/') || order.symbol.match(/^(BTC|ETH|SOL|DOGE|AVAX|LINK|LTC|BCH|SHIB|UNI|XRP|AAVE|DOT|MATIC|ADA|ALGO|ATOM|CRV|GRT|MKR|SUSHI|BAT|COMP|SNX|YFI|BAL|LRC|XTZ|FIL|ZRX)USD$/i) !== null;
      const tradeLog: TradeLog = {
        id: order.id,
        decision: {
          symbol: order.symbol,
          action: order.side === 'buy' ? 'BUY' : 'SELL',
          quantity: order.filled_qty,
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

    // Use the larger count (Alpaca vs saved file)
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
  logger.info(`Take-profit: +${config.takeProfitPercent}% | Stop-loss: -${config.stopLossPercent}% | Exit check: every ${config.exitCheckMs / 1000}s`);

  // Load persisted state first, then sync with Alpaca
  loadSavedState();
  await restoreState();

  // Start fast exit monitor
  setTimeout(exitMonitorLoop, config.exitCheckMs);

  startStocks();
  if (config.cryptoEnabled) startCrypto();
});
