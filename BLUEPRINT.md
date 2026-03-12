# AI Trading Orchestrator — Blueprint para Claude Code

## Qué es esto

Un bot de trading multi-estrategia desplegable en Coolify que:
1. **Señales técnicas** (RSI, EMA crossover, Bollinger Bands)
2. **Análisis de noticias con Claude AI** (Anthropic API → sentimiento de mercado)
3. **Copy trading simulado** (sigue un portafolio modelo/whale tracker)

Un **orquestador** combina las 3 señales con pesos configurables y decide BUY/SELL/HOLD.

Conectado a **Alpaca Paper Trading** (cuenta demo gratis, sin dinero real).

---

## Paso 0 — Crear cuenta Alpaca (5 min)

1. Ir a https://app.alpaca.markets/signup
2. Registrarse (email + password, no pide KYC para paper trading)
3. Una vez dentro, ir a **API Keys** en el sidebar izquierdo
4. Click **"Generate"** en la sección de **Paper Trading**
5. Copiar el `API Key ID` y el `Secret Key` — los vas a necesitar como env vars
6. Listo. Ya tienes una cuenta paper con $100,000 USD simulados

## Paso 0.5 — API Key de Anthropic (opcional pero recomendado)

Si quieres la estrategia de IA analizando noticias:
1. Ir a https://console.anthropic.com/
2. Crear API Key
3. La vas a pasar como `ANTHROPIC_API_KEY`

Sin esta key, el bot funciona igual pero solo usa señales técnicas + copy trading.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────┐
│                   ORCHESTRATOR                       │
│  Combina señales con pesos configurables             │
│  technical=0.4 | ai_news=0.35 | copy=0.25          │
├─────────────┬──────────────┬────────────────────────┤
│  TECHNICAL  │   AI NEWS    │    COPY TRADING        │
│  RSI, EMA   │  Claude API  │  Portafolio modelo     │
│  Bollinger  │  + web news  │  (configurable)        │
│  MACD       │  sentiment   │                        │
├─────────────┴──────────────┴────────────────────────┤
│              ALPACA PAPER TRADING API                 │
│              (ejecuta órdenes simuladas)              │
├──────────────────────────────────────────────────────┤
│              EXPRESS + DASHBOARD WEB                  │
│              (monitoreo en tiempo real)               │
└──────────────────────────────────────────────────────┘
```

---

## Stack técnico

- **Runtime**: Node.js 20+ con TypeScript
- **Broker**: Alpaca Paper Trading (`@alpacahq/alpaca-trade-api`)
- **Indicadores**: `technicalindicators` (npm)
- **IA**: Anthropic API directo con `fetch` (no SDK extra necesario)
- **Web**: Express + HTML/CSS/JS vanilla embebido (sin React — liviano)
- **Deploy**: Docker → Coolify

---

## Estructura de archivos a crear

```
ai-trading-bot/
├── src/
│   ├── index.ts                 # Entry point — Express server + bot loop
│   ├── config.ts                # Env vars centralizadas
│   ├── types.ts                 # Interfaces TypeScript
│   ├── orchestrator.ts          # Combina señales → decisión final
│   ├── strategies/
│   │   ├── technical.ts         # RSI, EMA, MACD, Bollinger
│   │   ├── ai-news.ts           # Claude analiza noticias del mercado
│   │   └── copy-trading.ts      # Sigue portafolio modelo
│   ├── services/
│   │   ├── alpaca.ts            # Wrapper Alpaca API (órdenes, posiciones, datos)
│   │   ├── market-data.ts       # Obtener candles/barras históricas
│   │   └── news-fetcher.ts      # Traer noticias (Alpaca News API gratuita)
│   └── utils/
│       ├── logger.ts            # Logger con colores + persistencia
│       └── risk-manager.ts      # Stop-loss, position sizing, exposure limits
├── public/
│   └── index.html               # Dashboard web completo (single file)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── tsconfig.json
├── package.json
└── README.md
```

---

## Variables de entorno (.env.example)

```env
# === REQUERIDAS ===
ALPACA_KEY_ID=tu_api_key_de_alpaca
ALPACA_SECRET_KEY=tu_secret_key_de_alpaca

# === OPCIONALES ===
ANTHROPIC_API_KEY=tu_api_key_anthropic

# Símbolos a tradear (separados por coma)
TRADE_SYMBOLS=AAPL,MSFT,GOOGL,AMZN,TSLA,NVDA,META

# Límites de riesgo (USD)
MAX_POSITION_SIZE=1000
MAX_TOTAL_EXPOSURE=5000
STOP_LOSS_PERCENT=2
TAKE_PROFIT_PERCENT=5

# Intervalo de chequeo (ms) — default 60 segundos
CHECK_INTERVAL_MS=60000

# Pesos de estrategia (deben sumar 1.0)
WEIGHT_TECHNICAL=0.40
WEIGHT_AI_NEWS=0.35
WEIGHT_COPY=0.25

# Puerto del dashboard
PORT=3000
```

---

## Especificaciones por archivo

### `src/config.ts`
- Leer todas las env vars con defaults sensatos
- Función `validateConfig()` que retorna errores si faltan keys requeridas
- `paper: true` SIEMPRE hardcodeado (nunca dinero real sin cambio explícito)

### `src/types.ts`
```typescript
type Signal = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL'

interface StrategyResult {
  strategy: string        // 'technical' | 'ai_news' | 'copy'
  symbol: string
  signal: Signal
  confidence: number      // 0.0 - 1.0
  reasoning: string
  timestamp: Date
}

interface OrchestratorDecision {
  symbol: string
  action: 'BUY' | 'SELL' | 'HOLD'
  quantity: number
  confidence: number
  strategies: StrategyResult[]
  reasoning: string
  timestamp: Date
}

interface TradeLog {
  id: string
  decision: OrchestratorDecision
  orderResult: any
  status: 'EXECUTED' | 'FAILED' | 'SKIPPED'
  error?: string
  timestamp: Date
}

interface PortfolioSnapshot {
  timestamp: Date
  equity: number
  cash: number
  positions: PositionInfo[]
  dayPnl: number
  totalPnl: number
}

interface PositionInfo {
  symbol: string
  qty: number
  avgEntryPrice: number
  currentPrice: number
  marketValue: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
}

interface BotStatus {
  running: boolean
  uptime: number
  lastCheck: Date | null
  totalTrades: number
  successfulTrades: number
  failedTrades: number
  portfolio: PortfolioSnapshot | null
  recentTrades: TradeLog[]       // últimos 50
  recentSignals: StrategyResult[] // últimos 100
}
```

Función helper:
```typescript
function signalToScore(signal: Signal): number {
  // STRONG_BUY=1.0, BUY=0.5, HOLD=0, SELL=-0.5, STRONG_SELL=-1.0
}
```

### `src/strategies/technical.ts`
- Función `async analyzeTechnical(symbol, bars): Promise<StrategyResult>`
- Usa `technicalindicators` para calcular:
  - **RSI(14)**: <30 = BUY, >70 = SELL
  - **EMA crossover**: EMA(9) cruza EMA(21) hacia arriba = BUY, hacia abajo = SELL
  - **Bollinger Bands(20,2)**: precio < lower band = BUY, > upper band = SELL
  - **MACD**: cruce de signal line
- Combinar los 4 sub-indicadores en un score promedio → mapear a Signal
- Confidence basada en cuántos indicadores coinciden (4/4 = alta, 2/4 = baja)

### `src/strategies/ai-news.ts`
- Función `async analyzeNews(symbol, recentNews): Promise<StrategyResult>`
- Usa Alpaca News API (gratis con la cuenta) para obtener noticias recientes
- Envía las noticias a Claude API con este prompt:

```
Eres un analista financiero experto. Analiza estas noticias sobre {symbol}
y determina el sentimiento del mercado.

Noticias:
{headlines con resúmenes}

Responde SOLO con JSON:
{
  "signal": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
  "confidence": 0.0-1.0,
  "reasoning": "explicación breve"
}
```

- Si no hay ANTHROPIC_API_KEY, retornar HOLD con confidence 0
- Timeout de 10 segundos, fallback a HOLD si falla

### `src/strategies/copy-trading.ts`
- Función `async analyzeCopySignal(symbol, modelPortfolio): Promise<StrategyResult>`
- Define un "portafolio modelo" configurable (simula seguir un whale):

```typescript
const MODEL_PORTFOLIO: Record<string, number> = {
  'AAPL': 0.20,   // 20% del portafolio
  'MSFT': 0.20,
  'GOOGL': 0.15,
  'AMZN': 0.15,
  'NVDA': 0.15,
  'TSLA': 0.10,
  'META': 0.05,
}
```

- Compara tu portafolio actual vs el modelo
- Si estás sub-ponderado en un símbolo → BUY
- Si estás sobre-ponderado → SELL
- Confidence basada en qué tan lejos estás del target

### `src/orchestrator.ts`
- Función `async makeDecision(symbol): Promise<OrchestratorDecision>`
- Llama a las 3 estrategias en paralelo
- Convierte cada Signal a score numérico con `signalToScore()`
- Score final = Σ(score_i × weight_i × confidence_i)
- Si score > 0.3 → BUY, < -0.3 → SELL, else HOLD
- Calcula quantity basado en confidence y MAX_POSITION_SIZE
- El risk manager valida antes de retornar

### `src/services/alpaca.ts`
- Wrapper sobre `@alpacahq/alpaca-trade-api`
- Funciones:
  - `getAccount()` → balance, equity, buying power
  - `getPositions()` → posiciones actuales
  - `getBars(symbol, timeframe, limit)` → barras históricas
  - `getNews(symbol, limit)` → noticias
  - `submitOrder(symbol, qty, side, type)` → ejecutar orden
  - `getOrderStatus(orderId)` → estado de orden
- SIEMPRE `paper: true`

### `src/utils/risk-manager.ts`
- `canTrade(decision, portfolio): { allowed: boolean, reason: string }`
- Chequeos:
  - No exceder MAX_POSITION_SIZE por símbolo
  - No exceder MAX_TOTAL_EXPOSURE total
  - No comprar si ya estamos en STOP_LOSS para ese símbolo
  - Mercado debe estar abierto (o es after-hours)
  - Debe haber suficiente buying power

### `src/utils/logger.ts`
- Log con timestamps y colores en consola
- Guardar últimos 1000 logs en memoria para el dashboard
- Función `getLogs(n)` para la API

### `src/index.ts`
- Express server en `PORT`
- API endpoints:
  - `GET /api/status` → BotStatus completo
  - `GET /api/trades` → últimos trades
  - `GET /api/signals` → últimas señales
  - `GET /api/portfolio` → snapshot del portafolio
  - `POST /api/bot/start` → iniciar bot loop
  - `POST /api/bot/stop` → pausar bot loop
  - `GET /` → servir dashboard HTML
- Bot loop:
  1. Para cada símbolo en TRADE_SYMBOLS
  2. Obtener datos de mercado (bars + news)
  3. Ejecutar orchestrator.makeDecision()
  4. Si acción ≠ HOLD y riskManager permite → ejecutar orden
  5. Loggear resultado
  6. Esperar CHECK_INTERVAL_MS
  7. Repetir

### `public/index.html`
- Dashboard single-page completo (HTML + CSS + JS en un archivo)
- Diseño: tema oscuro, estilo terminal/trading
- Secciones:
  - **Header**: nombre del bot, status (running/stopped), uptime
  - **Portfolio**: equity, cash, P&L del día, P&L total
  - **Posiciones**: tabla con cada posición y su P&L
  - **Señales recientes**: cards mostrando las 3 estrategias por símbolo
  - **Trade log**: tabla scrolleable con historial
  - **Controles**: botones Start/Stop, refresh
- Polling cada 5 segundos a `/api/status`
- Font: monospace/terminal vibe (JetBrains Mono o IBM Plex Mono de Google Fonts)
- Colores: verde para profit, rojo para loss, amarillo para HOLD
- Animaciones sutiles en updates

### `Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
COPY public/ ./public/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

### `docker-compose.yml`
```yaml
version: '3.8'
services:
  trading-bot:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/status"]
      interval: 30s
      timeout: 10s
      retries: 3
```

---

## Comandos para Claude Code

Abre este archivo en VS Code y dile a Claude Code:

### Prompt 1 — Setup
```
Lee el archivo BLUEPRINT.md completo. Inicializa el proyecto Node.js+TypeScript 
con la estructura descrita. Instala las dependencias. Crea tsconfig.json y 
.env.example. No escribas lógica todavía, solo scaffold.
```

### Prompt 2 — Core types y config
```
Implementa src/config.ts, src/types.ts y src/utils/logger.ts según el blueprint.
```

### Prompt 3 — Alpaca service
```
Implementa src/services/alpaca.ts — el wrapper de Alpaca API. 
Incluye getAccount, getPositions, getBars, getNews, submitOrder.
Siempre paper: true.
```

### Prompt 4 — Estrategia técnica
```
Implementa src/strategies/technical.ts con RSI, EMA crossover, 
Bollinger Bands y MACD. Usa la librería technicalindicators.
```

### Prompt 5 — Estrategia IA
```
Implementa src/strategies/ai-news.ts. Usa fetch directo a la API 
de Anthropic (no SDK). Parsea la respuesta JSON de Claude. 
Fallback graceful si no hay API key.
```

### Prompt 6 — Copy trading
```
Implementa src/strategies/copy-trading.ts con el portafolio modelo 
y la lógica de rebalanceo.
```

### Prompt 7 — Orquestador + Risk Manager
```
Implementa src/orchestrator.ts y src/utils/risk-manager.ts. 
El orquestador combina las 3 señales con weighted scoring.
```

### Prompt 8 — Server + Dashboard
```
Implementa src/index.ts (Express + bot loop) y public/index.html 
(dashboard dark theme estilo terminal de trading). El dashboard 
hace polling a /api/status cada 5 segundos.
```

### Prompt 9 — Docker + Build
```
Crea el Dockerfile y docker-compose.yml. Asegúrate de que 
npm run build funciona y el Dockerfile hace un multi-stage build.
Verifica que todo compila sin errores.
```

### Prompt 10 — Test local
```
Arranca el bot en modo dev con mis env vars. Verifica que el 
dashboard carga, que se conecta a Alpaca paper, y que genera 
al menos una señal. Si hay errores, corrígelos.
```

---

## Deploy en Coolify

Una vez que funciona local:

1. Sube el repo a GitHub/GitLab
2. En Coolify → **New Resource** → **Application**
3. Conectar el repo
4. Build pack: **Dockerfile**
5. Agregar env vars (las de .env)
6. Puerto: **3000**
7. Deploy

El dashboard queda en `https://tu-dominio.com` y el bot arranca automáticamente.

---

## Roadmap futuro (después del MVP)

- [ ] Conectar OANDA para forex (segundo broker)
- [ ] Modo observación de Polymarket (monitorear wallets sin ejecutar)
- [ ] WebSocket en vez de polling para datos en tiempo real
- [ ] Base de datos SQLite/DuckDB para historial persistente
- [ ] Backtesting engine con datos históricos
- [ ] Alertas por Telegram/WhatsApp
- [ ] Métricas Sharpe ratio, max drawdown, win rate
- [ ] n8n workflow para reportes automáticos

---

## Disclaimer

⚠️ **Esto es un proyecto educativo y de prueba de concepto.**
- Usa SOLO paper trading (dinero simulado)
- Trading algorítmico tiene riesgo significativo
- Rendimiento pasado no garantiza resultados futuros
- No es asesoría financiera
