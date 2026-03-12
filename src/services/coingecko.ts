import { logger } from '../utils/logger';

export interface CoinMarketData {
  symbol: string;         // BTC/USD
  priceChange24h: number; // %
  priceChange7d: number;  // %
  volumeUsd24h: number;
  marketCap: number;
  marketCapRank: number;
}

// CoinGecko ID mapping
const COINGECKO_IDS: Record<string, string> = {
  'BTC/USD': 'bitcoin',
  'ETH/USD': 'ethereum',
  'SOL/USD': 'solana',
  'DOGE/USD': 'dogecoin',
  'AVAX/USD': 'avalanche-2',
  'LINK/USD': 'chainlink',
  'LTC/USD': 'litecoin',
  'BCH/USD': 'bitcoin-cash',
  'SHIB/USD': 'shiba-inu',
  'UNI/USD': 'uniswap',
  'XRP/USD': 'ripple',
  'AAVE/USD': 'aave',
  'DOT/USD': 'polkadot',
  'MATIC/USD': 'matic-network',
  'ADA/USD': 'cardano',
  'ALGO/USD': 'algorand',
  'ATOM/USD': 'cosmos',
  'CRV/USD': 'curve-dao-token',
  'GRT/USD': 'the-graph',
  'MKR/USD': 'maker',
  'SUSHI/USD': 'sushi',
  'BAT/USD': 'basic-attention-token',
  'COMP/USD': 'compound-governance-token',
  'SNX/USD': 'havven',
  'YFI/USD': 'yearn-finance',
  'BAL/USD': 'balancer',
  'LRC/USD': 'loopring',
  'XTZ/USD': 'tezos',
  'FIL/USD': 'filecoin',
  'ZRX/USD': '0x',
};

// Cache all coin data in one batch call — 15 min TTL
let cache: { data: Map<string, CoinMarketData>; expiresAt: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function getCoinMarketData(symbols: string[]): Promise<Map<string, CoinMarketData>> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const ids = symbols
    .map(s => COINGECKO_IDS[s])
    .filter(Boolean)
    .join(',');

  if (!ids) return new Map();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=250&page=1&price_change_percentage=24h,7d`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'trading-bot/1.0', 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);

    const coins = await res.json() as Array<{
      id: string;
      symbol: string;
      market_cap_rank: number;
      market_cap: number;
      total_volume: number;
      price_change_percentage_24h: number;
      price_change_percentage_7d_in_currency: number;
    }>;

    // Build reverse map: coingecko ID → our symbol
    const reverseMap: Record<string, string> = {};
    for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
      reverseMap[id] = sym;
    }

    const result = new Map<string, CoinMarketData>();
    for (const coin of coins) {
      const ourSymbol = reverseMap[coin.id];
      if (!ourSymbol) continue;
      result.set(ourSymbol, {
        symbol: ourSymbol,
        priceChange24h: coin.price_change_percentage_24h || 0,
        priceChange7d: coin.price_change_percentage_7d_in_currency || 0,
        volumeUsd24h: coin.total_volume || 0,
        marketCap: coin.market_cap || 0,
        marketCapRank: coin.market_cap_rank || 999,
      });
    }

    cache = { data: result, expiresAt: Date.now() + CACHE_TTL_MS };
    logger.info(`[COINGECKO] Fetched market data for ${result.size} coins`);
    return result;
  } catch (err) {
    logger.warn(`[COINGECKO] Failed to fetch: ${err}`);
    return cache?.data || new Map(); // Return stale cache on failure
  }
}

// Derives a signal score from CoinGecko market data (-1 to +1)
export function coinDataToScore(data: CoinMarketData): { score: number; detail: string } {
  let score = 0;
  const parts: string[] = [];

  // 24h price change (momentum confirmation)
  if (data.priceChange24h > 10) {
    score += 0.5; parts.push(`24h+${data.priceChange24h.toFixed(1)}%`);
  } else if (data.priceChange24h > 3) {
    score += 0.2; parts.push(`24h+${data.priceChange24h.toFixed(1)}%`);
  } else if (data.priceChange24h < -10) {
    score -= 0.5; parts.push(`24h${data.priceChange24h.toFixed(1)}%`);
  } else if (data.priceChange24h < -3) {
    score -= 0.2; parts.push(`24h${data.priceChange24h.toFixed(1)}%`);
  }

  // 7d trend — medium-term momentum
  if (data.priceChange7d > 20) {
    score += 0.3; parts.push(`7d+${data.priceChange7d.toFixed(1)}%`);
  } else if (data.priceChange7d < -20) {
    score -= 0.3; parts.push(`7d${data.priceChange7d.toFixed(1)}%`);
  }

  // Market cap rank — lower rank = more reliable signal, higher rank = more volatile
  // Top 10 get a slight confidence boost, rank >100 are more speculative
  if (data.marketCapRank <= 10) {
    score *= 1.1; // More reliable large-cap signal
    parts.push(`rank#${data.marketCapRank}(top10)`);
  } else if (data.marketCapRank > 100) {
    score *= 0.8; // Reduce confidence for small-caps
    parts.push(`rank#${data.marketCapRank}(smallcap)`);
  }

  score = Math.max(-1, Math.min(1, score));
  return { score, detail: parts.join(' | ') || 'no signal' };
}
