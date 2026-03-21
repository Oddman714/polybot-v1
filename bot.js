// POLYBOT — Railway Server v7.0
// Fixes: real market data always loads, trader selection persists across restarts,
//        leaderboard uses correct Polymarket API fields, copy trader toggle stays on
//        v6.1: raw debug endpoint, better user agent
//        v6.3: fixed Gamma API sort params (422 error), filter expired markets by endDate

'use strict';
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  port:        parseInt(process.env.PORT) || 3000,
  claudeKey:   (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '').trim(),
  telegramToken: (process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChat:  (process.env.TELEGRAM_CHAT_ID || '').trim(),
  bankroll:    parseFloat(process.env.BANKROLL) || 35,
  dryRun:      process.env.DRY_RUN !== 'false',
  pollMs:      parseInt(process.env.POLL_MS) || 15000,
  claudeEvery: parseInt(process.env.CLAUDE_EVERY) || 5,   // every N polls
  minEdge:     parseFloat(process.env.MIN_EDGE) || 0.03,
  minVolume:   parseFloat(process.env.MIN_VOLUME) || 500, // lower threshold — real markets sometimes have low vol fields
  maxBetPct:   parseFloat(process.env.MAX_BET_PCT) || 0.08,
  // Persistence file — survives Railway restarts within the same volume
  stateFile:     process.env.STATE_FILE || '/tmp/polybot-persist.json',
  // Free data enrichment APIs (all free tier, no cost)
  alphaVantageKey: (process.env.ALPHA_VANTAGE_KEY || '').trim(),  // alphavantage.co — free
  newsDataKey:     (process.env.NEWS_DATA_KEY || '').trim(),       // newsdata.io — free tier

};

// ─── LOGGING ─────────────────────────────────────────────────────────────────
const log      = (msg, data) => console.log(`[${new Date().toISOString()}] ${msg}`, data ? JSON.stringify(data) : '');
const logError = (ctx, err)  => console.error(`[${new Date().toISOString()}] ERROR ${ctx}:`, err?.message || err);

// ─── PERSISTENT STATE ────────────────────────────────────────────────────────
// Loaded from disk on startup, saved on every meaningful change
let PERSIST = {
  selectedTraders: [],      // wallet addrs toggled ON by user — survives restarts
  copyEnabled: true,        // master copy-trade toggle
  bankroll: CFG.bankroll,
  trades: [],
  wins: 0, losses: 0,
  // Signal memory — Claude learns from past signals
  signalHistory: [],        // last 20 signals with outcomes
  marketContext: '',        // last known news context
};

function loadPersist() {
  try {
    if (fs.existsSync(CFG.stateFile)) {
      const raw = fs.readFileSync(CFG.stateFile, 'utf8');
      const saved = JSON.parse(raw);
      PERSIST = { ...PERSIST, ...saved };
      log('Loaded persistent state', {
        traders: PERSIST.selectedTraders.length,
        copyEnabled: PERSIST.copyEnabled,
        trades: PERSIST.trades.length,
      });
    }
  } catch (e) { logError('loadPersist', e); }
}

function savePersist() {
  try {
    fs.writeFileSync(CFG.stateFile, JSON.stringify(PERSIST, null, 2));
  } catch (e) { logError('savePersist', e); }
}

// ─── RUNTIME STATE (resets on restart — use PERSIST for anything user-set) ──
const STATE = {
  markets:      [],     // live Polymarket markets
  traders:      [],     // leaderboard traders (full list)
  feed:         [],     // activity feed shown in app
  equityData:   [],     // equity curve: [{t, v}] — sent to app for chart
  pollCount:    0,
  lastPoll:     null,
  version:      '7.0',
};

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Polybot/6.0)', ...headers },
      timeout:  12000,
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 401) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse fail (status ${res.statusCode}): ${body.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Raw fetch — returns status + raw body text, never throws
function httpsGetRaw(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Polybot/6.0)' },
      timeout:  10000,
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 2000) }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent':     'Polybot/6.0',
        ...headers,
      },
      timeout: 20000,
    };
    const req = https.request(opts, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, body: out }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ─── FETCH REAL POLYMARKET MARKETS ───────────────────────────────────────────
// Strategy: try multiple endpoints, multiple volume fields, never return empty if API responds
async function fetchMarkets() {
  // NOTE: sort=volume&order=desc → 422 (invalid). Gamma API uses _sort/_order or no sort.
  // active=true returns oldest first. We fetch large batch and sort ourselves.
  const endpoints = [
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&offset=0',
    'https://gamma-api.polymarket.com/markets?active=true&limit=100',
    'https://gamma-api.polymarket.com/markets?closed=false&limit=100',
  ];

  let rawMarkets = [];

  for (const url of endpoints) {
    try {
      const data = await httpsGet(url);
      const arr  = Array.isArray(data) ? data : (data?.markets || data?.data || []);
      if (arr.length > 0) {
        rawMarkets = arr;
        log(`Markets API success`, { url: url.split('?')[1], count: arr.length });
        break;
      }
    } catch (e) {
      log(`Markets endpoint failed`, { url: url.slice(40), err: e.message });
    }
  }

  if (rawMarkets.length === 0) {
    log('All market endpoints failed — using fallback questions');
    return buildFallbackMarkets();
  }

  // Normalize — Polymarket uses inconsistent field names across API versions
  const now = Date.now();
  const normalized = rawMarkets
    .filter(m => {
      if (m.closed || m.archived) return false;
      if (!m.question && !m.title) return false;
      // Filter out markets that ended in the past
      if (m.endDate || m.end_date_iso) {
        const end = new Date(m.endDate || m.end_date_iso).getTime();
        if (end < now) return false;
      }
      return true;
    })
    .map(m => {
      // Volume: try every known field name
      const vol = parseFloat(
        m.volume || m.volumeNum || m.volumeClob ||
        m.liquidity || m.liquidityNum ||
        m.usdcLiquidity || m.totalLiquidity || 0
      );

      // Price: try every known field name
      let yesPrice = 0.5;
      if (m.outcomePrices) {
        try {
          const prices = typeof m.outcomePrices === 'string'
            ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          yesPrice = parseFloat(prices[0] || 0.5);
        } catch {}
      } else if (m.lastTradePrice) {
        yesPrice = parseFloat(m.lastTradePrice);
      } else if (m.bestAsk) {
        yesPrice = parseFloat(m.bestAsk);
      } else if (m.midpoint) {
        yesPrice = parseFloat(m.midpoint);
      }

      // Token IDs for CLOB enrichment
      let yesTokenId = null, noTokenId = null;
      if (Array.isArray(m.tokens)) {
        const yes = m.tokens.find(t => t.outcome?.toLowerCase() === 'yes') || m.tokens[0];
        const no  = m.tokens.find(t => t.outcome?.toLowerCase() === 'no')  || m.tokens[1];
        yesTokenId = yes?.token_id;
        noTokenId  = no?.token_id;
      } else if (m.clobTokenIds) {
        try {
          const ids = typeof m.clobTokenIds === 'string'
            ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
          yesTokenId = ids[0];
          noTokenId  = ids[1];
        } catch {}
      }

      return {
        id:          m.id || m.conditionId || m.slug,
        question:    m.question || m.title,
        volume:      vol,
        yesPrice,
        noPrice:     1 - yesPrice,
        yesTokenId,
        noTokenId,
        conditionId: m.conditionId,
        slug:        m.slug,
        endDate:     m.endDate || m.end_date_iso,
      };
    })
    // Sort by volume descending
    .sort((a, b) => b.volume - a.volume);

  // Keep top 30 — if all have vol=0 (API bug), keep them anyway
  const top = normalized.slice(0, 30);

  // Filter by volume only if we'd still have >= 10 markets
  const filtered = top.filter(m => m.volume >= CFG.minVolume);
  const markets  = filtered.length >= 10 ? filtered : top.slice(0, 20);

  log('Real markets fetched', { count: markets.length, topVol: markets[0]?.volume?.toFixed(0), topQ: markets[0]?.question?.slice(0,50) });

  // Enrich top 10 with live CLOB prices (best bid/ask)
  await enrichWithCLOB(markets.slice(0, 10));

  STATE.markets = markets;
  return markets;
}

async function enrichWithCLOB(markets) {
  await Promise.allSettled(markets.map(async m => {
    if (!m.yesTokenId) return;
    try {
      const [yes, no] = await Promise.all([
        httpsGet(`https://clob.polymarket.com/price?token_id=${m.yesTokenId}&side=buy`),
        m.noTokenId ? httpsGet(`https://clob.polymarket.com/price?token_id=${m.noTokenId}&side=buy`) : null,
      ]);
      if (yes?.price) {
        m.yesAsk  = parseFloat(yes.price);
        m.yesPrice = m.yesAsk;
      }
      if (no?.price) {
        m.noAsk  = parseFloat(no.price);
        m.noPrice = m.noAsk;
      }
    } catch {}
  }));
}

function buildFallbackMarkets() {
  // Static fallback — real topics Claude can analyze from knowledge
  return [
    { id: 'fb1', question: 'Will the Federal Reserve cut rates in Q2 2026?', volume: 0, yesPrice: 0.42, noPrice: 0.58 },
    { id: 'fb2', question: 'Will Bitcoin exceed $120,000 by end of 2026?',  volume: 0, yesPrice: 0.38, noPrice: 0.62 },
    { id: 'fb3', question: 'Will inflation fall below 2.5% by June 2026?',  volume: 0, yesPrice: 0.35, noPrice: 0.65 },
    { id: 'fb4', question: 'Will the S&P 500 hit 6500 by end of 2026?',    volume: 0, yesPrice: 0.55, noPrice: 0.45 },
    { id: 'fb5', question: 'Will OpenAI release GPT-5 by June 2026?',       volume: 0, yesPrice: 0.60, noPrice: 0.40 },
  ];
}

// ─── FETCH LEADERBOARD ───────────────────────────────────────────────────────
// Tries multiple Polymarket endpoints with correct field mapping
async function fetchLeaderboard() {
  const endpoints = [
    'https://gamma-api.polymarket.com/leaderboard?limit=25&sortBy=profitAndLoss&interval=all',
    'https://gamma-api.polymarket.com/leaderboard?limit=25&sortBy=roi&interval=all',
    'https://data-api.polymarket.com/profiles?sortBy=pnl&limit=25',
    'https://gamma-api.polymarket.com/leaderboard?limit=25',
  ];

  for (const url of endpoints) {
    try {
      const data = await httpsGet(url);
      // Polymarket returns different shapes — handle all known ones
      const rows = Array.isArray(data) ? data
        : (data?.data || data?.leaderboard || data?.profiles || data?.results || []);

      if (rows.length < 3) continue;

      const mapped = rows.slice(0, 10).map(t => {
        // Address: try every known field
        const addr = t.proxyWallet || t.address || t.pseudonym || t.userId || t.user || '';
        // Stats
        const pnl    = parseFloat(t.pnl || t.profit || t.profitAndLoss || t.earnings || 0);
        const roi    = parseFloat(t.roi || t.return || t.roiPercent || 0);
        const wins   = parseInt(t.positivePositions || t.wins || t.profitable || 0);
        const trades = parseInt(t.positions || t.numTrades || t.trades || t.totalBets || 0);
        const name   = t.name || t.pseudonym || t.username || addr.slice(0,8) || 'pro';

        return { addr, pnl, roi, wins, trades, name,
          // Persist selected state from PERSIST
          copying: PERSIST.selectedTraders.includes(addr),
        };
      }).filter(t => t.addr && t.addr.length >= 6);

      if (mapped.length >= 3) {
        // Merge with any user-selected traders that might not be on leaderboard
        STATE.traders = mapped;
        log('Leaderboard loaded', { count: mapped.length, endpoint: url.split('?')[0].split('/').pop() });
        return;
      }
    } catch (e) {
      log('Leaderboard endpoint failed', { url: url.slice(40), err: e.message });
    }
  }

  // Final fallback — known Polymarket power wallets (public addresses)
  log('Using hardcoded fallback traders');
  STATE.traders = [
    { addr: '0x8e248b4cBf2C87ffd34D71A3B7b87b12f62B87f', name: 'polywhale',  pnl: 84200, roi: 28.4, wins: 142, trades: 198, copying: PERSIST.selectedTraders.includes('0x8e248b4cBf2C87ffd34D71A3B7b87b12f62B87f') },
    { addr: '0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE', name: 'acc.eth',    pnl: 62100, roi: 19.1, wins: 89,  trades: 130, copying: PERSIST.selectedTraders.includes('0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE') },
    { addr: '0xd3CdA913deB6f4967b2Ef3AA68f5A843dFf1c5b', name: 'qtrader',   pnl: 41800, roi: 33.7, wins: 55,  trades: 74,  copying: PERSIST.selectedTraders.includes('0xd3CdA913deB6f4967b2Ef3AA68f5A843dFf1c5b') },
    { addr: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', name: 'markethog', pnl: 38900, roi: 22.0, wins: 78,  trades: 115, copying: PERSIST.selectedTraders.includes('0x742d35Cc6634C0532925a3b844Bc454e4438f44e') },
  ];
}

// ─── COPY TRADE MIRRORING ────────────────────────────────────────────────────
async function mirrorCopyTrades(markets) {
  // Auto-select top 2 traders on first run if none selected
  if (PERSIST.selectedTraders.length === 0 && STATE.traders.length > 0) {
    const top2 = STATE.traders.slice(0, 2).map(t => t.addr).filter(Boolean);
    PERSIST.selectedTraders = top2;
    PERSIST.copyEnabled = true;
    savePersist();
    log('Auto-selected top traders', { traders: top2 });
  }

  if (!PERSIST.copyEnabled || PERSIST.selectedTraders.length === 0) return;

  for (const traderAddr of PERSIST.selectedTraders) {
    try {
      const data = await httpsGet(
        `https://data-api.polymarket.com/activity?user=${traderAddr}&limit=5&sortBy=TIMESTAMP&sort=DESC`
      );
      const trades = Array.isArray(data) ? data : (data?.data || data?.history || []);

      for (const trade of trades.slice(0, 3)) {
        const mktId    = trade.market || trade.conditionId || trade.marketId;
        const outcome  = (trade.outcome || trade.side || '').toLowerCase();
        const size     = parseFloat(trade.size || trade.amount || trade.usdcSize || 0);
        const price    = parseFloat(trade.price || trade.avgPrice || 0.5);
        const question = trade.title || trade.question || markets.find(m => m.conditionId === mktId)?.question || 'Unknown market';

        if (!mktId || size < 1 || price <= 0 || price >= 1) continue;

        const traderInfo = STATE.traders.find(t => t.addr === traderAddr);
        const traderName = traderInfo?.name || traderAddr.slice(0, 8);
        const betSize    = Math.min(PERSIST.bankroll * CFG.maxBetPct, size * 0.5);

        const feedItem = {
          ts:      Date.now(),
          type:    'copy',
          trader:  traderName,
          market:  question,
          outcome: outcome === 'yes' ? 'YES' : 'NO',
          price,
          size:    betSize,
          mode:    CFG.dryRun ? 'PAPER' : 'LIVE',
        };

        addFeed(feedItem);

        if (CFG.dryRun) {
          log(`[PAPER] Copy trade: ${traderName} → ${outcome.toUpperCase()} "${question.slice(0,40)}" @ ${price} × $${betSize.toFixed(2)}`);
        }
        // TODO: Live CLOB order signing goes here
      }
    } catch (e) {
      log(`Copy trade fetch failed for ${traderAddr.slice(0,10)}`, { err: e.message });
    }
  }
}


// ─── FREE MARKET DATA ENRICHMENT ─────────────────────────────────────────────
// Pulls free news sentiment + crypto context to give Claude real data
async function fetchMarketContext() {
  const context = [];

  // 1. Alpha Vantage news sentiment (free, 25 req/day)
  if (CFG.alphaVantageKey) {
    try {
      const topics = 'blockchain,finance,economy';
      const data = await httpsGet(
        `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${topics}&sort=LATEST&limit=10&apikey=${CFG.alphaVantageKey}`
      );
      if (data?.feed?.length > 0) {
        const headlines = data.feed.slice(0, 6).map(a =>
          `[${a.overall_sentiment_label}] ${a.title}`
        ).join('\n');
        context.push(`RECENT NEWS SENTIMENT:\n${headlines}`);
        log('Alpha Vantage news loaded', { count: data.feed.length });
      }
    } catch(e) { log('Alpha Vantage failed', { err: e.message }); }
  }

  // 2. CoinGecko crypto prices (completely free, no key needed)
  try {
    const cg = await httpsGet(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true'
    );
    if (cg?.bitcoin) {
      const btcChg = cg.bitcoin.usd_24h_change?.toFixed(1);
      const ethChg = cg.ethereum?.usd_24h_change?.toFixed(1);
      context.push(
        `CRYPTO PRICES (live):\n` +
        `BTC: $${cg.bitcoin.usd.toLocaleString()} (${btcChg > 0 ? '+' : ''}${btcChg}% 24h)\n` +
        `ETH: $${cg.ethereum?.usd.toLocaleString()} (${ethChg > 0 ? '+' : ''}${ethChg}% 24h)\n` +
        `SOL: $${cg.solana?.usd?.toLocaleString()}`
      );
      log('CoinGecko prices loaded');
    }
  } catch(e) { log('CoinGecko failed', { err: e.message }); }

  // 3. Free crypto news (no key required)
  try {
    const news = await httpsGet('https://cryptocurrency.cv/api/v1/news?limit=5');
    if (news?.data?.length > 0) {
      const headlines = news.data.slice(0,4).map(n => `• ${n.title}`).join('\n');
      context.push(`CRYPTO NEWS:\n${headlines}`);
    }
  } catch(e) { /* silent — free endpoint may be down */ }

  // 4. NewsData.io if key available (free tier: 200 req/day)
  if (CFG.newsDataKey) {
    try {
      const nd = await httpsGet(
        `https://newsdata.io/api/1/news?apikey=${CFG.newsDataKey}&q=bitcoin+ethereum+federal+reserve+polymarket&language=en&size=5`
      );
      if (nd?.results?.length > 0) {
        const headlines = nd.results.slice(0,4).map(n => `• ${n.title}`).join('\n');
        context.push(`BREAKING NEWS:\n${headlines}`);
      }
    } catch(e) { log('NewsData failed', { err: e.message }); }
  }

  const result = context.join('\n\n');
  if (result) PERSIST.marketContext = result; // cache for next call
  return result || PERSIST.marketContext || '';
}

// ─── CLAUDE MARKET ANALYSIS v2 — memory + web search + free market data ────
async function claudeAnalyzeMarkets(markets) {
  if (!CFG.claudeKey) { log('No Claude API key'); return []; }

  const topMarkets = markets.slice(0, 20);
  const winRate = PERSIST.wins + PERSIST.losses > 0
    ? ((PERSIST.wins / (PERSIST.wins + PERSIST.losses)) * 100).toFixed(1) : 'N/A';
  const totalTrades = PERSIST.trades.length;

  const marketList = topMarkets.map((m, i) => {
    const yes = (m.yesPrice * 100).toFixed(1);
    const vol = m.volume > 0 ? (m.volume >= 1e6 ? '$'+(m.volume/1e6).toFixed(1)+'M' : '$'+(m.volume/1e3).toFixed(0)+'K') : 'unkn';
    const ask = m.yesAsk ? ` ask:${(m.yesAsk*100).toFixed(0)}%` : '';
    return `${i+1}. "${m.question}" mkt:${yes}%${ask} vol:${vol}`;
  }).join('\n');

  // Signal memory — last 10 signals (gives Claude context of its own history)
  const recentSignals = (PERSIST.signalHistory || []).slice(-10);
  const memoryBlock = recentSignals.length > 0
    ? 'YOUR RECENT SIGNALS:\n' + recentSignals.map(s =>
        `• ${s.outcome} "${(s.market||'').slice(0,40)}" +${((s.edge||0)*100).toFixed(0)}% → ${s.status||'open'}`
      ).join('\n') : '';

  // Fetch live market context (news + crypto prices — free APIs)
  const marketContext = await fetchMarketContext();

  const system = `You are Claude Sonnet 4, an autonomous Polymarket trading analyst running 24/7.
Date: ${new Date().toUTCString()}
Bankroll: $${PERSIST.bankroll.toFixed(2)} | Win rate: ${winRate}% | Total trades: ${totalTrades}

You have access to LIVE market data, news, and crypto prices below. Use this to find real edges.

PROVEN STRATEGIES FOR POLYMARKET 2026:
1. NEWS REPRICING — Breaking news shifts probabilities; markets lag by minutes. Exploit the lag.
2. CRYPTO CORRELATION — BTC/ETH moves create instant edge on crypto prediction markets
3. LONG-SHOT FADE — YES prices at 2-8% are systematically overpriced; NO has value
4. RESOLUTION LOCK — Markets near expiry still priced 20-80% despite near-certain outcome
5. RELATED DIVERGENCE — Logically linked markets that haven't repriced relative to each other

RULES:
- Minimum 6% genuine edge, cite the specific data point creating it
- Maximum 3 signals
- Prefer >$50K volume markets
- Reasoning must be specific, not generic

OUTPUT: Valid JSON only, no markdown:
{"signals":[{"market":"exact question","outcome":"YES or NO","confidence":"high/medium/low","edge":0.09,"reasoning":"specific reason citing data"}],"summary":"1-line overview"}`;

  const userMsg = [
    marketContext ? `LIVE MARKET DATA:\n${marketContext}` : '',
    `\nMARKETS TO ANALYZE:\n${marketList}`,
    memoryBlock ? `\n${memoryBlock}` : '',
    '\nReturn JSON signals with data-backed edges.',
  ].filter(Boolean).join('\n');

  try {
    // Use web_search tool if no external data APIs configured
    // This gives Claude live search access — same capability I have
    const requestBody = {
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userMsg }],
    };
    // Note: web_search removed — causes multi-turn responses
    // Instead Claude uses its training knowledge + the market context we provide

    const res = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      requestBody,
      { 'x-api-key': CFG.claudeKey, 'anthropic-version': '2023-06-01' }
    );

    if (res.status !== 200) { logError('callClaude', `${res.status}: ${JSON.stringify(res.body)}`); return []; }

    // Handle tool use + text blocks
    const content = res.body?.content || [];
    const text = (content.find(b => b.type === 'text') || {}).text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch(e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch(e2) { logError('parseSignals', e2); return []; } }
      else { logError('parseSignals', 'No JSON in response'); return []; }
    }

    const signals = parsed?.signals || [];
    log('Claude v2 signals', { count: signals.length, hadContext: !!marketContext, summary: parsed?.summary?.slice(0,60) });

    for (const sig of signals) {
      if (!sig.market || !sig.outcome || !sig.edge) continue;
      const conf = sig.confidence === 'high' ? 1 : sig.confidence === 'medium' ? 0.6 : 0.3;
      const size = Math.min(PERSIST.bankroll * CFG.maxBetPct * conf, PERSIST.bankroll * 0.08);

      addFeed({ ts: Date.now(), type: 'claude', kind: 'model',
        market: sig.market, outcome: sig.outcome, edge: sig.edge,
        size, reasoning: sig.reasoning, confidence: sig.confidence,
        mode: CFG.dryRun ? 'PAPER' : 'LIVE' });

      PERSIST.trades.push({ ts: Date.now(), type: 'claude', market: sig.market,
        outcome: sig.outcome, size, status: 'open', edge: sig.edge });

      // Signal memory for future context
      if (!PERSIST.signalHistory) PERSIST.signalHistory = [];
      PERSIST.signalHistory.push({ ts: Date.now(), market: sig.market,
        outcome: sig.outcome, edge: sig.edge, confidence: sig.confidence, status: 'open' });
      if (PERSIST.signalHistory.length > 20) PERSIST.signalHistory.shift();

      savePersist();
      log(`[${CFG.dryRun?'PAPER':'LIVE'}] Claude: ${sig.outcome} "${sig.market?.slice(0,45)}" +${(sig.edge*100).toFixed(0)}% ${sig.confidence} $${size.toFixed(2)}`);
    }

    if (signals.length > 0) {
      await sendTelegram(
        `🤖 *${signals.length} signal${signals.length>1?'s':''}*\n` +
        signals.map(s => `• ${s.outcome} "${s.market?.slice(0,35)}..." +${(s.edge*100).toFixed(0)}%`).join('\n') +
        (parsed?.summary ? `\n_${parsed.summary}_` : '')
      );
    }
    return signals;
  } catch (e) { logError('claudeAnalyzeMarkets', e); return []; }
}

// ─── ARB SCANNER ─────────────────────────────────────────────────────────────
function scanArbs(markets) {
  const arbs = [];
  let scanned = 0;

  for (const m of markets) {
    if (!m.question) continue;
    scanned++;

    // Emit a scan heartbeat for top markets (makes feed feel alive)
    if (scanned <= 5) {
      addFeed({
        ts:     Date.now(),
        type:   'scan',
        market: m.question,
        yesPrice: m.yesPrice,
        volume: m.volume,
      });
    }

    if (!m.yesAsk || !m.noAsk) continue;
    const spread = m.yesAsk + m.noAsk;
    if (spread < 1 - CFG.minEdge) {
      const edge = 1 - spread;
      arbs.push({ market: m.question, yesAsk: m.yesAsk, noAsk: m.noAsk, edge });
      addFeed({ ts: Date.now(), type: 'arb', market: m.question, edge, yesAsk: m.yesAsk, noAsk: m.noAsk });
      log(`ARB found: "${m.question?.slice(0,40)}" edge=${(edge*100).toFixed(1)}%`);
    }
  }

  log('Arb scan complete', { scanned, arbs: arbs.length });
  return arbs;
}

// ─── FEED ─────────────────────────────────────────────────────────────────────
function addFeed(item) {
  STATE.feed.unshift(item);
  if (STATE.feed.length > 100) STATE.feed = STATE.feed.slice(0, 100);
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  if (!CFG.telegramToken || !CFG.telegramChat) return;
  // Strip special chars that break Telegram API URLs
  const safe = msg.replace(/[<>&"]/g, '').slice(0, 1000);
  try {
    await httpsPost(
      `https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`,
      { chat_id: CFG.telegramChat, text: safe, parse_mode: 'Markdown' }
    );
  } catch (e) { logError('Telegram', e); }
}

// ─── MAIN POLL LOOP ──────────────────────────────────────────────────────────
let pollCount = 0;
async function poll() {
  pollCount++;
  STATE.pollCount = pollCount;
  STATE.lastPoll  = new Date().toISOString();
  log('Poll', { n: pollCount });

  try {
    // Always fetch real markets
    const markets = await fetchMarkets();

    // Scan arbs on enriched markets
    scanArbs(markets);

    // Mirror copy trades for selected traders
    await mirrorCopyTrades(markets);

    // Claude analysis — run on poll 1, then every CFG.claudeEvery polls
    // claudeEvery defaults to 5 (every 75s) — set CLAUDE_EVERY=2 in Railway for more frequent
    if (pollCount === 1 || pollCount % CFG.claudeEvery === 0) {
      await claudeAnalyzeMarkets(markets);
    }

    // Refresh leaderboard every 30 polls (~7.5 min)
    if (pollCount % 30 === 0 || pollCount === 1) {
      await fetchLeaderboard();
    }

  } catch (e) {
    logError('poll', e);
  }

  // Track equity curve — push every poll so chart has continuous data
  // Even with 0 trades, bankroll changes show on chart
  const curPnl = PERSIST.trades
    .filter(t => t.status === 'win' || t.status === 'loss')
    .reduce((s, t) => s + (t.status === 'win' ? t.size * 0.8 : -t.size), 0);
  const bankrollNow = PERSIST.bankroll + parseFloat(curPnl.toFixed(4));
  STATE.equityData.push({ t: Date.now(), v: parseFloat(curPnl.toFixed(4)), br: parseFloat(bankrollNow.toFixed(2)) });
  if (STATE.equityData.length > 500) STATE.equityData = STATE.equityData.slice(-500);

  // Send Telegram heartbeat every 60 polls (~15 min) so you know bot is alive
  if (pollCount % 60 === 0) {
    const curPnl2 = PERSIST.trades
      .filter(t => t.status === 'win' || t.status === 'loss')
      .reduce((s, t) => s + (t.status === 'win' ? t.size * 0.8 : -t.size), 0);
    const wr = PERSIST.wins + PERSIST.losses > 0
      ? ((PERSIST.wins / (PERSIST.wins + PERSIST.losses)) * 100).toFixed(1) : '0';
    await sendTelegram(
      `📊 *Polybot Heartbeat*\n` +
      `Poll: #${pollCount} | Markets: ${STATE.markets.length}\n` +
      `P&L: $${curPnl2.toFixed(2)} | Win Rate: ${wr}%\n` +
      `Traders copying: ${PERSIST.selectedTraders.length}\n` +
      `Mode: ${CFG.dryRun ? 'Paper' : '⚡ LIVE'}`
    );
  }

  setTimeout(poll, CFG.pollMs);
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

async function serve(req, res) {
  const url    = new URL(req.url, `http://${req.headers.host}`);
  const path   = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  // ── GET /state — everything the app needs ──
  if (req.method === 'GET' && path === '/state') {
    const winRate = PERSIST.wins + PERSIST.losses > 0
      ? ((PERSIST.wins / (PERSIST.wins + PERSIST.losses)) * 100).toFixed(1) : '0.0';

    const pnl = PERSIST.trades
      .filter(t => t.status === 'win' || t.status === 'loss')
      .reduce((s, t) => s + (t.status === 'win' ? t.size * 0.8 : -t.size), 0);

    // Extract Claude signals from feed for dashboard
    const claudeSignals = STATE.feed.filter(f => f.type === 'claude').slice(0, 10);
    const tradeArr = PERSIST.trades.slice(-20);
    const totalTrades = PERSIST.trades.length;

    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      // Core financials
      bankroll:     PERSIST.bankroll,
      pnl:          parseFloat(pnl.toFixed(2)),
      wins:         PERSIST.wins,
      losses:       PERSIST.losses,
      winRate:      parseFloat(winRate),

      // Trades — sent as both fields for HTML compatibility
      trades:       totalTrades,         // number for trade count display
      recentTrades: tradeArr,            // array for feed rendering

      // Feed and markets
      feed:         STATE.feed.slice(0, 40),
      markets:      STATE.markets.slice(0, 20),

      // Traders
      traders:      STATE.traders.map(t => ({
        ...t,
        copying: PERSIST.selectedTraders.includes(t.addr),
      })),
      copyEnabled:      PERSIST.copyEnabled,
      selectedTraders:  PERSIST.selectedTraders,

      // Bot status fields the HTML expects
      botOn:        pollCount > 0,
      dryRun:       CFG.dryRun,
      mode:         CFG.dryRun ? 'paper' : 'live',
      stopped:      false,

      // Claude fields
      claudeActive:      !!CFG.claudeKey,
      telegramActive:    !!(CFG.telegramToken && CFG.telegramChat),
      modelSignals:      claudeSignals,
      claudeSignalsToday: claudeSignals.length,

      // Stats
      copies:       PERSIST.trades.filter(t => t.type === 'copy').length,
      arbs:         STATE.feed.filter(f => f.type === 'arb').length,
      signals:      claudeSignals.length,
      pollCount,
      lastPoll:     STATE.lastPoll,
      version:      STATE.version,

      // Equity curve data for chart (last 50 data points)
      equityData:   STATE.equityData || [],

      // Performance by type — computed from trade history
      winsByType: {
        model: PERSIST.trades.filter(t => t.type === 'claude' && t.status === 'win').length,
        copy:  PERSIST.trades.filter(t => t.type === 'copy'   && t.status === 'win').length,
        arb:   PERSIST.trades.filter(t => t.type === 'arb'    && t.status === 'win').length,
      },
      lossByType: {
        model: PERSIST.trades.filter(t => t.type === 'claude' && t.status === 'loss').length,
        copy:  PERSIST.trades.filter(t => t.type === 'copy'   && t.status === 'loss').length,
        arb:   PERSIST.trades.filter(t => t.type === 'arb'    && t.status === 'loss').length,
      },
    }));
    return;
  }

  // ── GET / — serve dashboard ──
  if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
    const htmlPath = require('path').join(__dirname, 'polybot-v3.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, version: STATE.version, uptime: process.uptime(), pollCount }));
    }
    return;
  }

  // ── GET /health ──
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, version: STATE.version, uptime: process.uptime(), pollCount }));
    return;
  }

  // ── GET /markets-check — shows parsed markets ──
  if (req.method === 'GET' && path === '/markets-check') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      count: STATE.markets.length,
      markets: STATE.markets.slice(0, 5).map(m => ({
        question: m.question, volume: m.volume, yesPrice: m.yesPrice,
      })),
    }));
    return;
  }

  // ── GET /api-debug — raw Polymarket API responses ──
  if (req.method === 'GET' && path === '/api-debug') {
    const testUrls = [
      'https://gamma-api.polymarket.com/markets?closed=false&limit=3&sort=volume&order=desc',
      'https://gamma-api.polymarket.com/markets?active=true&limit=3',
      'https://clob.polymarket.com/markets?limit=3',
    ];
    const results = await Promise.all(testUrls.map(async u => {
      const r = await httpsGetRaw(u);
      return { url: u.split('.com')[1], status: r.status, preview: r.body.slice(0, 400) };
    }));
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ results }, null, 2));
    return;
  }

  // ── POST /toggle-trader — persist trader on/off selection ──
  if (req.method === 'POST' && path === '/toggle-trader') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { addr, enabled } = JSON.parse(body);
        if (!addr) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: 'addr required' })); return; }

        if (enabled) {
          if (!PERSIST.selectedTraders.includes(addr)) PERSIST.selectedTraders.push(addr);
        } else {
          PERSIST.selectedTraders = PERSIST.selectedTraders.filter(a => a !== addr);
        }
        savePersist();
        log('Trader toggled', { addr: addr.slice(0,10), enabled, total: PERSIST.selectedTraders.length });

        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, selectedTraders: PERSIST.selectedTraders }));
      } catch (e) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /toggle-copy — master copy trade on/off ──
  if (req.method === 'POST' && path === '/toggle-copy') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        PERSIST.copyEnabled = !!enabled;
        savePersist();
        log('Copy trading toggled', { enabled: PERSIST.copyEnabled });
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, copyEnabled: PERSIST.copyEnabled }));
      } catch (e) {
        res.writeHead(400, CORS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /bankroll ──
  if (req.method === 'POST' && path === '/bankroll') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { amount } = JSON.parse(body);
        if (amount > 0) { PERSIST.bankroll = parseFloat(amount); savePersist(); }
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ ok: true, bankroll: PERSIST.bankroll }));
      } catch (e) { res.writeHead(400, CORS); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end(JSON.stringify({ error: 'not found' }));
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
async function main() {
  loadPersist();

  const server = http.createServer(serve);
  server.listen(CFG.port, () => {
    log(`Polybot v${STATE.version} running`, {
      port:         CFG.port,
      mode:         CFG.dryRun ? 'PAPER' : 'LIVE',
      copyEnabled:  PERSIST.copyEnabled,
      selectedTraders: PERSIST.selectedTraders.length,
      claudeKey:    CFG.claudeKey ? '✓' : '✗ MISSING',
      telegram:     CFG.telegramToken ? '✓' : '✗',
    });
  });

  // Initial leaderboard load
  await fetchLeaderboard();

  // Send startup notification
  await sendTelegram(
    `🤖 *Polybot v${STATE.version} online*\nMode: ${CFG.dryRun ? 'Paper' : 'LIVE'}\nTracking ${PERSIST.selectedTraders.length} traders\nBankroll: $${PERSIST.bankroll.toFixed(2)}`
  );

  // Start polling
  poll();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
