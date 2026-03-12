import { logger } from '../utils/logger';

export interface RedditMentionData {
  symbol: string;
  mentions: number;
  bullishMentions: number;
  bearishMentions: number;
  topPosts: string[];
  score: number; // -1 to +1
}

// Per-symbol cache — 30 min TTL
const cache = new Map<string, { data: RedditMentionData; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const BULLISH_WORDS = ['bull', 'moon', 'buy', 'calls', 'long', 'squeeze', 'rocket', 'yolo', 'undervalued', 'breakout', 'pumping', 'gains'];
const BEARISH_WORDS = ['bear', 'puts', 'short', 'crash', 'dump', 'overvalued', 'sell', 'bubble', 'falling', 'down'];

export async function getRedditMentions(symbol: string): Promise<RedditMentionData | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    // Search r/wallstreetbets for the symbol in the last day
    const url = `https://www.reddit.com/r/wallstreetbets/search.json?q=${encodeURIComponent(symbol)}&sort=new&t=day&limit=25&type=link`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'trading-bot/1.0 (educational paper trading)',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);

    const json = await res.json() as {
      data?: {
        children?: Array<{ data: { title: string; score: number; num_comments: number } }>;
      };
    };

    const posts = json.data?.children || [];
    const topPosts = posts.slice(0, 3).map(p => p.data.title);

    let bullishMentions = 0;
    let bearishMentions = 0;

    for (const post of posts) {
      const text = (post.data.title || '').toLowerCase();
      const isBullish = BULLISH_WORDS.some(w => text.includes(w));
      const isBearish = BEARISH_WORDS.some(w => text.includes(w));
      if (isBullish) bullishMentions++;
      if (isBearish) bearishMentions++;
    }

    const mentions = posts.length;
    const net = bullishMentions - bearishMentions;

    // Score: more mentions = more conviction; net bullish/bearish determines direction
    let score = 0;
    if (mentions >= 5) {
      score = Math.max(-1, Math.min(1, net / Math.max(1, mentions) * 2));
    } else if (mentions >= 2) {
      score = Math.max(-0.5, Math.min(0.5, net / Math.max(1, mentions)));
    }
    // < 2 mentions: no signal (might just be noise)

    const data: RedditMentionData = {
      symbol, mentions, bullishMentions, bearishMentions, topPosts, score,
    };

    cache.set(symbol, { data, expiresAt: Date.now() + CACHE_TTL_MS });

    if (mentions > 0) {
      logger.signal(`[REDDIT/WSB] ${symbol}: ${mentions} posts, ${bullishMentions}↑ ${bearishMentions}↓ → score=${score.toFixed(2)}`);
    }

    return data;
  } catch (err) {
    logger.warn(`[REDDIT] Failed for ${symbol}: ${err}`);
    return null;
  }
}
