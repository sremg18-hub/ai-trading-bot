import { loadConfig } from '../config';
import { NewsItem } from '../services/news-fetcher';
import { Signal, StrategyResult } from '../types';
import { logger } from '../utils/logger';

interface AIResponse {
  signal: Signal;
  confidence: number;
  reasoning: string;
  source: 'sonar' | 'claude' | 'fallback';
}

const VALID_SIGNALS: Signal[] = ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL'];

// Cache AI results per symbol to avoid redundant API calls
// News from last 24-48h doesn't change every 60 seconds
const AI_CACHE_TTL_MS = Number(process.env.AI_NEWS_CACHE_TTL_MS) || 30 * 60 * 1000; // 30 min default
const aiCache = new Map<string, { result: StrategyResult; expiresAt: number }>();

function parseAIResponse(text: string, source: 'sonar' | 'claude'): AIResponse {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in ${source} response`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as { signal: Signal; confidence: number; reasoning: string };

  if (!VALID_SIGNALS.includes(parsed.signal)) {
    parsed.signal = 'HOLD';
  }
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence || 0));

  return { ...parsed, source };
}

function buildPrompt(symbol: string, context: string): string {
  return `You are an expert financial analyst. Analyze the following information about ${symbol} and determine market sentiment.

${context}

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "signal": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation in English"
}`;
}

// === SONAR (Perplexity) — Primary: real-time web search + analysis ===
async function callSonar(symbol: string): Promise<AIResponse> {
  const config = loadConfig();
  if (!config.perplexityApiKey) {
    throw new Error('No PERPLEXITY_API_KEY');
  }

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
            content: 'You are an expert financial analyst. You analyze real-time market data and news to provide trading signals. Always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: buildPrompt(symbol, `Search for the latest news, market sentiment, analyst ratings, and price action for ${symbol} stock in the last 24-48 hours. Consider earnings, SEC filings, insider trading, sector trends, and macroeconomic factors.`),
          },
        ],
        max_tokens: 400,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sonar API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content || '';

    return parseAIResponse(text, 'sonar');
  } finally {
    clearTimeout(timeout);
  }
}

// === CLAUDE (Anthropic) — Fallback: analyzes Alpaca news feed ===
async function callClaude(symbol: string, news: NewsItem[]): Promise<AIResponse> {
  const config = loadConfig();
  if (!config.anthropicApiKey) {
    throw new Error('No ANTHROPIC_API_KEY');
  }

  const headlines = news
    .map((n, i) => `${i + 1}. ${n.headline}${n.summary ? ` — ${n.summary}` : ''}`)
    .join('\n');

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
        messages: [{ role: 'user', content: buildPrompt(symbol, `Recent news:\n${headlines}`) }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text || '';

    return parseAIResponse(text, 'claude');
  } finally {
    clearTimeout(timeout);
  }
}

// === Main: Sonar → Claude → HOLD fallback (with cache) ===
export async function analyzeNews(symbol: string, recentNews: NewsItem[]): Promise<StrategyResult> {
  // Return cached result if still fresh
  const cached = aiCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    logger.signal(`[AI/CACHE] ${symbol}: ${cached.result.signal} (${cached.result.confidence.toFixed(2)}) — cached`);
    return { ...cached.result, timestamp: new Date() };
  }

  let result: AIResponse;

  // Try Sonar first (real-time web search)
  try {
    result = await callSonar(symbol);
    logger.signal(`[AI/SONAR] ${symbol}: ${result.signal} (confidence: ${result.confidence.toFixed(2)}) — ${result.reasoning}`);
  } catch (sonarErr) {
    logger.warn(`Sonar failed for ${symbol}: ${sonarErr}`);

    // Fallback to Claude with Alpaca news
    try {
      if (recentNews.length === 0) {
        throw new Error('No news to analyze');
      }
      result = await callClaude(symbol, recentNews);
      logger.signal(`[AI/CLAUDE] ${symbol}: ${result.signal} (confidence: ${result.confidence.toFixed(2)}) — ${result.reasoning}`);
    } catch (claudeErr) {
      logger.warn(`Claude fallback also failed for ${symbol}: ${claudeErr}`);
      result = { signal: 'HOLD', confidence: 0, reasoning: `All AI providers failed`, source: 'fallback' };
    }
  }

  const strategyResult: StrategyResult = {
    strategy: 'ai_news',
    symbol,
    signal: result.signal,
    confidence: result.confidence,
    reasoning: `[${result.source}] ${result.reasoning}`,
    timestamp: new Date(),
  };

  // Cache result (don't cache fallback failures)
  if (result.source !== 'fallback') {
    aiCache.set(symbol, { result: strategyResult, expiresAt: Date.now() + AI_CACHE_TTL_MS });
  }

  return strategyResult;
}
