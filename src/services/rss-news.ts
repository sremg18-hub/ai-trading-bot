/**
 * RSS News Aggregator
 * Free financial news without AI APIs
 * Uses keyword-based sentiment analysis
 */

import Parser from 'rss-parser';
import { logger } from '../utils/logger';

const rssParser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)',
  },
  timeout: 10000,
});

// Free RSS feeds for financial news
const RSS_FEEDS = [
  'https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US',
  'https://www.marketwatch.com/rss/marketwatch', // General market news
  'https://seekingalpha.com/feed.xml', // Will need keyword filtering
];

export interface NewsItem {
  title: string;
  summary: string;
  source: string;
  publishedAt: Date;
  sentiment: 'positive' | 'negative' | 'neutral';
  sentimentScore: number;
  keywords: string[];
}

// Bullish and bearish keyword lists
const BULLISH_KEYWORDS = [
  'surge', 'surges', 'rally', 'rallies', 'jump', 'jumps', 'soar', 'soars', 'rocket', 'rockets',
  'breakout', 'breaks out', 'moon', 'bullish', 'strong buy', 'upgrade', 'upgraded', 'beat', 'beats',
  'outperform', 'outperforms', 'growth', 'strong earnings', 'revenue beat', 'guidance raised',
  'partnership', 'contract', 'deal', 'fda approval', 'approval', 'expansion', 'buyback',
  'dividend increase', 'insider buying', 'accumulation', 'support', 'oversold', 'recovery',
  'momentum', 'buy', 'accumulate', 'target raised', 'price target raised', 'pt raised',
  'undervalued', 'bargain', 'dip buying', 'loaded', 'adding', 'long', 'calls', 'call options',
  'gamma squeeze', 'short squeeze', 'squeezed', 'mooning', 'tendies', 'diamond hands',
];

const BEARISH_KEYWORDS = [
  'crash', 'crashes', 'plunge', 'plunges', 'dump', 'dumps', 'tank', 'tanks', 'collapse',
  'bearish', 'sell', 'selling', 'sold', 'downgrade', 'downgraded', 'miss', 'misses',
  'underperform', 'underperforms', 'weak earnings', 'revenue miss', 'guidance cut',
  'lawsuit', 'investigation', 'sec', 'recall', 'layoffs', 'bankruptcy', 'offering',
  'dilution', 'share dilution', 'insider selling', 'distribution', 'resistance', 'overbought',
  'correction', 'bear market', 'recession', 'target cut', 'price target cut', 'pt cut',
  'overvalued', 'bubble', 'short', 'puts', 'put options', 'margin call', 'liquidation',
  'stop loss', 'stopped out', 'capitulation', 'panic', 'fear', 'sell-off', 'selloff',
  'offering', 'secondary offering', 'stock offering', 'equity offering',
];

const CRITICAL_KEYWORDS = [
  'halt', 'halted', 'trading halt', 'suspended', 'investigation', 'sec investigation',
  'fraud', 'accounting fraud', 'restatement', 'ceo resigns', 'cfo resigns', 'executive depart',
  'data breach', 'cyberattack', 'recall', 'lawsuit filed', 'class action',
];

// Cache
const newsCache = new Map<string, { items: NewsItem[]; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function analyzeSentiment(text: string): { sentiment: 'positive' | 'negative' | 'neutral'; score: number; keywords: string[] } {
  const lowerText = text.toLowerCase();
  let score = 0;
  const foundKeywords: string[] = [];

  // Check bullish keywords
  for (const keyword of BULLISH_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      score += 0.15;
      foundKeywords.push(keyword);
    }
  }

  // Check bearish keywords (weighted slightly higher - fear spreads faster)
  for (const keyword of BEARISH_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      score -= 0.18;
      foundKeywords.push(keyword);
    }
  }

  // Critical keywords override
  for (const keyword of CRITICAL_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      score -= 0.5;
      foundKeywords.push(`CRITICAL:${keyword}`);
    }
  }

  // Normalize score
  score = Math.max(-1, Math.min(1, score));

  let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
  if (score > 0.1) sentiment = 'positive';
  else if (score < -0.1) sentiment = 'negative';

  return { sentiment, score, keywords: foundKeywords };
}

/**
 * Fetch news from Yahoo RSS for specific symbol
 */
async function fetchYahooRSS(symbol: string): Promise<NewsItem[]> {
  const cleanSymbol = symbol.replace(/-USD$/i, '').replace(/\/USD$/i, '');
  const url = RSS_FEEDS[0].replace('{symbol}', cleanSymbol);
  
  try {
    const feed = await rssParser.parseURL(url);
    
    return (feed.items || []).map(item => {
      const text = `${item.title || ''} ${item.contentSnippet || item.content || ''}`;
      const analysis = analyzeSentiment(text);
      
      return {
        title: item.title || '',
        summary: item.contentSnippet || item.content || '',
        source: item.source || 'Yahoo Finance',
        publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        sentiment: analysis.sentiment,
        sentimentScore: analysis.score,
        keywords: analysis.keywords,
      };
    });
  } catch (err) {
    logger.warn(`[RSS] Yahoo fetch failed for ${symbol}: ${err}`);
    return [];
  }
}

/**
 * Get aggregated news with sentiment for a symbol
 */
export async function getRSSNews(symbol: string, maxItems: number = 10): Promise<NewsItem[]> {
  const cacheKey = `rss_${symbol}`;
  const cached = newsCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.items.slice(0, maxItems);
  }

  const items = await fetchYahooRSS(symbol);
  
  // Sort by recency and sentiment strength
  items.sort((a, b) => {
    const scoreA = Math.abs(a.sentimentScore) + (Date.now() - a.publishedAt.getTime()) / 86400000;
    const scoreB = Math.abs(b.sentimentScore) + (Date.now() - b.publishedAt.getTime()) / 86400000;
    return scoreB - scoreA;
  });

  newsCache.set(cacheKey, { items, expiresAt: Date.now() + CACHE_TTL_MS });
  
  return items.slice(0, maxItems);
}

/**
 * Get aggregate sentiment score from news
 * Returns -1 to 1, with recency weighting
 */
export async function getRSSSentiment(symbol: string): Promise<{
  score: number;
  confidence: number;
  count: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  keyHeadlines: string[];
} | null> {
  const news = await getRSSNews(symbol, 15);
  
  if (news.length === 0) return null;

  // Weight by recency (more recent = more weight)
  const now = Date.now();
  let weightedScore = 0;
  let totalWeight = 0;
  const keyHeadlines: string[] = [];

  for (const item of news) {
    const hoursOld = (now - item.publishedAt.getTime()) / (1000 * 60 * 60);
    const recencyWeight = Math.max(0.1, 1 - (hoursOld / 24)); // Decay over 24 hours
    
    weightedScore += item.sentimentScore * recencyWeight;
    totalWeight += recencyWeight;

    // Collect significant headlines
    if (Math.abs(item.sentimentScore) > 0.3) {
      keyHeadlines.push(`[${item.sentiment.toUpperCase()}] ${item.title}`);
    }
  }

  if (totalWeight === 0) return null;

  const score = weightedScore / totalWeight;
  const confidence = Math.min(1, news.length / 10); // More news = higher confidence

  let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (score > 0.15) sentiment = 'bullish';
  else if (score < -0.15) sentiment = 'bearish';

  if (Math.abs(score) > 0.1) {
    logger.signal(`[RSS/SENTIMENT] ${symbol}: ${sentiment} (score: ${score.toFixed(2)}, ${news.length} articles)`);
  }

  return {
    score,
    confidence,
    count: news.length,
    sentiment,
    keyHeadlines: keyHeadlines.slice(0, 3),
  };
}

/**
 * Detect news spikes (sudden increase in news volume)
 * Can indicate breaking news or events
 */
export async function detectNewsSpike(symbol: string): Promise<boolean> {
  const news = await getRSSNews(symbol, 20);
  if (news.length < 3) return false;

  // Count articles from last 2 hours
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  const recentCount = news.filter(n => n.publishedAt.getTime() > twoHoursAgo).length;

  return recentCount >= 3; // 3+ articles in 2 hours is a spike
}

/**
 * Check for critical news that should trigger immediate action
 */
export async function checkCriticalNews(symbol: string): Promise<{
  isCritical: boolean;
  action: 'hold' | 'sell' | 'buy';
  reason: string;
} | null> {
  const news = await getRSSNews(symbol, 5);
  
  for (const item of news) {
    const lowerTitle = item.title.toLowerCase();
    
    // Check for trading halts
    if (lowerTitle.includes('halt') || lowerTitle.includes('suspended') || lowerTitle.includes('trading suspended')) {
      return { isCritical: true, action: 'hold', reason: `Trading halt: ${item.title}` };
    }

    // Check for SEC investigations
    if (lowerTitle.includes('sec investigation') || lowerTitle.includes('accounting fraud')) {
      return { isCritical: true, action: 'sell', reason: `SEC/Fraud news: ${item.title}` };
    }

    // Check for bankruptcy
    if (lowerTitle.includes('bankruptcy') || lowerTitle.includes('chapter 11')) {
      return { isCritical: true, action: 'sell', reason: `Bankruptcy: ${item.title}` };
    }

    // Check for offering/dilution
    if (lowerTitle.includes('offering') && lowerTitle.includes('million')) {
      return { isCritical: true, action: 'sell', reason: `Stock offering: ${item.title}` };
    }
  }

  return null;
}
