import { loadConfig } from '../config';
import { Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';

const VALID_SIGNALS: Signal[] = ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'];

// Cache AI results per crypto symbol — crypto sentiment changes slowly vs check interval
// 30 symbols × 288 cycles/day = 8,640 calls → with 2h cache = ~360 calls/day
const CRYPTO_AI_CACHE_TTL_MS = Number(process.env.CRYPTO_AI_CACHE_TTL_MS) || 2 * 60 * 60 * 1000; // 2h default
const cryptoAiCache = new Map<string, { result: StrategyResult; expiresAt: number }>();

interface AIResponse {
  signal: Signal;
  confidence: number;
  reasoning: string;
  source: string;
}

function parseResponse(text: string, source: string): AIResponse {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in ${source} response`);

  const parsed = JSON.parse(jsonMatch[0]) as AIResponse;
  if (!VALID_SIGNALS.includes(parsed.signal)) parsed.signal = 'HOLD';
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence || 0));
  return { ...parsed, source };
}

// Map crypto symbol to readable name
function cryptoName(symbol: string): string {
  const names: Record<string, string> = {
    'BTC/USD': 'Bitcoin (BTC)',
    'ETH/USD': 'Ethereum (ETH)',
    'SOL/USD': 'Solana (SOL)',
    'DOGE/USD': 'Dogecoin (DOGE)',
    'AVAX/USD': 'Avalanche (AVAX)',
    'LINK/USD': 'Chainlink (LINK)',
    'LTC/USD': 'Litecoin (LTC)',
    'BCH/USD': 'Bitcoin Cash (BCH)',
    'SHIB/USD': 'Shiba Inu (SHIB)',
    'UNI/USD': 'Uniswap (UNI)',
    'XRP/USD': 'XRP (XRP)',
    'AAVE/USD': 'Aave (AAVE)',
    'DOT/USD': 'Polkadot (DOT)',
    'MATIC/USD': 'Polygon (MATIC)',
    'ADA/USD': 'Cardano (ADA)',
    'ALGO/USD': 'Algorand (ALGO)',
    'ATOM/USD': 'Cosmos (ATOM)',
    'CRV/USD': 'Curve Finance (CRV)',
    'GRT/USD': 'The Graph (GRT)',
    'MKR/USD': 'Maker (MKR)',
    'SUSHI/USD': 'SushiSwap (SUSHI)',
    'BAT/USD': 'Basic Attention Token (BAT)',
    'COMP/USD': 'Compound (COMP)',
    'SNX/USD': 'Synthetix (SNX)',
    'YFI/USD': 'Yearn Finance (YFI)',
    'BAL/USD': 'Balancer (BAL)',
    'LRC/USD': 'Loopring (LRC)',
    'XTZ/USD': 'Tezos (XTZ)',
    'FIL/USD': 'Filecoin (FIL)',
    'ZRX/USD': '0x Protocol (ZRX)',
  };
  return names[symbol] || symbol;
}

async function callSonarCrypto(symbol: string): Promise<AIResponse> {
  const config = loadConfig();
  if (!config.perplexityApiKey) throw new Error('No PERPLEXITY_API_KEY');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.perplexityApiKey}`,
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are an expert crypto analyst. Analyze real-time market data to provide trading signals. Always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: `Analyze ${cryptoName(symbol)} for trading. Search for: latest price action, on-chain metrics, whale movements, exchange inflows/outflows, social sentiment, regulatory news, DeFi TVL changes, and upcoming catalysts in the last 24 hours.

Respond ONLY with valid JSON:
{"signal": "STRONG_BUY"|"BUY"|"HOLD"|"SELL"|"STRONG_SELL", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`,
          },
        ],
        max_tokens: 400,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Sonar ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return parseResponse(data.choices?.[0]?.message?.content || '', 'sonar');
  } finally {
    clearTimeout(timeout);
  }
}

async function callClaudeCrypto(symbol: string): Promise<AIResponse> {
  const config = loadConfig();
  if (!config.anthropicApiKey) throw new Error('No ANTHROPIC_API_KEY');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `You are a crypto market analyst. Based on your knowledge of ${cryptoName(symbol)}, current market conditions, and typical patterns, provide a trading signal.

Consider: market cycle position, recent volatility, institutional adoption trends, regulatory environment, and technical momentum.

Respond ONLY with valid JSON:
{"signal": "STRONG_BUY"|"BUY"|"HOLD"|"SELL"|"STRONG_SELL", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`,
        }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Claude ${response.status}`);
    const data = await response.json() as { content?: Array<{ text?: string }> };
    return parseResponse(data.content?.[0]?.text || '', 'claude');
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeCryptoSentiment(symbol: string): Promise<StrategyResult> {
  // Return cached result if still fresh
  const cached = cryptoAiCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    logger.signal(`[CRYPTO/CACHE] ${symbol}: ${cached.result.signal} (${cached.result.confidence.toFixed(2)}) — cached`);
    return { ...cached.result, timestamp: new Date() };
  }

  let result: AIResponse;

  try {
    result = await callSonarCrypto(symbol);
    logger.signal(`[CRYPTO/SONAR] ${symbol}: ${result.signal} (${result.confidence.toFixed(2)})`);
  } catch (sonarErr) {
    try {
      result = await callClaudeCrypto(symbol);
      logger.signal(`[CRYPTO/CLAUDE] ${symbol}: ${result.signal} (${result.confidence.toFixed(2)})`);
    } catch (claudeErr) {
      result = { signal: 'HOLD', confidence: 0, reasoning: 'All AI providers failed', source: 'fallback' };
    }
  }

  const strategyResult: StrategyResult = {
    strategy: 'crypto_sentiment',
    symbol,
    signal: result.signal,
    confidence: result.confidence,
    reasoning: `[${result.source}] ${result.reasoning}`,
    timestamp: new Date(),
  };

  // Cache result (don't cache fallback failures)
  if (result.source !== 'fallback') {
    cryptoAiCache.set(symbol, { result: strategyResult, expiresAt: Date.now() + CRYPTO_AI_CACHE_TTL_MS });
  }

  return strategyResult;
}
