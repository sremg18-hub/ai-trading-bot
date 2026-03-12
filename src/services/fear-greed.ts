import { logger } from '../utils/logger';

export interface FearGreedData {
  value: number;          // 0-100
  classification: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: Date;
}

// Cache — index only updates once per day
let cache: { data: FearGreedData; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getFearGreedIndex(): Promise<FearGreedData | null> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      signal: controller.signal,
      headers: { 'User-Agent': 'trading-bot/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{ value: string; value_classification: string; timestamp: string }>;
    };

    const entry = json.data?.[0];
    if (!entry) throw new Error('No data in response');

    const data: FearGreedData = {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: new Date(parseInt(entry.timestamp, 10) * 1000),
    };

    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    logger.info(`[FEAR_GREED] Index: ${data.value} — ${data.classification}`);
    return data;
  } catch (err) {
    logger.warn(`[FEAR_GREED] Failed to fetch: ${err}`);
    return null;
  }
}

// Converts F&G to a score modifier (-1 to +1, contrarian)
// Extreme Fear → +0.6 (buy the dip), Extreme Greed → -0.6 (sell the top)
export function fearGreedToScore(fg: FearGreedData): number {
  const v = fg.value;
  if (v <= 10) return 0.8;   // Extreme fear = strong buy opportunity
  if (v <= 25) return 0.4;   // Fear = mild buy opportunity
  if (v <= 45) return 0.1;   // Mild fear = slight buy
  if (v <= 55) return 0.0;   // Neutral
  if (v <= 75) return -0.1;  // Mild greed = slight caution
  if (v <= 90) return -0.4;  // Greed = take profits
  return -0.6;               // Extreme greed = strong sell signal
}
