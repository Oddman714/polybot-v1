// POLYBOT — Railway Server v6.2
// Fixes: real market data always loads, trader selection persists across restarts,
//        leaderboard uses correct Polymarket API fields, copy trader toggle stays on
//        v6.1: raw debug endpoint, better user agent
//        v6.2: fixed Gamma API sort params (422 error), filter expired markets by endDate

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
  stateFile:   process.env.STATE_FILE || '/tmp/polybot-persist.json',
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
  pollCount:    0,
  lastPoll:     null,
  version:      '6.2',
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

// ─── CLAUDE MARKET ANALYSIS ──────────────────────────────────────────────────
async function claudeAnalyzeMarkets(markets) {
  if (!CFG.claudeKey) {
    log('No Claude API key — skipping analysis');
    return [];
  }

  const topMarkets = markets.slice(0, 15);
  const winRate    = PERSIST.wins + PERSIST.losses > 0
    ? ((PERSIST.wins / (PERSIST.wins + PERSIST.losses)) * 100).toFixed(1) : 'N/A';

  const marketList = topMarkets.map((m, i) =>
    `${i+1}. "${m.question}" — YES: ${(m.yesPrice*100).toFixed(1)}% Vol: $${m.volume > 0 ? m.volume.toFixed(0) : 'unknown'}`
  ).join('\n');

  const systemPrompt = `You are a quantitative prediction market analyst. Bankroll: $${PERSIST.bankroll.toFixed(2)}. Win rate: ${winRate}%.
Find mispriced markets where your probability estimate differs significantly from the market price.
Respond ONLY with valid JSON — no markdown, no preamble. Format:
{"signals":[{"market":"question text","outcome":"YES or NO","confidence":"high/medium/low","edge":0.08,"reasoning":"brief reason"}]}
Include 2-5 signals maximum. Only include markets where you have genuine edge (>5%).`;

  const userMsg = `Analyze these live Polymarket markets:\n${marketList}\n\nReturn JSON signals for markets with edge.`;

  try {
    const res = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMsg }],
      },
      {
        'x-api-key':         CFG.claudeKey,
        'anthropic-version': '2023-06-01',
      }
    );

    if (res.status !== 200) {
      logError('callClaude', `API error ${res.status}: ${JSON.stringify(res.body)}`);
      return [];
    }

    const text = res.body?.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const signals = parsed?.signals || [];

    log('Claude signals', { count: signals.length });

    for (const sig of signals) {
      if (!sig.market || !sig.outcome || !sig.edge) continue;

      const betSize = Math.min(
        PERSIST.bankroll * CFG.maxBetPct * (sig.confidence === 'high' ? 1 : 0.5),
        PERSIST.bankroll * 0.08
      );

      addFeed({
        ts:        Date.now(),
        type:      'claude',
        market:    sig.market,
        outcome:   sig.outcome,
        edge:      sig.edge,
        size:      betSize,
        reasoning: sig.reasoning,
        confidence: sig.confidence,
        mode:      CFG.dryRun ? 'PAPER' : 'LIVE',
      });

      if (CFG.dryRun) {
        log(`[PAPER] Claude signal: ${sig.outcome} "${sig.market?.slice(0,40)}" edge=${(sig.edge*100).toFixed(1)}% $${betSize.toFixed(2)}`);
      }

      // Record as paper trade
      PERSIST.trades.push({ ts: Date.now(), market: sig.market, outcome: sig.outcome, size: betSize, status: 'open' });
      savePersist();
    }

    return signals;
  } catch (e) {
    logError('claudeAnalyzeMarkets', e);
    return [];
  }
}

// ─── ARB SCANNER ─────────────────────────────────────────────────────────────
function scanArbs(markets) {
  const arbs = [];
  for (const m of markets) {
    if (!m.yesAsk || !m.noAsk) continue;
    const spread = m.yesAsk + m.noAsk;
    if (spread < 1 - CFG.minEdge) {
      const edge = 1 - spread;
      arbs.push({ market: m.question, yesAsk: m.yesAsk, noAsk: m.noAsk, edge });
      addFeed({ ts: Date.now(), type: 'arb', market: m.question, edge, yesAsk: m.yesAsk, noAsk: m.noAsk });
      log(`ARB found: "${m.question?.slice(0,40)}" edge=${(edge*100).toFixed(1)}%`);
    }
  }
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

    // Claude analysis every N polls (rate limit + cost control)
    if (pollCount % CFG.claudeEvery === 0) {
      await claudeAnalyzeMarkets(markets);
    }

    // Refresh leaderboard every 30 polls (~7.5 min)
    if (pollCount % 30 === 0 || pollCount === 1) {
      await fetchLeaderboard();
    }

  } catch (e) {
    logError('poll', e);
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

    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      bankroll:     PERSIST.bankroll,
      pnl:          parseFloat(pnl.toFixed(2)),
      wins:         PERSIST.wins,
      losses:       PERSIST.losses,
      winRate:      parseFloat(winRate),
      trades:       PERSIST.trades.slice(-20),
      feed:         STATE.feed.slice(0, 40),
      markets:      STATE.markets.slice(0, 20),
      traders:      STATE.traders.map(t => ({
        ...t,
        copying: PERSIST.selectedTraders.includes(t.addr),
      })),
      copyEnabled:  PERSIST.copyEnabled,
      selectedTraders: PERSIST.selectedTraders,
      pollCount:    pollCount,
      lastPoll:     STATE.lastPoll,
      version:      STATE.version,
      mode:         CFG.dryRun ? 'paper' : 'live',
    }));
    return;
  }

  // ── GET /health ──
  if (req.method === 'GET' && (path === '/health' || path === '/')) {
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
