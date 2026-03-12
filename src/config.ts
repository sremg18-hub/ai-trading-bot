export interface Config {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  perplexityApiKey: string | null;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
  tradeSymbols: string[];
  maxPositionSize: number;
  maxTotalExposure: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  checkIntervalMs: number;
  weightTechnical: number;
  weightAiNews: number;
  weightCopy: number;
  port: number;
  paper: true; // ALWAYS true — never real money
  // Crypto
  cryptoEnabled: boolean;
  cryptoSymbols: string[];
  cryptoMaxPositionSize: number;
  cryptoMaxTotalExposure: number;
  cryptoCheckIntervalMs: number;
  cryptoWeightTechnical: number;
  cryptoWeightAiNews: number;
  cryptoWeightMomentum: number;
}

export function loadConfig(): Config {
  return {
    alpacaKeyId: process.env.ALPACA_KEY_ID || '',
    alpacaSecretKey: process.env.ALPACA_SECRET_KEY || '',
    perplexityApiKey: process.env.PERPLEXITY_API_KEY || null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
    tradeSymbols: (process.env.TRADE_SYMBOLS || 'AAPL,MSFT,GOOGL,AMZN,TSLA,NVDA,META').split(',').map(s => s.trim()),
    maxPositionSize: Number(process.env.MAX_POSITION_SIZE) || 1000,
    maxTotalExposure: Number(process.env.MAX_TOTAL_EXPOSURE) || 5000,
    stopLossPercent: Number(process.env.STOP_LOSS_PERCENT) || 2,
    takeProfitPercent: Number(process.env.TAKE_PROFIT_PERCENT) || 5,
    checkIntervalMs: Number(process.env.CHECK_INTERVAL_MS) || 60000,
    weightTechnical: Number(process.env.WEIGHT_TECHNICAL) || 0.40,
    weightAiNews: Number(process.env.WEIGHT_AI_NEWS) || 0.35,
    weightCopy: Number(process.env.WEIGHT_COPY) || 0.25,
    port: Number(process.env.PORT) || 3000,
    paper: true, // HARDCODED — NEVER change this
    // Crypto
    cryptoEnabled: process.env.CRYPTO_ENABLED !== 'false',
    cryptoSymbols: (process.env.CRYPTO_SYMBOLS || 'BTC/USD,ETH/USD,SOL/USD').split(',').map(s => s.trim()),
    cryptoMaxPositionSize: Number(process.env.CRYPTO_MAX_POSITION_SIZE) || 500,
    cryptoMaxTotalExposure: Number(process.env.CRYPTO_MAX_TOTAL_EXPOSURE) || 2000,
    cryptoCheckIntervalMs: Number(process.env.CRYPTO_CHECK_INTERVAL_MS) || 120000,
    cryptoWeightTechnical: Number(process.env.CRYPTO_WEIGHT_TECHNICAL) || 0.40,
    cryptoWeightAiNews: Number(process.env.CRYPTO_WEIGHT_AI_NEWS) || 0.30,
    cryptoWeightMomentum: Number(process.env.CRYPTO_WEIGHT_MOMENTUM) || 0.30,
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (!config.alpacaKeyId) {
    errors.push('ALPACA_KEY_ID is required');
  }
  if (!config.alpacaSecretKey) {
    errors.push('ALPACA_SECRET_KEY is required');
  }
  if (config.tradeSymbols.length === 0) {
    errors.push('TRADE_SYMBOLS must have at least one symbol');
  }

  const weightSum = config.weightTechnical + config.weightAiNews + config.weightCopy;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push(`Stock strategy weights must sum to 1.0 (currently ${weightSum.toFixed(2)})`);
  }

  if (config.cryptoEnabled) {
    const cryptoSum = config.cryptoWeightTechnical + config.cryptoWeightAiNews + config.cryptoWeightMomentum;
    if (Math.abs(cryptoSum - 1.0) > 0.01) {
      errors.push(`Crypto strategy weights must sum to 1.0 (currently ${cryptoSum.toFixed(2)})`);
    }
  }

  return errors;
}
