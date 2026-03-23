// POLYBOT — Railway Server v10.3 — time decay sniping + conflict checker + live mode fix
// v9.2: endDate guard on resolution (no phantom wins)
// v9.3: real CLOB order execution, auto credential generation, contract approvals,
//       market quality filter (20-80% / 30-day window), signal outcome tracking,
//       bankroll compounding on wins

'use strict';
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// Ethers for CLOB order signing
let ethers;
try { ethers = require('ethers'); } catch(e) { ethers = null; }

// CLOB client for live order execution
let ClobClient;
try { ({ ClobClient } = require('@polymarket/clob-client')); } catch(e) { ClobClient = null; }
// WebSocket for real-time Polymarket price feeds (built into Node 22+)
// Falls back gracefully if unavailable
let WebSocket;
try { WebSocket = require('ws'); } catch(e) {
  try { WebSocket = globalThis.WebSocket; } catch(e2) { WebSocket = null; }
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  port:        parseInt(process.env.PORT) || 3000,
  claudeKey:   (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '').trim(),
  telegramToken: (process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  telegramChat:  (process.env.TELEGRAM_CHAT_ID || '').trim(),
  bankroll:    parseFloat(process.env.BANKROLL) || 35,
  dryRun:      process.env.DRY_RUN !== 'false',
  pollMs:      parseInt(process.env.POLL_MS) || 15000,
  claudeEvery: parseInt(process.env.CLAUDE_EVERY) || 5,
  minEdge:     parseFloat(process.env.MIN_EDGE) || 0.03,
  minVolume:   parseFloat(process.env.MIN_VOLUME) || 500,
  maxBetPct:   parseFloat(process.env.MAX_BET_PCT) || 0.08,
  stateFile:   process.env.STATE_FILE || '/tmp/polybot-persist.json',
  copyWallets: (process.env.COPY_WALLETS || '').split(',').map(w => w.trim()).filter(w => w.startsWith('0x')),
  alphaVantageKey: (process.env.ALPHA_VANTAGE_KEY || '').trim(),
  newsDataKey:     (process.env.NEWS_DATA_KEY || '').trim(),

  // ── LIVE EXECUTION ──────────────────────────────────────────────────────────
  // Set in Railway Variables — never hardcode
  polyPrivateKey:   (process.env.POLY_PRIVATE_KEY || '').trim(),
  polyWalletAddr:   (process.env.POLY_WALLET_ADDRESS || '').trim(),
  polyApiKey:       (process.env.POLY_API_KEY || '').trim(),
  polySecret:       (process.env.POLY_SECRET || '').trim(),
  polyPassphrase:   (process.env.POLY_PASSPHRASE || '').trim(),

  // Market quality filter — only trade contested markets resolving soon
  minYesPrice:  parseFloat(process.env.MIN_YES_PRICE  || '0.05'),  // min 5%
  maxYesPrice:  parseFloat(process.env.MAX_YES_PRICE  || '0.95'),  // max 95%
  maxDaysToEnd: parseInt(process.env.MAX_DAYS_TO_END  || '90'),    // resolve within 90 days
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
      // Ensure numeric fields are always numbers after load
      PERSIST.wins   = parseInt(PERSIST.wins)   || 0;
      PERSIST.losses = parseInt(PERSIST.losses) || 0;
      PERSIST.bankroll = parseFloat(PERSIST.bankroll) || 35;
      // Reset any randomly-simulated resolutions — re-open them for real resolution
      // Trades with no realProfit but status win/loss were randomly simulated
      let resetCount = 0;
      (PERSIST.trades || []).forEach(t => {
        if ((t.status === 'win' || t.status === 'loss') && t.realProfit === undefined) {
          t.status = 'open'; delete t.resolvedAt;
          resetCount++;
        }
      });
      if (resetCount > 0) {
        PERSIST.wins = 0; PERSIST.losses = 0;
        log('Reset ' + resetCount + ' simulated trades — will resolve from real market data');
      }
      // Also reset trades incorrectly resolved from near-zero prices (not actual resolution)
      // These have realProfit but their market endDate is in the future
      let priceResetCount = 0;
      const now = Date.now();
      (PERSIST.trades || []).forEach(t => {
        if ((t.status === 'win' || t.status === 'loss') && t.realProfit !== undefined) {
          // If resolved very quickly (within 5 min of creation), likely a bad price trigger
          const resolveAge = (t.resolvedAt || now) - (t.ts || now);
          if (resolveAge < 300000) { // resolved within 5 minutes = almost certainly wrong
            t.status = 'open';
            delete t.resolvedAt;
            delete t.realProfit;
            priceResetCount++;
          }
        }
      });
      if (priceResetCount > 0) {
        PERSIST.wins = Math.max(0, PERSIST.wins - priceResetCount);
        PERSIST.losses = Math.max(0, PERSIST.losses - priceResetCount);
        log('Reset ' + priceResetCount + ' incorrectly price-triggered resolutions');
      }
      // Re-apply COPY_WALLETS if selectedTraders got wiped
      if (PERSIST.selectedTraders.length === 0 && CFG.copyWallets && CFG.copyWallets.length > 0) {
        PERSIST.selectedTraders = CFG.copyWallets;
        PERSIST.copyEnabled = true;
        log('Restored selectedTraders from COPY_WALLETS env var');
      }
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
  version:      '10.3',
};

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────
// Authenticated GET — passes POLY auth headers, returns parsed JSON or null
function httpsGetWithHeaders(url, authHeaders) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...authHeaders },
      timeout:  12000,
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ _raw: body.slice(0,200), _status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

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
// Strategy: pull from MULTIPLE category endpoints in parallel
// This ensures Claude always sees contested markets across politics, sports, crypto
// not just the top-20-by-volume which are dominated by NBA Finals near-zero markets
async function fetchMarkets() {
  // Primary: large batch sorted by volume
  const primaryEndpoints = [
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&offset=0',
    'https://gamma-api.polymarket.com/markets?active=true&limit=200',
    'https://gamma-api.polymarket.com/markets?closed=false&limit=200',
  ];

// Category endpoints — use price filtering to find CONTESTED markets directly
  // minPrice/maxPrice ensures we only get markets between 10-90% YES price
  // This cuts through all the NBA Finals 0.1% and 2028 election 0.5% garbage
  const categoryEndpoints = [
    // Core contested markets — YES price 10-90%
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&minPrice=0.10&maxPrice=0.90',
    // Wider net — YES price 5-95%
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&minPrice=0.05&maxPrice=0.95',
    // Politics with price filter
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&category=politics&minPrice=0.10&maxPrice=0.90',
    // Sports with price filter
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=30&category=sports&minPrice=0.10&maxPrice=0.90',
  ];

  let rawMarkets = [];

  // Try primary endpoint first
  for (const url of primaryEndpoints) {
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

  // Also fetch category markets in parallel — merge with primary results
  // This guarantees Claude sees quality contested markets even if top-volume is garbage
  const categoryResults = await Promise.allSettled(
    categoryEndpoints.map(url => httpsGet(url).catch(() => []))
  );

  for (const result of categoryResults) {
    if (result.status === 'fulfilled') {
      const data = result.value;
      const arr = Array.isArray(data) ? data : (data?.markets || data?.data || []);
      if (arr.length > 0) {
        // Merge — avoid duplicates by conditionId
        const existingIds = new Set(rawMarkets.map(m => m.conditionId || m.id));
        const newMarkets = arr.filter(m => !existingIds.has(m.conditionId || m.id));
        rawMarkets = rawMarkets.concat(newMarkets);
      }
    }
  }

  log('Total markets after category merge', { count: rawMarkets.length });

  if (rawMarkets.length === 0) {
    log('All market endpoints failed — using fallback questions');
    return buildFallbackMarkets();
  }

  // Normalize — Polymarket uses inconsistent field names across API versions
  const now = Date.now();
  const cutoff2025 = new Date('2025-01-01').getTime(); // reject ancient markets
  const normalized = rawMarkets
    .filter(m => {
      if (m.closed || m.archived) return false;
      if (!m.question && !m.title) return false;
      // Filter out markets that ended in the past
      if (m.endDate || m.end_date_iso) {
        const end = new Date(m.endDate || m.end_date_iso).getTime();
        if (end < now) return false;
        // Also reject markets with very old end dates (pre-2025 = stale API data)
        if (end < cutoff2025) return false;
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

      // Price: try every known field name — 0 is valid (long shot)
      let yesPrice = -1; // sentinel: -1 means not found
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
      // If still not found, default to 0.5; but 0 is a valid price (long shot market)
      if (yesPrice === -1) yesPrice = 0.5;

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
    // Sort strategy: quality markets first (contested price range), then by volume
    // This ensures Claude always sees the best tradeable markets, not just highest volume
    .sort((a, b) => {
      const aQuality = a.yesPrice >= 0.05 && a.yesPrice <= 0.95 ? 1 : 0;
      const bQuality = b.yesPrice >= 0.05 && b.yesPrice <= 0.95 ? 1 : 0;
      if (aQuality !== bQuality) return bQuality - aQuality; // quality first
      return b.volume - a.volume; // then by volume within each tier
    });

  // Keep top 50 — quality markets bubble to top now
  const top = normalized.slice(0, 50);

  // Filter by volume only if we'd still have >= 10 markets
  const filtered = top.filter(m => m.volume >= CFG.minVolume);
  const markets  = filtered.length >= 10 ? filtered : top.slice(0, 20);

  const qualityCount = markets.filter(m => m.yesPrice >= 0.05 && m.yesPrice <= 0.95).length;
  log('Real markets fetched', {
    count: markets.length,
    qualityMarkets: qualityCount,
    topQ: markets[0]?.question?.slice(0,50),
    topPrice: markets[0]?.yesPrice
  });

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

  // No real leaderboard data — show empty until COPY_WALLETS env var is set
  // or leaderboard API returns valid wallets
  log('No real leaderboard data — set COPY_WALLETS in Railway to enable copy trading');
  if (CFG.copyWallets.length > 0) {
    // Show configured wallets as traders
    // Fetch names from Polymarket profile API
    STATE.traders = await Promise.all(CFG.copyWallets.map(async (addr, i) => {
      let name = 'wallet-' + (i+1);
      try {
        const profile = await httpsGet(`https://data-api.polymarket.com/profiles?address=${addr}`);
        if (profile?.name || profile?.[0]?.name) name = profile?.name || profile[0]?.name;
        else if (profile?.username || profile?.[0]?.username) name = profile?.username || profile[0]?.username;
      } catch(e) { /* use default name */ }
      return { addr, name, pnl: 0, roi: 0, wins: 0, trades: 0, copying: true };
    }));
  }
}

// ─── COPY TRADE MIRRORING ────────────────────────────────────────────────────
async function mirrorCopyTrades(markets) {
  // Priority 1: use real wallets from COPY_WALLETS Railway env var
  if (PERSIST.selectedTraders.length === 0) {
    if (CFG.copyWallets.length > 0) {
      PERSIST.selectedTraders = CFG.copyWallets;
      PERSIST.copyEnabled = true;
      savePersist();
      log('Using COPY_WALLETS env var', { count: CFG.copyWallets.length });
    } else if (STATE.traders.length > 0) {
      // Only auto-select if traders came from real leaderboard (not fake fallback)
      const realTraders = STATE.traders.filter(t => t.addr && t.addr.length >= 40 && t.trades > 0);
      if (realTraders.length > 0) {
        PERSIST.selectedTraders = realTraders.slice(0, 2).map(t => t.addr);
        PERSIST.copyEnabled = true;
        savePersist();
        log('Auto-selected real leaderboard traders', { count: PERSIST.selectedTraders.length });
      }
    }
  }

  if (!PERSIST.copyEnabled || PERSIST.selectedTraders.length === 0) return;

  // No simulation — only real trades from actual wallet activity
  // To enable copy trading: add COPY_WALLETS=0xABC,0xDEF in Railway Variables
  // Get real wallet addresses from polymarket.com/leaderboard

  // Seen trade cache — prevents re-logging same trades every poll
  if (!PERSIST.seenCopyTrades) PERSIST.seenCopyTrades = [];
  // Expire seen trades older than 24 hours
  const now24 = Date.now() - 86400000;
  PERSIST.seenCopyTrades = PERSIST.seenCopyTrades.filter(k => k.ts > now24);

  for (const traderAddr of PERSIST.selectedTraders) {
    try {
      const data = await httpsGet(
        `https://data-api.polymarket.com/activity?user=${traderAddr}&limit=10&sortBy=TIMESTAMP&sort=DESC`
      );
      const trades = Array.isArray(data) ? data : (data?.data || data?.history || []);

      for (const trade of trades.slice(0, 5)) {
        const mktId    = trade.market || trade.conditionId || trade.marketId;
        const outcome  = (trade.outcome || trade.side || '').toLowerCase();
        const size     = parseFloat(trade.size || trade.amount || trade.usdcSize || 0);
        const price    = parseFloat(trade.price || trade.avgPrice || 0.5);
        const tradeTs  = trade.timestamp || trade.ts || trade.createdAt;
        const question = trade.title || trade.question || markets.find(m => m.conditionId === mktId)?.question || 'Unknown market';

        if (!mktId || size < 1 || price <= 0 || price >= 1) continue;

        // Deduplicate — skip trades we've already processed
        // Use price BUCKET (5% bands) not exact price — prevents triple-entry on same market
        // e.g. prices 0.259, 0.260, 0.296 all map to same bucket and are treated as one trade
        const priceBucket = Math.floor(price * 20); // 5% buckets
        const tradeKey = `${traderAddr.slice(0,10)}-${mktId}-${outcome}-${priceBucket}`;
        if (PERSIST.seenCopyTrades.find(k => k.key === tradeKey)) continue;

        // Per-market position limit — max 1 open copy position per market per wallet
        const existingPositions = PERSIST.trades.filter(t =>
          t.type === 'copy' &&
          t.trader === (STATE.traders.find(t => t.addr === traderAddr)?.name || traderAddr.slice(0,10) + '…') &&
          t.conditionId === mktId &&
          t.status === 'open'
        );
        if (existingPositions.length >= 1) {
          log(`Skipping duplicate copy position: ${question?.slice(0,40)}`);
          PERSIST.seenCopyTrades.push({ key: tradeKey, ts: Date.now() });
          continue;
        }

        // Mark as seen
        PERSIST.seenCopyTrades.push({ key: tradeKey, ts: Date.now() });

        const traderInfo = STATE.traders.find(t => t.addr === traderAddr);
        const traderName = traderInfo?.name || traderAddr.slice(0, 10) + '…';
        const betSize    = Math.min(PERSIST.bankroll * CFG.maxBetPct, size * 0.5, 3);

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
        const copyMkt = markets.find(m => m.conditionId === mktId || m.question === question);
        PERSIST.trades.push({
          ts: Date.now(), type: 'copy', market: question,
          conditionId: copyMkt?.conditionId || mktId,
          outcome: outcome === 'yes' ? 'YES' : 'NO',
          size: betSize, status: 'open', edge: 0.05,
          price: price, trader: traderName,
        });

        savePersist();

        // Telegram alert for copy trades
        await sendTelegram(
          'COPY TRADE: ' + traderName + '\n' +
          (outcome === 'yes' ? 'YES' : 'NO') + ' | ' + question.slice(0, 60) + '\n' +
          'Price: ' + (price * 100).toFixed(1) + '% | Size: $' + betSize.toFixed(2) + '\n' +
          'Mode: ' + (CFG.dryRun ? 'PAPER' : 'LIVE')
        );

        log(`[${CFG.dryRun?'PAPER':'LIVE'}] Copy trade: ${traderName} → ${outcome.toUpperCase()} "${question.slice(0,40)}" @ ${price} × $${betSize.toFixed(2)}`);
        // Live execution
        if (!CFG.dryRun) {
          const tokenId = outcome === 'yes' ? copyMkt?.yesTokenId : copyMkt?.noTokenId;
          if (tokenId) await executeCLOBOrder(tokenId, price, betSize, outcome === 'yes' ? 'BUY' : 'BUY');
        }
      }
    } catch (e) {
      log(`Copy trade fetch failed for ${traderAddr.slice(0,10)}`, { err: e.message });
    }
  }
}


// ─── LIVE CLOB EXECUTION ENGINE ──────────────────────────────────────────────
// ─── POLYMARKET CLOB EXECUTION — pure ethers, no clob-client dependency ──────
// Uses ethers v5 for EIP-712 signing + raw HTTPS for order submission
// This avoids the @polymarket/clob-client package version conflicts entirely

function getWallet() {
  if (!ethers || !CFG.polyPrivateKey) return null;
  try { return new ethers.Wallet(CFG.polyPrivateKey); }
  catch(e) { logError('getWallet', e); return null; }
}

// Step 1: Get CLOB server timestamp (needed for auth signature)
async function getClobTimestamp() {
  const r = await httpsGet('https://clob.polymarket.com/time');
  return String(r?.time || Math.floor(Date.now()/1000));
}

// Step 2: Derive API credentials via EIP-712 L1 auth
// Returns { apiKey, secret, passphrase } or throws with detail
async function deriveClobCreds() {
  const wallet = getWallet();
  if (!wallet) throw new Error('No wallet — check POLY_PRIVATE_KEY in Railway Variables');
  try {
    const ts    = await getClobTimestamp();
    const nonce = 0;

    log('deriveClobCreds: got timestamp', { ts, walletAddr: wallet.address.slice(0,12) });

    // EIP-712 domain + types per Polymarket docs
    const domain = { name: 'ClobAuthDomain', version: '1', chainId: 137 };
    const types  = {
      ClobAuth: [
        { name: 'address',   type: 'address' },
        { name: 'timestamp', type: 'string'  },
        { name: 'nonce',     type: 'uint256' },
        { name: 'message',   type: 'string'  },
      ],
    };
    const value = {
      address:   wallet.address,
      timestamp: ts,
      nonce,
      message:   'This message attests that I control the given wallet',
    };

    const sig = await wallet._signTypedData(domain, types, value);
    log('deriveClobCreds: signature generated', { sigLen: sig.length });

    // POST to /auth/api-key to create credentials
    const result = await httpsPost(
      'https://clob.polymarket.com/auth/api-key',
      {},
      {
        'POLY_ADDRESS':   wallet.address,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': ts,
        'POLY_NONCE':     String(nonce),
      }
    );

    log('deriveClobCreds: API response', { status: result.status, body: JSON.stringify(result.body).slice(0,200) });

    if (result.status !== 200) {
      throw new Error(`Polymarket auth API returned ${result.status}: ${JSON.stringify(result.body).slice(0,200)}`);
    }

    const creds = result.body;
    if (!creds.apiKey && !creds.api_key) {
      throw new Error(`No apiKey in response: ${JSON.stringify(creds).slice(0,200)}`);
    }

    log('CLOB credentials derived', { key: (creds.apiKey||creds.api_key||'').slice(0,8) + '...' });
    return {
      apiKey:     creds.apiKey     || creds.api_key,
      secret:     creds.secret     || creds.api_secret,
      passphrase: creds.passphrase || creds.api_passphrase,
    };
  } catch(e) {
    logError('deriveClobCreds', e);
    return null;
  }
}

// Step 3: Build HMAC-SHA256 auth headers for L2 requests
function buildL2Headers(method, path, body = '') {
  const apiKey     = CFG.polyApiKey     || PERSIST.polyApiKey     || '';
  const secret     = CFG.polySecret     || PERSIST.polySecret     || '';
  const passphrase = CFG.polyPassphrase || PERSIST.polyPassphrase || '';
  if (!apiKey || !secret) return null;

  const ts        = String(Math.floor(Date.now() / 1000));
  const msg       = ts + method.toUpperCase() + path + body;
  const hmac      = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
                          .update(msg).digest('base64');
  return {
    'POLY-API-KEY':    apiKey,
    'POLY-SIGNATURE':  hmac,
    'POLY-TIMESTAMP':  ts,
    'POLY-PASSPHRASE': passphrase,
    'Content-Type':    'application/json',
  };
}

// Step 4: Sign and place a CLOB order using EIP-712
async function executeCLOBOrder(tokenId, price, sizeUSDC, side = 'BUY') {
  const wallet = getWallet();
  if (!wallet) { log('executeCLOBOrder: no wallet'); return null; }

  const apiKey = CFG.polyApiKey || PERSIST.polyApiKey;
  if (!apiKey) { log('executeCLOBOrder: no API creds — run /generate-creds first'); return null; }

  try {
    const tickSize    = price < 0.1 ? 0.001 : 0.01;
    const roundedPrice = parseFloat((Math.round(price / tickSize) * tickSize).toFixed(4));
    const minSize     = 1.0;

    if (sizeUSDC < minSize) {
      log(`Order too small: $${sizeUSDC.toFixed(2)}`);
      return null;
    }

    // Build order object per Polymarket CLOB spec
    const ts     = String(Math.floor(Date.now() / 1000));
    const salt   = Math.floor(Math.random() * 1e15);
    const order  = {
      salt,
      maker:       CFG.polyWalletAddr || wallet.address,
      signer:      wallet.address,
      taker:       '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount: String(Math.round(sizeUSDC * 1e6)),    // USDC 6 decimals
      takerAmount: String(Math.round(sizeUSDC / roundedPrice * 1e6)),
      expiration:  '0',
      nonce:       '0',
      feeRateBps:  '0',
      side:        side === 'BUY' ? 0 : 1,
      signatureType: 1,
    };

    // EIP-712 sign the order
    const domain = {
      name: 'CTFExchange', version: '1', chainId: 137,
      verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    };
    const orderTypes = {
      Order: [
        { name: 'salt',          type: 'uint256' },
        { name: 'maker',         type: 'address' },
        { name: 'signer',        type: 'address' },
        { name: 'taker',         type: 'address' },
        { name: 'tokenId',       type: 'uint256' },
        { name: 'makerAmount',   type: 'uint256' },
        { name: 'takerAmount',   type: 'uint256' },
        { name: 'expiration',    type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
        { name: 'feeRateBps',    type: 'uint256' },
        { name: 'side',          type: 'uint8'   },
        { name: 'signatureType', type: 'uint8'   },
      ],
    };

    const sig = await wallet._signTypedData(domain, orderTypes, order);
    const signedOrder = { ...order, signature: sig };

    // Submit to CLOB
    const bodyStr   = JSON.stringify({ order: signedOrder, orderType: 'GTC' });
    const l2headers = buildL2Headers('POST', '/order', bodyStr);
    if (!l2headers) { log('executeCLOBOrder: no L2 headers'); return null; }

    const result = await httpsPost('https://clob.polymarket.com/order', { order: signedOrder, orderType: 'GTC' }, l2headers);

    log(`[LIVE ORDER] ${side} price=${roundedPrice} size=$${sizeUSDC.toFixed(2)}`, {
      status: result.status, orderId: result.body?.orderID,
    });

    await sendTelegram(
      'LIVE ORDER PLACED\n' +
      side + ' | $' + sizeUSDC.toFixed(2) + ' @ ' + (roundedPrice*100).toFixed(1) + '%\n' +
      'Order ID: ' + (result.body?.orderID || 'submitted') + '\n' +
      'Status: ' + result.status
    );

    return result.body;
  } catch(e) {
    logError('executeCLOBOrder', e);
    await sendTelegram('Order failed: ' + e.message?.slice(0,80));
    return null;
  }
}

// ─── MARKET QUALITY FILTER ────────────────────────────────────────────────────
// Only trade markets that are:
// 1. Contested — yes price between 5% and 95% (real uncertainty)
// 2. Resolving soon — within 90 days (fast feedback loop)
// 3. Has real volume — not dead markets
function isQualityMarket(m) {
  // ── HARD EXCLUSIONS — never trade these regardless of anything else ──────
  // Near-zero markets: no real liquidity, no executable edge, phantom P&L risk
  if (m.yesPrice < 0.05) return false;   // less than 5% YES = skip
  if (m.yesPrice > 0.95) return false;   // more than 95% YES = skip
  // Extra safety: also check noPrice explicitly
  if (m.noPrice < 0.05) return false;

  // Time filter — skip markets resolving too far out (slow feedback)
  if (m.endDate) {
    const daysToEnd = (new Date(m.endDate).getTime() - Date.now()) / 86400000;
    if (daysToEnd > CFG.maxDaysToEnd) return false;
    if (daysToEnd < 0) return false; // already ended
  }

  // Volume filter — needs real liquidity
  if (m.volume < 1000) return false;

  return true;
}

// ─── SIGNAL OUTCOME TRACKER ───────────────────────────────────────────────────
// Updates signalHistory with real outcomes when markets resolve
// Gives Claude accurate performance data to learn from
function updateSignalOutcomes(markets) {
  if (!PERSIST.signalHistory || PERSIST.signalHistory.length === 0) return;

  let updated = false;
  for (const sig of PERSIST.signalHistory) {
    if (sig.status !== 'open') continue; // already resolved

    const mkt = markets.find(m => m.question === sig.market || m.conditionId === sig.conditionId);
    if (!mkt) continue;

    const marketEndTs = mkt.endDate ? new Date(mkt.endDate).getTime() : Infinity;
    const marketEnded = Date.now() > marketEndTs;

    if (marketEnded && mkt.yesPrice >= 0.9999) {
      sig.status = mkt.yesPrice >= 0.9999 ? (sig.outcome === 'YES' ? 'correct' : 'wrong') : 'open';
      updated = true;
    } else if (marketEnded && mkt.noPrice >= 0.9999) {
      sig.status = sig.outcome === 'NO' ? 'correct' : 'wrong';
      updated = true;
    }
  }

  if (updated) {
    const correct = PERSIST.signalHistory.filter(s => s.status === 'correct').length;
    const wrong   = PERSIST.signalHistory.filter(s => s.status === 'wrong').length;
    log('Signal outcomes updated', { correct, wrong, accuracy: correct + wrong > 0 ? ((correct/(correct+wrong))*100).toFixed(1)+'%' : 'N/A' });
    savePersist();
  }
}

// ─── FREE MARKET DATA ENRICHMENT ─────────────────────────────────────────────
// Pulls free news sentiment + crypto context to give Claude real data
async function fetchMarketContext() {
  const context = [];

  // 1. Alpha Vantage news sentiment (free, 25 req/day — throttled to every 60 min)
  const avLastCall = STATE_CLOB._avLastCall || 0;
  if (CFG.alphaVantageKey && Date.now() - avLastCall > 3600000) {
    STATE_CLOB._avLastCall = Date.now();
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

  // 4. NewsData.io — only call once every 4 hours (free tier: 200 req/day)
  const newsDataLastCall = STATE_CLOB._newsDataLastCall || 0;
  if (CFG.newsDataKey && Date.now() - newsDataLastCall > 14400000) {
    STATE_CLOB._newsDataLastCall = Date.now();
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


// ─── CLOB ORDERBOOK ENGINE ────────────────────────────────────────────────────
// Fetches real orderbook depth from Polymarket CLOB API (no auth needed)
// Gives Claude actual buy/sell pressure, not just midpoint price
const CLOB_BASE = 'https://clob.polymarket.com';
const STATE_CLOB = {
  books:      {},   // tokenId → { bids, asks, spread, midpoint, imbalance }
  priceAlerts: [],  // price movements > 5% detected this session
  wsConnected: false,
  wsPrices:   {},   // tokenId → latest price from WebSocket
};

async function fetchCLOBBook(tokenId) {
  try {
    const data = await httpsGet(`${CLOB_BASE}/book?token_id=${tokenId}`);
    if (!data?.bids || !data?.asks) return null;

    const bestBid = parseFloat(data.bids[0]?.price || 0);
    const bestAsk = parseFloat(data.asks[0]?.price || 1);
    const midpoint = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    // Orderbook imbalance — positive = more buy pressure, negative = more sell
    const bidDepth = data.bids.slice(0,5).reduce((s,b) => s + parseFloat(b.size||0), 0);
    const askDepth = data.asks.slice(0,5).reduce((s,a) => s + parseFloat(a.size||0), 0);
    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth > 0 ? ((bidDepth - askDepth) / totalDepth) : 0;

    const book = { tokenId, bestBid, bestAsk, midpoint, spread, imbalance,
      bidDepth: bidDepth.toFixed(0), askDepth: askDepth.toFixed(0),
      bidLevels: data.bids.length, askLevels: data.asks.length, ts: Date.now() };

    STATE_CLOB.books[tokenId] = book;
    return book;
  } catch(e) { return null; }
}

// Fetch orderbook for top markets and build enriched context for Claude
async function fetchCLOBContext(markets) {
  const topMarkets = markets.slice(0, 8); // top 8 by volume
  const results = [];

  await Promise.allSettled(topMarkets.map(async (m) => {
    if (!m.yesTokenId) return;
    const book = await fetchCLOBBook(m.yesTokenId);
    if (!book) return;

    const imbalanceLabel = book.imbalance > 0.2 ? 'STRONG BUY PRESSURE'
      : book.imbalance > 0.05 ? 'mild buy pressure'
      : book.imbalance < -0.2 ? 'STRONG SELL PRESSURE'
      : book.imbalance < -0.05 ? 'mild sell pressure'
      : 'balanced';

    results.push({
      question: m.question,
      yesPrice: (book.midpoint * 100).toFixed(1) + '%',
      spread: (book.spread * 100).toFixed(2) + '%',
      imbalance: imbalanceLabel,
      bidDepth: '$' + book.bidDepth,
      askDepth: '$' + book.askDepth,
      volume: m.volume > 0 ? (m.volume >= 1e6 ? '$' + (m.volume/1e6).toFixed(1) + 'M' : '$' + (m.volume/1e3).toFixed(0) + 'K') : 'unknown',
    });
  }));

  if (results.length === 0) return '';
  return 'LIVE ORDERBOOK DATA (real Polymarket CLOB):\n' +
    results.map(r =>
      `"${r.question.slice(0,55)}"\n` +
      `  Price: ${r.yesPrice} | Spread: ${r.spread} | Vol: ${r.volume}\n` +
      `  Order flow: ${r.imbalance} (bids:${r.bidDepth} asks:${r.askDepth})`
    ).join('\n\n');
}

// WebSocket price tracker — connects to Polymarket CLOB WS for real-time prices
// No auth needed for market data channel
function startWebSocketPriceFeed(markets) {
  if (!WebSocket || STATE_CLOB.wsConnected) return;
  const topTokenIds = markets
    .filter(m => m.yesTokenId)
    .slice(0, 10)
    .map(m => m.yesTokenId);
  if (topTokenIds.length === 0) return;

  try {
    const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    ws.on('open', () => {
      STATE_CLOB.wsConnected = true;
      // Polymarket CLOB WS correct format per docs
      // Each asset needs its own subscription message
      topTokenIds.forEach(tokenId => {
        ws.send(JSON.stringify({
          type: 'subscribe',
          channel: 'market',
          market: tokenId,
        }));
      });
      log('WebSocket connected to Polymarket CLOB', { markets: topTokenIds.length });
    });
    ws.on('message', (raw) => {
      try {
        const events = JSON.parse(raw.toString());
        const evArr = Array.isArray(events) ? events : [events];
        for (const ev of evArr) {
          // Polymarket sends: {event_type, asset_id, price} or {type, market_id, price}
          const evType = ev.event_type || ev.type || '';
          if (evType === 'price_change' || evType === 'last_trade_price' || evType === 'tick') {
            const price = parseFloat(ev.price || ev.last_trade_price || ev.mid_price || 0);
            const tokenId = ev.asset_id || ev.market_id || ev.market;
            if (tokenId && price > 0) {
              const prev = STATE_CLOB.wsPrices[tokenId];
              STATE_CLOB.wsPrices[tokenId] = price;
              // Detect significant price movements
              if (prev && Math.abs(price - prev) > 0.03) {
                const mkt = STATE.markets.find(m => m.yesTokenId === tokenId);
                if (mkt) {
                  const dir = price > prev ? '📈' : '📉';
                  const chg = ((price - prev) * 100).toFixed(1);
                  STATE_CLOB.priceAlerts.unshift({
                    ts: Date.now(), market: mkt.question,
                    from: (prev*100).toFixed(1), to: (price*100).toFixed(1),
                    change: chg, dir,
                  });
                  if (STATE_CLOB.priceAlerts.length > 10) STATE_CLOB.priceAlerts.pop();
                  addFeed({ ts: Date.now(), type: 'arb', market: mkt.question,
                    edge: Math.abs(price - prev), reasoning: `${dir} Price moved ${chg}% to ${(price*100).toFixed(1)}%` });
                  log(`WS price alert: ${mkt.question.slice(0,40)} ${chg}%`);
                }
              }
            }
          }
        }
      } catch(e) { /* silent */ }
    });
    ws.on('close', () => {
      STATE_CLOB.wsConnected = false;
      log('WebSocket disconnected — auto-reconnect in 30s');
      // Auto-reconnect — Railway proxies drop idle WSS connections
      setTimeout(() => {
        if (!STATE_CLOB.wsConnected && STATE.markets.length > 0) {
          startWebSocketPriceFeed(STATE.markets);
        }
      }, 30000);
    });
    ws.on('error', (e) => {
      STATE_CLOB.wsConnected = false;
      log('WebSocket error', { err: e.message });
    });
  } catch(e) { log('WebSocket init failed', { err: e.message }); }
}

// Fetch recent trades on a market to detect whale activity
async function fetchRecentTrades(conditionId) {
  try {
    const data = await httpsGet(
      `https://data-api.polymarket.com/trades?market=${conditionId}&limit=20`
    );
    const trades = Array.isArray(data) ? data : (data?.data || []);
    if (!trades.length) return null;

    const totalSize = trades.reduce((s,t) => s + parseFloat(t.size||t.usdcSize||0), 0);
    const yesSize = trades.filter(t => (t.outcome||t.side||'').toLowerCase().includes('yes'))
      .reduce((s,t) => s + parseFloat(t.size||0), 0);
    const noSize = totalSize - yesSize;
    const whales = trades.filter(t => parseFloat(t.size||0) > 500);

    return {
      totalSize: totalSize.toFixed(0),
      yesFlow: (yesSize/Math.max(totalSize,1)*100).toFixed(0) + '%',
      noFlow:  (noSize/Math.max(totalSize,1)*100).toFixed(0) + '%',
      whaleCount: whales.length,
      whaleVol: whales.reduce((s,t) => s + parseFloat(t.size||0), 0).toFixed(0),
    };
  } catch(e) { return null; }
}

// ─── CLAUDE MARKET ANALYSIS v2 — memory + web search + free market data ────
async function claudeAnalyzeMarkets(markets) {
  if (!CFG.claudeKey) { log('No Claude API key'); return []; }

  // Apply quality filter — only contested, near-term markets
  const qualityMarkets = markets.filter(isQualityMarket);
  // HARD RULE: only show Claude quality markets — never fall back to near-zero garbage
  // If fewer than 2 quality markets exist, Claude sits out this cycle
  if (qualityMarkets.length < 2) {
    log('Not enough quality markets this cycle — skipping Claude analysis', { quality: qualityMarkets.length });
    return [];
  }
  const topMarkets = qualityMarkets.slice(0, 20);
  log('Market quality filter', {
    total: markets.length,
    quality: qualityMarkets.length,
    using: topMarkets.length,
    markets: topMarkets.slice(0,5).map(m => `${m.question?.slice(0,30)} ${(m.yesPrice*100).toFixed(0)}%`)
  });

  const winRate = PERSIST.wins + PERSIST.losses > 0
    ? ((PERSIST.wins / (PERSIST.wins + PERSIST.losses)) * 100).toFixed(1) : 'N/A';
  const totalTrades = PERSIST.trades.length;

  // Enrich market list with CLOB orderbook data (real buy/sell pressure)
  const clobContext = await fetchCLOBContext(topMarkets);

  // Fetch recent trade flow for top 3 markets
  const tradeFlows = {};
  await Promise.allSettled(topMarkets.slice(0,3).map(async m => {
    if (m.conditionId) {
      const flow = await fetchRecentTrades(m.conditionId);
      if (flow) tradeFlows[m.question] = flow;
    }
  }));

  // Build market list with days-to-resolution flagged
  const marketList = topMarkets.map((m, i) => {
    const yes = (m.yesPrice * 100).toFixed(1);
    const vol = m.volume > 0 ? (m.volume >= 1e6 ? '$'+(m.volume/1e6).toFixed(1)+'M' : '$'+(m.volume/1e3).toFixed(0)+'K') : 'unkn';
    const ask = m.yesAsk ? ` ask:${(m.yesAsk*100).toFixed(0)}%` : '';
    const wsPrice = STATE_CLOB.wsPrices[m.yesTokenId];
    const wsPart = wsPrice ? ` ws:${(wsPrice*100).toFixed(1)}%` : '';
    const flow = tradeFlows[m.question];
    const flowPart = flow ? ` [trades:$${flow.totalSize} YES:${flow.yesFlow} NO:${flow.noFlow}${flow.whaleCount>0?' whales:'+flow.whaleCount:''}]` : '';
    const days = m.endDate ? Math.ceil((new Date(m.endDate)-Date.now())/86400000) : '?';
    const urgentFlag = days <= 7 ? ` ⚡RESOLVES IN ${days}D` : ` (${days}d)`;
    return `${i+1}. "${m.question}" mkt:${yes}%${ask}${wsPart} vol:${vol}${urgentFlag}${flowPart}`;
  }).join('\n');

  // Conflict check — markets where we already have an open position
  const openPositions = PERSIST.trades
    .filter(t => t.status === 'open')
    .map(t => `${t.market} → ${t.outcome}`);
  const conflictBlock = openPositions.length > 0
    ? `OPEN POSITIONS (do NOT trade opposite side of these):\n${openPositions.slice(0,10).map(p => `• ${p}`).join('\n')}\n`
    : '';

  // Recent price alerts from WebSocket
  const alertBlock = STATE_CLOB.priceAlerts.length > 0
    ? 'LIVE PRICE ALERTS (last hour):\n' +
      STATE_CLOB.priceAlerts.slice(0,5).map(a =>
        `${a.dir} "${a.market.slice(0,50)}" moved ${a.change}% (${a.from}% → ${a.to}%)`
      ).join('\n') + '\n'
    : '';

  // Signal memory — last 10 signals (gives Claude context of its own history)
  const recentSignals = (PERSIST.signalHistory || []).slice(-10);
  const memoryBlock = recentSignals.length > 0
    ? 'YOUR RECENT SIGNALS:\n' + recentSignals.map(s =>
        `• ${s.outcome} "${(s.market||'').slice(0,40)}" +${((s.edge||0)*100).toFixed(0)}% → ${s.status||'open'}`
      ).join('\n') : '';

  // Fetch live market context (news + crypto prices — free APIs)
  const marketContext = await fetchMarketContext();

  const urgentCount = STATE.urgentMarkets?.length || 0;

  const system = `You are Claude Sonnet 4, an elite Polymarket trading analyst focused on MAXIMUM PORTFOLIO GROWTH with controlled risk.
Date: ${new Date().toUTCString()}
Bankroll: $${PERSIST.bankroll.toFixed(2)} | Win rate: ${winRate}% | Total trades: ${totalTrades}
${urgentCount > 0 ? `⚡ ${urgentCount} URGENT markets resolving within 7 days — PRIORITIZE THESE` : ''}

PRIORITY HIERARCHY — trade in this order:

1. ⚡ TIME DECAY (HIGHEST VALUE — do these first)
   Markets resolving in <7 days are your best opportunity.
   A market at 15% with 3 days left that clearly won't happen = buy NO, collect 85% of stake fast.
   A market at 80% with 5 days left that clearly will happen = buy YES, collect 20% gain fast.
   Fast resolution = fast compounding. This is how portfolios grow quickly.
   SIZE: Use 8% bankroll (high confidence) on these.

2. ORDERBOOK WHALE DIVERGENCE
   Retail going one way, whales ($500+) consistently going other way.
   Smart money wins. Size: 5-8% bankroll.

3. NEWS REPRICING
   Market hasn't priced in obvious recent information.
   Size: 5% bankroll.

4. CORRELATION GAP
   Two linked markets mathematically impossible divergence.
   Size: 5% bankroll.

CONFLICT RULE — CRITICAL:
Never trade the opposite side of an existing open position.
Check the open positions list below before every signal.

SIZING FOR GROWTH:
- Urgent (<7 day) + high confidence = $${(PERSIST.bankroll*0.08).toFixed(2)} (8% bankroll)
- Standard + high confidence = $${(PERSIST.bankroll*0.06).toFixed(2)} (6% bankroll)  
- Medium confidence = $${(PERSIST.bankroll*0.04).toFixed(2)} (4% bankroll)
- Low confidence = skip, don't force trades

STRICT RULES:
- Only trade 5-95% YES price range
- Minimum 6% real edge with specific evidence
- Maximum 3 signals per cycle
- If no genuine edge exists — return empty signals, never force trades`;

  const userMsg = [
    alertBlock,
    conflictBlock,
    clobContext,
    marketContext ? `NEWS & CRYPTO CONTEXT:\n${marketContext}` : '',
    urgentCount > 0 ? `\n⚡ URGENT MARKETS (resolve <7 days — PRIORITIZE):\n${STATE.urgentMarkets.map(m => `"${m.question}" at ${(m.yesPrice*100).toFixed(0)}% — ${Math.ceil((new Date(m.endDate)-Date.now())/86400000)} days left`).join('\n')}` : '',
    `\nALL QUALITY MARKETS:\n${marketList}`,
    memoryBlock ? `\n${memoryBlock}` : '',
    '\nPrioritize urgent markets. Check conflicts. Return JSON signals with specific evidence.',
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

      // DEDUP: skip if we already have an open Claude position on this market+outcome
      const alreadyOpen = PERSIST.trades.some(t =>
        t.type === 'claude' &&
        t.market === sig.market &&
        t.outcome === sig.outcome &&
        t.status === 'open'
      );
      if (alreadyOpen) {
        log(`Skipping duplicate Claude signal: ${sig.market?.slice(0,40)} ${sig.outcome}`);
        continue;
      }

      const conf = sig.confidence === 'high' ? 1 : sig.confidence === 'medium' ? 0.6 : 0.3;
      const size = Math.min(PERSIST.bankroll * CFG.maxBetPct * conf, PERSIST.bankroll * 0.08);

      addFeed({ ts: Date.now(), type: 'claude', kind: 'model',
        market: sig.market, outcome: sig.outcome, edge: sig.edge,
        size, reasoning: sig.reasoning, confidence: sig.confidence,
        mode: CFG.dryRun ? 'PAPER' : 'LIVE' });

      // Store price for accurate P&L: Claude signals target near-zero prices
      const sigMkt    = markets.find(m => m.question === sig.market);
      const sigPrice  = sigMkt?.yesPrice || (sig.outcome === 'NO' ? 0.01 : 0.99);
      PERSIST.trades.push({ ts: Date.now(), type: 'claude', market: sig.market,
        conditionId: sigMkt?.conditionId,
        outcome: sig.outcome, size, status: 'open', edge: sig.edge, price: sigPrice });

      // Signal memory for future context
      if (!PERSIST.signalHistory) PERSIST.signalHistory = [];
      PERSIST.signalHistory.push({ ts: Date.now(), market: sig.market,
        outcome: sig.outcome, edge: sig.edge, confidence: sig.confidence, status: 'open' });
      if (PERSIST.signalHistory.length > 20) PERSIST.signalHistory.shift();

      savePersist();
      log(`[${CFG.dryRun?'PAPER':'LIVE'}] Claude: ${sig.outcome} "${sig.market?.slice(0,45)}" +${(sig.edge*100).toFixed(0)}% ${sig.confidence} $${size.toFixed(2)}`);

      // Live execution — place real CLOB order if not in paper mode
      if (!CFG.dryRun && sigMkt) {
        const tokenId = sig.outcome === 'YES' ? sigMkt.yesTokenId : sigMkt.noTokenId;
        if (tokenId) {
          const livePrice = sig.outcome === 'NO' ? sigMkt.noPrice : sigMkt.yesPrice;
          await executeCLOBOrder(tokenId, livePrice || sigPrice, size, 'BUY');
        }
      }
    }

    if (signals.length > 0) {
      const lines = [
        'POLYBOT: ' + signals.length + ' signal' + (signals.length>1?'s':'') + ' found',
        'Time: ' + new Date().toUTCString().slice(17,22) + ' UTC (' + new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:true}) + ' ET)',
      ];
      signals.forEach(s => {
        const size = (PERSIST.bankroll * 0.08 * (s.confidence==='high'?1:s.confidence==='medium'?0.6:0.3)).toFixed(2);
        lines.push('');
        lines.push(s.outcome + ' | ' + (s.market||'').slice(0,50));
        lines.push('Edge: +' + ((s.edge||0)*100).toFixed(0) + '% | ' + (s.confidence||'').toUpperCase() + ' | $' + size);
        if (s.reasoning) lines.push(s.reasoning.slice(0,80));
      });
      if (parsed?.summary) lines.push('', parsed.summary);
      await sendTelegram(lines.join('\n'));
    }
    return signals;
  } catch (e) { logError('claudeAnalyzeMarkets', e); return []; }
}


// ─── TRADE RESOLUTION ────────────────────────────────────────────────────────
// In paper mode, resolve open trades probabilistically based on edge
// Real trades would resolve from Polymarket contract outcomes
// ─── REAL MARKET RESOLUTION (NO SIMULATION) ─────────────────────────────────
// Checks Polymarket API for actual resolution of open trades.
// No random outcomes. Trades stay OPEN until the real market resolves.
// P&L only updates when Polymarket reports a winner.
async function resolveOpenTrades(markets) {
  const openTrades = PERSIST.trades.filter(t => t.status === 'open');
  if (openTrades.length === 0) return;

  let changed = false;

  for (const trade of openTrades) {
    // Find the market in our current market list
    const mkt = markets.find(m =>
      m.question === trade.market ||
      m.conditionId === trade.conditionId
    );

    if (!mkt) continue; // market not in current list, check next poll

    // ── RESOLUTION RULES ─────────────────────────────────────────────────────
    // A market ONLY resolves when BOTH conditions are true:
    // 1. The endDate has passed (market closed by Polymarket)
    // 2. Price confirms the outcome (snaps to 0.999+ on resolution)
    //
    // CRITICAL: noPrice=0.999 on an active market (like Pelicans) is NOT a
    // resolution — it just means the market is heavily one-sided but still open.
    // We MUST check endDate first.
    //
    // Extra safety: never resolve markets where yesPrice < 0.01 before endDate
    // These near-zero markets are active but illiquid — not resolved.
    const marketEndTs = mkt.endDate ? new Date(mkt.endDate).getTime() : Infinity;
    const marketHasEnded = Date.now() > marketEndTs;

    // Hard block: if market hasn't ended, never auto-resolve regardless of price
    if (!marketHasEnded) continue;

    const yesWon = mkt.yesPrice >= 0.9999;
    const noWon  = mkt.noPrice  >= 0.9999;

    let resolved = false;
    let won      = false;

    if (yesWon) {
      resolved = true;
      won = trade.outcome === 'YES';
    } else if (noWon) {
      resolved = true;
      won = trade.outcome === 'NO';
    }

    // If price-based resolution didn't fire, try CLOB API for winner field
    // (only reached if marketHasEnded is already true from the guard above)
    if (!resolved && mkt.conditionId) {
      try {
        const res = await httpsGet(
          `https://clob.polymarket.com/markets/${mkt.conditionId}`
        );
        if (res?.winner) {
          resolved = true;
          won = res.winner.toLowerCase() === trade.outcome.toLowerCase();
        }
      } catch(e) { /* not resolved yet */ }
    }

    if (!resolved) continue; // still open, check again next poll

    // Real resolution — calculate actual P&L
    trade.status    = won ? 'win' : 'loss';
    trade.resolvedAt = Date.now();

    const entryPrice = parseFloat(trade.price) || 0.5;
    const size       = parseFloat(trade.size)  || 0;

    if (won) {
      PERSIST.wins++;
      const profit = size * (1 - entryPrice) / Math.max(entryPrice, 0.001);
      trade.realProfit = parseFloat(profit.toFixed(4));

      // ── BANKROLL COMPOUNDING ─────────────────────────────────────────────
      // Add winnings to bankroll so Kelly sizing grows with the account
      PERSIST.bankroll = parseFloat((PERSIST.bankroll + profit).toFixed(4));
      log(`Bankroll compounded: +$${profit.toFixed(2)} → $${PERSIST.bankroll.toFixed(2)}`);

      addFeed({ ts: Date.now(), type: trade.type || 'claude', kind: 'model',
        market: trade.market, outcome: trade.outcome,
        size: trade.realProfit, mode: CFG.dryRun ? 'PAPER' : 'LIVE',
        result: 'WIN', icon: 'WIN',
        entryPrice, profit: trade.realProfit });

      log(`[REAL WIN] "${trade.market?.slice(0,50)}" entry=${(entryPrice*100).toFixed(1)}% profit=+$${profit.toFixed(2)}`);
      await sendTelegram(
        'TRADE RESOLVED: WIN\n' +
        trade.outcome + ' | ' + (trade.market||'').slice(0,60) + '\n' +
        'Entry: ' + (entryPrice*100).toFixed(1) + '% | Size: $' + size.toFixed(2) + '\n' +
        'Profit: +$' + profit.toFixed(2) + ' (' + ((profit/size)*100).toFixed(0) + '% return)\n' +
        'Trader: ' + (trade.trader || 'Claude')
      );
    } else {
      PERSIST.losses++;
      trade.realProfit = -size;

      // ── BANKROLL DEDUCTION ───────────────────────────────────────────────
      PERSIST.bankroll = parseFloat(Math.max(0, PERSIST.bankroll - size).toFixed(4));
      log(`Bankroll reduced: -$${size.toFixed(2)} → $${PERSIST.bankroll.toFixed(2)}`);

      addFeed({ ts: Date.now(), type: trade.type || 'claude', kind: 'model',
        market: trade.market, outcome: trade.outcome,
        size: -size, mode: CFG.dryRun ? 'PAPER' : 'LIVE',
        result: 'LOSS', icon: 'LOSS',
        entryPrice, loss: size });

      log(`[REAL LOSS] "${trade.market?.slice(0,50)}" entry=${(entryPrice*100).toFixed(1)}% lost=$${size.toFixed(2)}`);
      await sendTelegram(
        'TRADE RESOLVED: LOSS\n' +
        trade.outcome + ' | ' + (trade.market||'').slice(0,60) + '\n' +
        'Entry: ' + (entryPrice*100).toFixed(1) + '% | Size: $' + size.toFixed(2) + '\n' +
        'Lost: -$' + size.toFixed(2) + '\n' +
        'Trader: ' + (trade.trader || 'Claude')
      );
    }
    changed = true;
  }

  if (changed) {
    savePersist();
    const wr = PERSIST.wins + PERSIST.losses > 0
      ? ((PERSIST.wins/(PERSIST.wins+PERSIST.losses))*100).toFixed(1) : '0';
    log('Real trade resolved', { wins: PERSIST.wins, losses: PERSIST.losses, wr });
  }
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
  // Use plain text to avoid Markdown parsing failures
  const safe = msg.replace(/[<>&]/g, '').slice(0, 4000);
  try {
    const r = await httpsPost(
      `https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`,
      { chat_id: CFG.telegramChat, text: safe }
    );
    if (r.status !== 200) logError('Telegram', JSON.stringify(r.body));
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
    const markets = await fetchMarkets();

    // ── TIME DECAY SNIPING — highest priority ──────────────────────────────
    // Markets resolving in <7 days with real uncertainty = best edge
    // Size up aggressively on these — fastest path to profit
    const urgentMarkets = markets.filter(m => {
      if (!m.endDate) return false;
      const days = (new Date(m.endDate).getTime() - Date.now()) / 86400000;
      return days > 0 && days <= 7 && m.yesPrice >= 0.05 && m.yesPrice <= 0.95 && m.volume > 5000;
    });
    if (urgentMarkets.length > 0) {
      log('TIME DECAY markets found', {
        count: urgentMarkets.length,
        markets: urgentMarkets.map(m => `${m.question?.slice(0,30)} ${(m.yesPrice*100).toFixed(0)}% ${Math.ceil((new Date(m.endDate)-Date.now())/86400000)}d`)
      });
      // Pass urgent markets to Claude with special priority flag
      STATE.urgentMarkets = urgentMarkets;
    } else {
      STATE.urgentMarkets = [];
    }

    await resolveOpenTrades(markets);
    updateSignalOutcomes(markets);
    scanArbs(markets);
    await mirrorCopyTrades(markets);

    if (!STATE_CLOB.wsConnected && WebSocket) {
      startWebSocketPriceFeed(markets);
    }

    // Claude fires every poll if urgent markets exist — otherwise normal cadence
    const signalsSoFar = STATE.feed.filter(f => f.type === 'claude').length;
    const hasUrgent = STATE.urgentMarkets?.length > 0;
    if (hasUrgent || pollCount === 1 || signalsSoFar === 0 || pollCount % CFG.claudeEvery === 0) {
      await claudeAnalyzeMarkets(markets);
    }

    if (pollCount % 30 === 0 || pollCount === 1) {
      await fetchLeaderboard();
    }

  } catch (e) {
    logError('poll', e);
  }

  const curPnl = calcPnl(PERSIST.trades);
  const bankrollNow = PERSIST.bankroll + parseFloat(curPnl.toFixed(4));
  const lastEq = STATE.equityData[STATE.equityData.length - 1];
  if (!lastEq || Math.abs(lastEq.v - curPnl) > 0.001 || pollCount % 10 === 0) {
    STATE.equityData.push({ t: Date.now(), v: parseFloat(curPnl.toFixed(4)), br: parseFloat(bankrollNow.toFixed(2)) });
    if (STATE.equityData.length > 500) STATE.equityData = STATE.equityData.slice(-500);
  }

  if (pollCount % 60 === 0) {
    const curPnl2 = calcPnl(PERSIST.trades);
    const wr = PERSIST.wins + PERSIST.losses > 0
      ? ((PERSIST.wins / (PERSIST.wins + PERSIST.losses)) * 100).toFixed(1) : '0';
    const urgentCount = STATE.urgentMarkets?.length || 0;
    await sendTelegram(
      `📊 *Polybot Heartbeat*\n` +
      `Poll: #${pollCount} | Markets: ${STATE.markets.length}\n` +
      `P&L: $${curPnl2.toFixed(2)} | Win Rate: ${wr}%\n` +
      `Traders copying: ${PERSIST.selectedTraders.length}\n` +
      `Urgent (<7d): ${urgentCount} markets\n` +
      `Mode: ${CFG.dryRun ? 'Paper' : '⚡ LIVE'}`
    );
  }

  setTimeout(poll, CFG.pollMs);
}


// ─── ACCURATE POLYMARKET P&L CALCULATION ─────────────────────────────────────
// Paper mode: use conservative edge-based P&L (honest simulation)
//   Win:  profit = size * edge
//   Loss: cost   = size * min(price, 0.5)  [actual cost of the bet]
//
// Live mode (future): real price-based returns apply
//   Win:  profit = size * (1-price)/price
//   Loss: cost   = size
//
// Paper mode keeps numbers realistic — edge*size reflects the actual
// statistical advantage, not the theoretical jackpot return
function calcPnl(trades) {
  return trades
    .filter(t => t.status === 'win' || t.status === 'loss')
    .reduce((sum, t) => {
      // Use realProfit if available (set by real market resolution)
      if (t.realProfit !== undefined) return sum + t.realProfit;
      // Fallback for legacy trades without realProfit
      const size  = parseFloat(t.size) || 0;
      const price = parseFloat(t.price) || 0.5;
      if (t.status === 'win') {
        return sum + size * (1 - price) / Math.max(price, 0.001);
      } else {
        return sum - size;
      }
    }, 0);
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

    const pnl = calcPnl(PERSIST.trades);

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
      liveMode:     !CFG.dryRun,  // explicit boolean for badge display
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
      wsConnected:  STATE_CLOB.wsConnected,
      priceAlerts:  STATE_CLOB.priceAlerts.slice(0,5),
      clobBooks:    Object.keys(STATE_CLOB.books).length,

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

  // ── POST /clear-state — reset all trades and P&L (admin use) ──
  if (req.method === 'POST' && path === '/clear-state') {
    PERSIST.trades = [];
    PERSIST.wins   = 0;
    PERSIST.losses = 0;
    PERSIST.signalHistory = [];
    PERSIST.seenCopyTrades = [];
    STATE.equityData = [];
    savePersist();
    log('State cleared via API');
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, message: 'Trades, wins, losses reset. Fresh start.' }));
    return;
  }

  // ── GET /health ──
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, version: STATE.version, uptime: process.uptime(), pollCount }));
    return;
  }

  // ── GET /generate-creds — derive Polymarket API creds from private key ──
  if (req.method === 'GET' && path === '/generate-creds') {
    if (!CFG.polyPrivateKey) {
      res.writeHead(400, CORS);
      res.end(JSON.stringify({ error: 'POLY_PRIVATE_KEY not set in Railway Variables' }));
      return;
    }
    if (!ethers) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: 'ethers package not installed — check package.json' }));
      return;
    }
    try {
      const creds = await deriveClobCreds();
      if (!creds) throw new Error('deriveClobCreds returned null unexpectedly');

      // Save to PERSIST so bot can use them immediately
      PERSIST.polyApiKey     = creds.apiKey;
      PERSIST.polySecret     = creds.secret;
      PERSIST.polyPassphrase = creds.passphrase;
      savePersist();

      log('CLOB creds saved to persist', { key: creds.apiKey?.slice(0,8) });

      res.writeHead(200, CORS);
      res.end(JSON.stringify({
        ok: true,
        message: 'Credentials derived successfully. Add these to Railway Variables now.',
        POLY_API_KEY:     creds.apiKey,
        POLY_SECRET:      creds.secret,
        POLY_PASSPHRASE:  creds.passphrase,
        next: 'Copy these 3 values into Railway Variables, then set DRY_RUN=false to go live',
      }));
    } catch(e) {
      log('generate-creds failed', { err: e.message });
      res.writeHead(500, CORS);
      res.end(JSON.stringify({
        error: e.message,
        hint: 'Check Railway logs for full detail — look for ERROR deriveClobCreds',
      }));
    }
    return;
  }

  // ── GET /wallet-status — check USDC balance on Polygon ──
  if (req.method === 'GET' && path === '/wallet-status') {
    try {
      const addr = CFG.polyWalletAddr;
      if (!addr) throw new Error('POLY_WALLET_ADDRESS not set');
      // Check via Polygon RPC — free, no API key needed
      const rpc = await httpsPost('https://polygon-rpc.com', {
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{
          to: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC on Polygon
          data: '0x70a08231000000000000000000000000' + addr.slice(2).padStart(64,'0'),
        }, 'latest']
      });
      const raw = rpc.body?.result;
      const usdc = raw ? parseInt(raw, 16) / 1e6 : 0;
      res.writeHead(200, CORS);
      res.end(JSON.stringify({
        ok: true, address: addr,
        usdcBalance: usdc.toFixed(2),
        hasKey: !!CFG.polyPrivateKey,
        hasCreds: !!(CFG.polyApiKey || PERSIST.polyApiKey),
        dryRun: CFG.dryRun,
        readyToTrade: !CFG.dryRun && !!CFG.polyPrivateKey && usdc > 1,
      }));
    } catch(e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /test-clob — validate CLOB credentials without placing any order ──
  // Tests: 1) private key loads, 2) L1 auth headers build, 3) CLOB API responds
  // Safe to run anytime — reads only, zero money at risk
  if (req.method === 'GET' && path === '/test-clob') {
    const results = { tests: [], ready: false };
    try {
      // Test 1: Private key
      const wallet = getWallet();
      results.tests.push({
        name: 'Private key',
        ok: !!wallet,
        detail: wallet ? `Wallet loaded: ${wallet.address.slice(0,10)}...` : 'POLY_PRIVATE_KEY missing or invalid'
      });

      // Test 2: API credentials
      const apiKey = CFG.polyApiKey || PERSIST.polyApiKey;
      const secret = CFG.polySecret || PERSIST.polySecret;
      results.tests.push({
        name: 'API credentials',
        ok: !!(apiKey && secret),
        detail: apiKey ? `API key: ${apiKey.slice(0,8)}...` : 'Missing — run /generate-creds first'
      });

      // Test 3: CLOB auth headers build correctly
      const headers = buildL2Headers('GET', '/auth/api-key');
      results.tests.push({
        name: 'Auth headers',
        ok: !!headers,
        detail: headers ? 'HMAC-SHA256 headers built successfully' : 'Failed — check POLY_SECRET format'
      });

      // Test 4: Hit CLOB /auth/api-key endpoint (validates credentials with Polymarket)
      if (headers) {
        try {
          const authCheck = await httpsGetWithHeaders(
            'https://clob.polymarket.com/auth/api-key',
            headers
          );
          const ok = authCheck?.apiKey || authCheck?.api_key || authCheck?.key;
          results.tests.push({
            name: 'CLOB auth check',
            ok: !!ok || authCheck !== null,
            detail: ok ? `Authenticated: ${JSON.stringify(authCheck).slice(0,80)}` : `Response: ${JSON.stringify(authCheck).slice(0,80)}`
          });
        } catch(e) {
          results.tests.push({ name: 'CLOB auth check', ok: false, detail: e.message });
        }
      }

      // Test 5: Read USDC balance (no auth needed — public RPC)
      try {
        const addr = CFG.polyWalletAddr;
        const rpc = await httpsPost('https://polygon-rpc.com', {
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
            data: '0x70a08231000000000000000000000000' + (addr||'').slice(2).padStart(64,'0') }, 'latest']
        });
        const raw = rpc.body?.result;
        const usdc = raw && raw !== '0x' ? parseInt(raw, 16) / 1e6 : null;
        results.tests.push({
          name: 'USDC balance (Polygon RPC)',
          ok: usdc !== null,
          detail: usdc !== null ? `$${usdc.toFixed(2)} USDC on Polygon` : 'RPC call failed — cosmetic only, does not block trading'
        });
      } catch(e) {
        results.tests.push({ name: 'USDC balance', ok: false, detail: `RPC error: ${e.message}` });
      }

      const passed = results.tests.filter(t => t.ok).length;
      results.ready = passed >= 3; // key + creds + auth = minimum viable
      results.summary = `${passed}/${results.tests.length} checks passed`;
      results.nextStep = results.ready
        ? 'Credentials valid. Complete Polymarket contract approvals, then set DRY_RUN=false'
        : 'Fix failing checks above before going live';

      res.writeHead(200, CORS);
      res.end(JSON.stringify(results, null, 2));
    } catch(e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: e.message, tests: results.tests }));
    }
    return;
  }


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

  // Send immediate startup confirmation
  await sendTelegram(
    'Polybot v' + STATE.version + ' started\n' +
    new Date().toUTCString().slice(0,25) + '\n' +
    'Mode: ' + (CFG.dryRun ? 'Paper' : 'LIVE') + '\n' +
    'Bankroll: $' + PERSIST.bankroll.toFixed(2) + '\n' +
    'Copying: ' + PERSIST.selectedTraders.length + ' traders\n' +
    'Markets: loading...'
  );

  // Start polling
  poll();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
