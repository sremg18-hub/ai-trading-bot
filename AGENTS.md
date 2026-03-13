# AI Trading Bot — Agent Documentation

## Project Overview

This is an **AI-powered multi-strategy trading bot** that operates on **Alpaca Paper Trading** (simulated money only, never real funds). It trades both US stocks during market hours and cryptocurrencies 24/7.

The bot uses a weighted orchestrator that combines multiple signal sources to make BUY/SELL/HOLD decisions. All trades are executed through Alpaca's paper trading API with $100,000 USD in simulated funds.

**⚠️ IMPORTANT**: This bot is configured for **PAPER TRADING ONLY**. The `paper: true` flag is hardcoded and should never be changed without explicit authorization.

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript 5.3+ |
| Web Framework | Express.js 4.21+ |
| Broker API | Alpaca Trade API (@alpacahq/alpaca-trade-api) |
| Technical Indicators | technicalindicators npm package |
| AI Providers | Perplexity Sonar (primary), Anthropic Claude (fallback) |
| Data Sources | Alpaca Market Data, Yahoo Finance (free), RSS News (free), CoinGecko, Alternative.me (Fear & Greed), Reddit (WSB), Market Breadth Analysis |
| Deployment | Docker + Docker Compose |
| Dashboard | Vanilla HTML/CSS/JS (single file, dark terminal theme) |

---

## Project Structure

```
src/
├── index.ts                 # Entry point - Express server + bot loops
├── config.ts                # Environment configuration + validation
├── types.ts                 # TypeScript interfaces + signal scoring
├── orchestrator.ts          # Stock trading decision orchestrator
├── crypto/
│   ├── orchestrator.ts      # Crypto trading decision orchestrator
│   ├── technical.ts         # Crypto technical analysis (RSI, EMA, BB, MACD)
│   ├── sentiment.ts         # Crypto AI sentiment analysis
│   └── momentum.ts          # Crypto momentum + Fear&Greed + CoinGecko
├── strategies/
│   ├── technical.ts         # Stock technical analysis (RSI, EMA, BB, MACD)
│   ├── ai-news.ts           # Stock AI news sentiment (Sonar → Claude)
│   ├── copy-trading.ts      # Model portfolio rebalancing strategy
│   └── alternative-data.ts  # Free alternative data strategy (Yahoo + RSS + Breadth)
├── services/
│   ├── alpaca.ts            # Alpaca API wrapper (orders, positions, bars)
│   ├── market-data.ts       # Historical bar data with caching
│   ├── news-fetcher.ts      # Alpaca news API with caching
│   ├── reddit.ts            # r/wallstreetbets mention tracker
│   ├── coingecko.ts         # CoinGecko market data for crypto
│   ├── fear-greed.ts        # Crypto Fear & Greed index
│   ├── yahoo-finance.ts     # Yahoo Finance free data (volume, analysts, price)
│   ├── rss-news.ts          # RSS news aggregation (FREE sentiment analysis)
│   └── market-breadth.ts    # Market internals and correlation analysis
└── utils/
    ├── logger.ts            # In-memory logger with console output
    └── risk-manager.ts      # Risk checks (position limits, stops)

public/
└── index.html               # Dashboard (single-file vanilla JS)

Configuration Files:
├── package.json             # Dependencies and scripts
├── tsconfig.json            # TypeScript configuration (ES2022, CommonJS)
├── Dockerfile               # Multi-stage build (builder + production)
├── docker-compose.yml       # Container orchestration with health checks
├── .env                     # Environment variables (see .env.example)
└── .env.example             # Template for required env vars
```

---

## Build and Run Commands

```bash
# Install dependencies
npm install

# Development (with hot-reload via ts-node)
npm run dev

# Production build
npm run build

# Run production build
npm start

# Docker build and run
docker-compose up --build
```

---

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `ALPACA_KEY_ID` | Alpaca Paper Trading API Key |
| `ALPACA_SECRET_KEY` | Alpaca Paper Trading Secret Key |

### AI Providers (at least one recommended)
| Variable | Description |
|----------|-------------|
| `PERPLEXITY_API_KEY` | Perplexity Sonar API (primary AI provider) |
| `ANTHROPIC_API_KEY` | Anthropic Claude API (fallback) |
| `OPENROUTER_API_KEY` | OpenRouter API (optional) |

### Trading Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `TRADE_SYMBOLS` | AAPL,MSFT,GOOGL,AMZN,TSLA,NVDA,META | Comma-separated stock symbols |
| `MAX_POSITION_SIZE` | 1000 | Max $ per stock position |
| `MAX_TOTAL_EXPOSURE` | 5000 | Max total stock exposure |
| `STOP_LOSS_PERCENT` | 2 | Auto-exit when down X% |
| `TAKE_PROFIT_PERCENT` | 0.5 | Auto-exit when up X% |
| `CHECK_INTERVAL_MS` | 30000 | Stock check interval (30s) |
| `EXIT_CHECK_MS` | 30000 | TP/SL monitor interval |
| `WEIGHT_TECHNICAL` | 0.40 | Technical strategy weight |
| `WEIGHT_AI_NEWS` | 0.35 | AI news strategy weight |
| `WEIGHT_COPY` | 0.25 | Copy trading weight |

### Crypto Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `CRYPTO_ENABLED` | true | Enable crypto trading |
| `CRYPTO_SYMBOLS` | BTC/USD,ETH/USD,SOL/USD,... | Comma-separated crypto pairs |
| `CRYPTO_MAX_POSITION_SIZE` | 300 | Max $ per crypto position |
| `CRYPTO_MAX_TOTAL_EXPOSURE` | 5000 | Max total crypto exposure |
| `CRYPTO_CHECK_INTERVAL_MS` | 120000 | Crypto check interval (2min) |
| `CRYPTO_WEIGHT_TECHNICAL` | 0.40 | Crypto technical weight |
| `CRYPTO_WEIGHT_AI_NEWS` | 0.30 | Crypto sentiment weight |
| `CRYPTO_WEIGHT_MOMENTUM` | 0.30 | Crypto momentum weight |

### System
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Dashboard port |
| `STATE_FILE` | /data/state.json | Persistent state path |
| `MAX_DAILY_LOSS_PERCENT` | 5 | Daily circuit breaker limit |

---

## Architecture Details

### Stock Trading Loop (Market Hours)
1. **Schedule**: 9:00 AM - 4:00 PM ET, weekdays only
2. **Smart Sleep**: Sleeps outside market hours, wakes at 9 AM ET
3. **Decision Flow**:
   - Fetch market data (bars, news) for all symbols in parallel
   - Run 3 strategies: Technical, AI News, Copy Trading
   - Weighted scoring: `score = Σ(signal_score × weight × confidence)`
   - Reddit WSB sentiment adds ±15% modifier
   - Risk manager validates before execution
   - Execute trades sequentially

### Crypto Trading Loop (24/7)
1. **Schedule**: Runs continuously
2. **Decision Flow**:
   - Fetch hourly bars + current quote
   - Run 3 strategies: Technical, Sentiment, Momentum
   - Momentum includes Fear & Greed index + CoinGecko data
   - Risk checks specific to crypto exposure limits
   - Execute fractional quantity orders

### Exit Monitor
- Runs independently every 30 seconds
- Checks all positions for stop-loss and take-profit conditions
- Automatically closes positions when thresholds are hit
- Prevents duplicate closes with position tracking Set

### Risk Management
- Position size limits (per-symbol and total)
- Stop-loss and take-profit auto-exits
- Daily loss circuit breaker (halts trading if down >5%)
- Market hours validation for stocks
- Buying power checks
- Blocked symbol tracking (403 errors)

---

## Free Data Sources (No API Keys Required)

The bot includes multiple **FREE** data sources to enhance decisions without consuming AI API credits:

### 1. Yahoo Finance (`src/services/yahoo-finance.ts`)
- **Volume Spike Detection**: Identifies 2x+ average volume moves
- **Analyst Ratings**: Consensus (Buy/Hold/Sell) and price targets
- **Short Interest**: High short interest detection for squeeze potential
- **52-Week Highs/Lows**: Breakout/breakdown detection
- **Cache**: 2-minute TTL to avoid rate limiting

### 2. RSS News Aggregator (`src/services/rss-news.ts`)
- **Yahoo Finance RSS**: Free news feed per symbol
- **Keyword Sentiment Analysis**: Bullish/bearish keyword matching (no AI!)
  - 80+ bullish keywords: "surge", "rally", "breakout", "beat", etc.
  - 60+ bearish keywords: "plunge", "crash", "miss", "bankruptcy", etc.
  - Critical keywords: "halt", "SEC investigation", "fraud", etc.
- **News Spike Detection**: 3+ articles in 2 hours = potential event
- **Cache**: 5-minute TTL

### 3. Market Breadth Analysis (`src/services/market-breadth.ts`)
- **Market Trend**: SPY/QQQ trend comparison (bullish/bearish/neutral)
- **Risk-On/Off Detection**: Tech vs broad market performance
- **Correlation Analysis**: Stock beta to SPY, leading/lagging detection
- **Relative Breakouts**: Breakouts relative to market performance
- **Cache**: 3-minute TTL

### Alternative Data Strategy (`src/strategies/alternative-data.ts`)
Combines all free sources with 15% weight in the orchestrator:
- Critical news → immediate SELL/HOLD
- Volume spikes → directional signal
- RSS sentiment → keyword-based score
- Analyst ratings → consensus + target upside
- Breakouts → momentum signal
- Market leadership → boost if leading SPY

---

## Key Code Conventions

### Strategy Pattern
All strategies implement:
```typescript
async function analyzeX(symbol: string, data: Data): Promise<StrategyResult>
```

StrategyResult format:
```typescript
{
  strategy: string,      // Strategy name
  symbol: string,        // Trading symbol
  signal: Signal,        // 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL'
  confidence: number,    // 0.0 - 1.0
  reasoning: string,     // Human-readable explanation
  timestamp: Date,
}
```

### Caching Strategy
- **AI News**: 30-minute TTL (reduces API calls from 8,640/day to ~360/day)
- **Crypto AI**: 2-hour TTL (crypto sentiment changes slower)
- **Market Bars**: 5-minute TTL for daily bars, 2-minute for intraday
- **Yahoo Finance**: 2-minute TTL (avoid rate limits)
- **RSS News**: 5-minute TTL (fresh news without AI cost)
- **Market Breadth**: 3-minute TTL
- **CoinGecko**: 15-minute TTL (batch fetch all coins)
- **Fear & Greed**: 1-hour TTL (updates daily)
- **Reddit**: 30-minute TTL

### Logging
Use the logger utility with appropriate level:
```typescript
logger.info('Informational message');
logger.warn('Warning message');
logger.error('Error message');
logger.trade('Trade execution message');   // Green highlight
logger.signal('Strategy signal message');  // Purple highlight
```

---

## API Endpoints

### Stocks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Full bot status + portfolio |
| GET | `/api/portfolio` | Portfolio snapshot |
| GET | `/api/trades` | Recent stock trades |
| GET | `/api/signals` | Recent stock signals |
| GET | `/api/logs` | Recent log entries |
| POST | `/api/bot/start` | Start stock bot |
| POST | `/api/bot/stop` | Stop stock bot |

### Crypto
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/crypto/status` | Crypto bot status |
| GET | `/api/crypto/trades` | Recent crypto trades |
| GET | `/api/crypto/signals` | Recent crypto signals |
| POST | `/api/crypto/start` | Start crypto bot |
| POST | `/api/crypto/stop` | Stop crypto bot |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Serve dashboard HTML |

---

## Testing

There are no automated unit tests in this project. Testing is done via:

1. **Manual testing** through the dashboard at `http://localhost:3000`
2. **Paper trading verification** - all trades are simulated
3. **Log inspection** via `/api/logs` endpoint

To verify functionality:
```bash
# Start the bot
npm run dev

# Check logs
curl http://localhost:3000/api/logs

# Check status
curl http://localhost:3000/api/status
```

---

## Deployment

### Docker (Recommended)
```bash
docker-compose up -d
```

Health check is configured to hit `/api/status` every 30 seconds.

### Coolify Deployment
1. Push code to GitHub/GitLab
2. Create new Application in Coolify
3. Select repository
4. Build pack: Dockerfile
5. Add environment variables from `.env`
6. Set port: 3000
7. Deploy

### Volume Mounting (Important)
For persistent state across restarts, mount a volume at `/data`:
```yaml
volumes:
  - trading_data:/data
```

---

## Security Considerations

1. **Paper Trading Only**: The `paper: true` flag is hardcoded in `src/services/alpaca.ts` and `src/config.ts`
2. **API Keys**: Never commit `.env` file. Use `.env.example` as template
3. **No Authentication**: Dashboard has no auth - deploy behind reverse proxy with auth if public
4. **Rate Limiting**: AI APIs have caching to prevent excessive calls
5. **Position Limits**: Hardcoded max exposure limits prevent runaway trading

---

## Adding New Strategies

1. Create new file in `src/strategies/` (stocks) or `src/crypto/` (crypto)
2. Implement `async function analyzeX(symbol, data): Promise<StrategyResult>`
3. Add strategy weight to `config.ts` and `.env`
4. Import and call in respective orchestrator
5. Update weights validation in `validateConfig()`

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "ALPACA_KEY_ID is required" | Check `.env` file exists and has valid keys |
| 403 Forbidden on orders | Symbol may not be supported on Alpaca paper - check blocked symbols |
| AI always returns HOLD | Verify PERPLEXITY_API_KEY or ANTHROPIC_API_KEY is set |
| No trades executing | Check market hours for stocks, risk limits, or position exposure |
| State not persisting | Ensure `/data` directory is writable or mount a volume |

---

## File Language Notes

- **Code comments**: Primarily English
- **Documentation**: This file is in English; BLUEPRINT.md is in Spanish
- **Commit messages**: Mixed English/Spanish in history
- **Variable names**: English throughout codebase
