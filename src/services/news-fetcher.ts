import { getNews } from './alpaca';
import { logger } from '../utils/logger';

export interface NewsItem {
  headline: string;
  summary: string;
  created_at: string;
}

export async function fetchRecentNews(symbol: string, limit: number = 10): Promise<NewsItem[]> {
  try {
    const news = await getNews(symbol, limit);
    logger.info(`Fetched ${news.length} news items for ${symbol}`);
    return news;
  } catch (err) {
    logger.error(`Failed to fetch news for ${symbol}: ${err}`);
    return [];
  }
}
