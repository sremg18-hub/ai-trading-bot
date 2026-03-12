import { getNews } from './alpaca';
import { logger } from '../utils/logger';

export interface NewsItem {
  headline: string;
  summary: string;
  created_at: string;
}

// Cache news per symbol — news doesn't change every 30 seconds
const NEWS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const newsCache = new Map<string, { data: NewsItem[]; expiresAt: number }>();

export async function fetchRecentNews(symbol: string, limit: number = 10): Promise<NewsItem[]> {
  const cached = newsCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const news = await getNews(symbol, limit);
    newsCache.set(symbol, { data: news, expiresAt: Date.now() + NEWS_CACHE_TTL_MS });
    logger.info(`Fetched ${news.length} news items for ${symbol}`);
    return news;
  } catch (err) {
    logger.error(`Failed to fetch news for ${symbol}: ${err}`);
    return cached?.data ?? []; // Return stale on error
  }
}
