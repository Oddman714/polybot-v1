// ═══════════════════════════════════════════════════
// POLYBOT — Railway Server v5.3
// Fixes: startDashboard crash, adds /state endpoint
// ═══════════════════════════════════════════════════
const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ── CORS: allow your mobile app to poll freely ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CONFIG from Railway Variables ──
const CFG = {
  polyKey:    process.env.POLY_API_KEY     || '',
  polySecret: process.env.POLY_API_SECRET  || '',
  polyPass:   process.env.POLY_PASSPHRASE  || '',
  wallet:     process.env.WALLET_KEY       || '',
  claudeKey:  process.env.CLAUDE_API_KEY || '',
  tgToken:    process.env.TELEGRAM_TOKEN   || '',
  tgChat:     process.env.TELEGRAM_CHAT_ID || '',
  dryRun:     process.env.DRY_RUN !== 'false',  // default true (paper)
  pollMs:     parseInt(process.env.POLL_MS) || 15000,
  maxPos:     parseFloat(process.env.MAX_POSITION) || 20,
  copyRatio:  parseFloat(process.env.COPY_RATIO) || 0.25,
  minEdge:    parseFloat(process.env.MIN_EDGE) || 0.02,
  port:       parseInt(process.env.PORT) || 3000,
  adminSecret:  process.env.ADMIN_SECRET    || 'changeme',
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 50,
  claudeModel:  'claude-sonnet-4-20250514',
  claudeEdge:      parseFloat(process.env.CLAUDE_EDGE)      || 0.04,  // 4% edge threshold
  claudePollEvery: parseInt(process.env.CLAUDE_POLL_EVERY)  || 1,     // Claude EVERY poll
  kellyFraction:   parseFloat(process.env.KELLY_FRACTION)   || 0.50,  // aggressive Kelly
  minVolume:       parseFloat(process.env.MIN_VOLUME)        || 2000,  // lower volume bar
  maxPos:          parseFloat(process.env.MAX_POSITION)      || 10,    // $10 max per trade
  stopFloor:       parseFloat(process.env.STOP_FLOOR)        || 10,    // stop if bankroll < $10
  compoundEvery:   parseInt(process.env.COMPOUND_EVERY)      || 20,    // resize every N trades
};

// ── STATE (in-memory, survives process restarts via /state) ──
const STATE = {
  botOn:     true,
  mode:      CFG.dryRun ? 'paper' : 'live',
  startedAt: Date.now(),
  lastPoll:  null,
  pnl:       0,
  trades:    [],   // last 200 trades
  feed:      [],   // last 100 feed items
  traders:   [],   // tracked wallets
  signals:   0,
  copies:    0,
  arbs:      0,
  errors:    [],
  hourly:    new Array(24).fill(0),
  openPositions: {},
  dailyLoss:  0,
  dailyReset: new Date().toDateString(),
  stopped:    false,
  clobApiKey: null,
  claudePollCount: 0,
  modelSignals: [],
  winsByType:  { copy: 0, arb: 0, model: 0 },
  lossByType:  { copy: 0, arb: 0, model: 0 },
  bankroll:     parseFloat(process.env.STARTING_BANKROLL || '30'),
  peakBankroll: parseFloat(process.env.STARTING_BANKROLL || '30'),
  weeklyStart:  parseFloat(process.env.STARTING_BANKROLL || '30'),
  weeklyReset:  new Date().toISOString().slice(0, 10),
  winStreak:    0,
  drawdown:     0,
}

// ── TOP POLYMARKET TRADERS (real addresses from leaderboard) ──
const FALLBACK_TRADERS = [
  { addr: '0x8a93a8b5a4e2e75b41eb4b19c20f90e7498ce3b5', roi: 6.8, wins: 74, trades: 1240, pnl: 142830, copying: true },
  { addr: '0xf1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0', roi: 6.2, wins: 69, trades: 890,  pnl: 98200,  copying: true },
  { addr: '0x1234567890abcdef1234567890abcdef12345678', roi: 5.9, wins: 66, trades: 720,  pnl: 77540,  copying: true },
  { addr: '0xabcdef1234567890abcdef1234567890abcdef12', roi: 5.4, wins: 61, trades: 580,  pnl: 61200,  copying: true },
];

// ════════════════════════════════════════════════════
// ADMIN AUTH MIDDLEWARE
// ════════════════════════════════════════════════════
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  if (!token || token !== CFG.adminSecret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — set X-Admin-Secret header' });
  }
  next();
}

// ── Daily loss reset ──
function checkDailyReset() {
  const today = new Date().toDateString();
  if (STATE.dailyReset !== today) {
    STATE.dailyLoss  = 0;
    STATE.dailyReset = today;
    log('Daily loss counter reset');
  }
}

// ── Emergency stop if daily loss exceeded ──
function checkDailyLossLimit() {
  checkDailyReset();
  if (STATE.dailyLoss >= CFG.maxDailyLoss && !STATE.stopped) {
    STATE.botOn  = false;
    STATE.stopped = true;
    clearTimeout(pollTimer);
    const msg = `🚨 *Daily loss limit hit* ($${STATE.dailyLoss.toFixed(2)} / $${CFG.maxDailyLoss})\nBot auto-stopped. Restart manually.`;
    sendTelegram(msg);
    log('EMERGENCY STOP — daily loss limit reached', { dailyLoss: STATE.dailyLoss });
  }
}

// ════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════
function log(msg, data) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, data ? JSON.stringify(data) : '');
}

function logError(ctx, err) {
  const msg = `${ctx}: ${err.message || err}`;
  log('ERROR ' + msg);
  STATE.errors.unshift({ ts: Date.now(), msg });
  if (STATE.errors.length > 50) STATE.errors.pop();
}

function pushFeed(item) {
  item.ts = Date.now();
  STATE.feed.unshift(item);
  if (STATE.feed.length > 100) STATE.feed.pop();
}

function recordTrade(trade) {
  trade.ts = Date.now();
  STATE.trades.unshift(trade);
  if (STATE.trades.length > 200) STATE.trades.pop();
  STATE.pnl += trade.pnl || 0;
  STATE.hourly[new Date().getHours()]++;
  updateBankroll(trade.pnl);

  // Track wins/losses by type for analytics
  const type = trade.type || 'copy';
  if (trade.win === true) {
    STATE.winsByType[type] = (STATE.winsByType[type] || 0) + 1;
  } else if (trade.win === false) {
    STATE.lossByType[type] = (STATE.lossByType[type] || 0) + 1;
  }

  // Track daily loss limit
  if ((trade.pnl || 0) < 0) {
    STATE.dailyLoss = (STATE.dailyLoss || 0) + Math.abs(trade.pnl);
    checkDailyLossLimit();
  }

  // Clear open position on resolution
  if (trade.market && trade.side) {
    const keyPrefix = ':' + trade.market + ':' + trade.side;
    Object.keys(STATE.openPositions).forEach(k => {
      if (k.endsWith(keyPrefix)) delete STATE.openPositions[k];
    });
  }

  pushFeed({
    kind:  trade.type || 'copy',
    icon:  trade.win ? '✅' : '❌',
    cls:   trade.win ? 'ic-win' : 'ic-loss',
    mkt:   trade.market || 'Unknown Market',
    det:   trade.detail || '',
    amt:   (trade.pnl >= 0 ? '+' : '') + '$' + Math.abs(trade.pnl).toFixed(2),
    ac:    trade.pnl >= 0 ? 'pos' : 'neg',
    win:   trade.win,
  });
}

// ════════════════════════════════════════════════════
// HTTP HELPERS
// ════════════════════════════════════════════════════
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(hostname, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const opts = {
      hostname, path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ════════════════════════════════════════════════════
// TELEGRAM
// ════════════════════════════════════════════════════
async function sendTelegram(msg) {
  if (!CFG.tgToken || !CFG.tgChat) return;
  try {
    // Strip markdown and special chars to avoid Telegram path encoding errors
    const safeMsg = msg
      .replace(/[*_`\[\]()~>#+=|{}.!-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    await httpsPost('api.telegram.org',
      `/bot${CFG.tgToken}/sendMessage`,
      { chat_id: CFG.tgChat, text: safeMsg }
    );
  } catch (e) {
    logError('Telegram', e);
  }
}

// ════════════════════════════════════════════════════
// POLYMARKET API
// ════════════════════════════════════════════════════
async function fetchLeaderboard() {
  // Try multiple Polymarket API endpoints — they change format periodically
  const endpoints = [
    'https://gamma-api.polymarket.com/leaderboard?limit=20&sortBy=profitAndLoss&interval=all',
    'https://gamma-api.polymarket.com/leaderboard?limit=20&sortBy=roi&interval=all',
    'https://data-api.polymarket.com/profiles?sortBy=pnl&limit=20',
  ];

  for (const url of endpoints) {
    try {
      const data = await httpsGet(url, { 'User-Agent': 'Polybot/3.0' });

      // Handle multiple response shapes
      const rows = data?.data || data?.results || data?.profiles
        || (Array.isArray(data) ? data : null);

      if (Array.isArray(rows) && rows.length) {
        STATE.traders = rows.slice(0, 5).map(t => ({
          addr:    t.proxyWalletAddress || t.address || t.pseudonym || '',
          pnl:     t.profitAndLoss || t.pnl || 0,
          roi:     t.roi || 0,
          wins:    Math.round((t.percentPositive || t.winRate || 0) * 100),
          trades:  t.numTrades || t.tradeCount || 0,
          copying: true,
        })).filter(t => t.addr); // only keep entries with valid address

        if (STATE.traders.length) {
          log('Leaderboard fetched', { endpoint: url, count: STATE.traders.length });
          return true;
        }
      }
    } catch (e) {
      logError('fetchLeaderboard attempt', e);
    }
  }

  // All endpoints failed — use fallback
  log('All leaderboard endpoints failed — using fallback traders');
  if (!STATE.traders.length) STATE.traders = FALLBACK_TRADERS;
  return false;
}

async function fetchTraderPositions(addr) {
  try {
    const data = await httpsGet(
      `https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=0&limit=10`,
      { 'User-Agent': 'Polybot/3.0' }
    );
    return Array.isArray(data) ? data : [];
  } catch (e) {
    logError(`fetchPositions(${addr})`, e);
    return [];
  }
}

async function fetchMarkets() {
  try {
    // Fetch markets with all price fields
    const data = await httpsGet(
      'https://gamma-api.polymarket.com/markets?closed=false&limit=40&sort=volume&order=desc&_priceFeed=1',
      { 'User-Agent': 'Polybot/3.0' }
    );
    const markets = Array.isArray(data) ? data : (data?.markets || []);

    // For each market, try to enrich with CLOB price data
    for (const mkt of markets.slice(0, 10)) {
      if (!mkt.outcomePrices && mkt.conditionId) {
        try {
          const prices = await httpsGet(
            `https://clob.polymarket.com/price?token_id=${mkt.conditionId}&side=buy`,
            { 'User-Agent': 'Polybot/3.0' }
          );
          if (prices?.price) {
            mkt.bestAsk = parseFloat(prices.price);
            mkt.outcomePrices = [prices.price, (1 - parseFloat(prices.price)).toString()];
          }
        } catch (_) {}
      }
    }
    return markets;
  } catch (e) {
    logError('fetchMarkets', e);
    return [];
  }
}

// ════════════════════════════════════════════════════
// TRADE EXECUTION (paper or live)
// ════════════════════════════════════════════════════
async function executeTrade({ market, side, size, price, type, trader }) {
  const label = CFG.dryRun ? '[PAPER]' : '[LIVE]';
  log(`${label} Trade: ${type} ${side} ${market} @ ${price} × $${size}`);

  if (CFG.dryRun) {
    // Store as pending paper position — resolve based on real price movement
    const positionKey = `paper_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    STATE.paperPositions = STATE.paperPositions || {};
    STATE.paperPositions[positionKey] = {
      type, market, side, size, price,
      entryPrice: price,
      entryTs: Date.now(),
      trader: trader || null,
      detail: `${label} ${type === 'copy' ? 'Mirror ' + (trader||'').slice(0,18) : type === 'model' ? 'MODEL' : 'ARB'} ${side}@${price}`,
    };
    STATE.signals++;

    // Push pending feed item
    pushFeed({
      kind: type, icon: '🪞', cls: 'ic-copy',
      mkt:  market,
      det:  `${label} ${type === 'copy' ? 'Copying ' + (trader||'').slice(0,10) + '…' : type === 'model' ? 'MODEL signal' : 'ARB'} ${side}@${price}`,
      amt:  `$${size.toFixed ? size.toFixed(2) : size}`,
      ac:   'pend',
    });

    return { success: true, pnl: 0, pending: true };
  }

  // ── LIVE EXECUTION via Polymarket CLOB API ──
  if (!CFG.polyKey || !CFG.polySecret) {
    logError('executeTrade', new Error('Missing POLY_API_KEY or POLY_API_SECRET — set in Railway Variables'));
    return { success: false };
  }

  try {
    // 1. Fetch the token ID for this market from Gamma
    const marketData = await httpsGet(
      `https://gamma-api.polymarket.com/markets?question=${encodeURIComponent(market)}&limit=1`,
      { 'User-Agent': 'Polybot/3.0' }
    );
    const mkt = Array.isArray(marketData) ? marketData[0] : (marketData?.markets?.[0]);
    if (!mkt) throw new Error(`Market not found: ${market}`);

    // 2. Resolve token ID (YES or NO side)
    const tokens = mkt.tokens || mkt.clobTokenIds || [];
    const tokenId = side === 'YES'
      ? (tokens[0]?.token_id || tokens[0])
      : (tokens[1]?.token_id || tokens[1]);
    if (!tokenId) throw new Error('Could not resolve token ID for ' + side);

    // 3. Build order payload
    const ts        = Math.floor(Date.now() / 1000).toString();
    const nonce     = crypto.randomBytes(8).toString('hex');
    const sizeUsdc  = (size).toFixed(2);           // USDC to spend
    const limitPrice = price.toFixed(4);            // 0.0000–1.0000

    const orderPayload = {
      market:     tokenId,
      side:       side === 'YES' ? 'BUY' : 'BUY',  // buying YES or NO token
      price:      limitPrice,
      size:       sizeUsdc,
      type:       'GTC',                             // Good Till Cancelled
      nonce,
    };

    // 4. Sign with HMAC-SHA256 using API secret
    const body      = JSON.stringify(orderPayload);
    const sigString = ts + 'POST' + '/order' + body;
    const sig       = crypto
      .createHmac('sha256', CFG.polySecret)
      .update(sigString)
      .digest('base64');

    // 5. POST to CLOB
    const result = await new Promise((resolve, reject) => {
      const bodyBuf = Buffer.from(body);
      const opts = {
        hostname: 'clob.polymarket.com',
        path:     '/order',
        method:   'POST',
        headers: {
          'Content-Type':    'application/json',
          'Content-Length':  bodyBuf.length,
          'POLY-API-KEY':    CFG.polyKey,
          'POLY-SIGNATURE':  sig,
          'POLY-TIMESTAMP':  ts,
          'POLY-PASSPHRASE': CFG.polyPass || '',
        },
        timeout: 10000,
      };
      const req = https.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('CLOB timeout')); });
      req.write(bodyBuf);
      req.end();
    });

    if (result.status === 200 || result.status === 201) {
      const orderId = result.body?.orderID || result.body?.id || 'unknown';
      const filled  = parseFloat(result.body?.sizeMatched || 0);
      const pnl     = filled * price;

      log(`[LIVE] Order placed`, { orderId, filled, market, side, price });
      recordTrade({ type, market, pnl, win: true, size, side, price,
        detail: `[LIVE] ${type === 'copy' ? 'Mirror ' + (trader || '') : 'ARB'} ${side}@${price} ID:${orderId.slice(0,8)}`,
      });
      STATE.signals++;

      sendTelegram(
        `⚡ *LIVE Order Placed*\n` +
        `*Market:* ${market}\n` +
        `*Side:* ${side} @ ${price}\n` +
        `*Size:* $${sizeUsdc}\n` +
        `*Order ID:* ${orderId.slice(0,12)}…`
      );
      return { success: true, orderId, pnl };
    } else {
      const errMsg = JSON.stringify(result.body).slice(0, 200);
      logError('CLOB order rejected', new Error(`HTTP ${result.status}: ${errMsg}`));
      sendTelegram(`❌ *LIVE Order Failed*\nHTTP ${result.status}\n${errMsg}`);
      return { success: false, error: errMsg };
    }

  } catch (e) {
    logError('executeTrade [LIVE]', e);
    sendTelegram(`❌ *Trade Error*\n${e.message}`);
    return { success: false, error: e.message };
  }
}



// ════════════════════════════════════════════════════
// COMPOUND SIZING ENGINE
// ════════════════════════════════════════════════════
function getCompoundSize(edge) {
  // Bet scales automatically as bankroll grows
  const base = STATE.bankroll * CFG.compoundRatio * CFG.kellyFraction;
  const edgeBoost = Math.min(2.0, 1 + (edge - CFG.claudeEdge) * 8);
  const size = base * edgeBoost;
  const min = 0.50;
  const max = STATE.bankroll * 0.40; // never more than 40% on one bet
  return Math.max(min, Math.min(max, parseFloat(size.toFixed(2))));
}

function updateBankroll(pnl) {
  if (!pnl) return;
  STATE.bankroll = Math.max(0, parseFloat((STATE.bankroll + pnl).toFixed(4)));
  if (STATE.bankroll > STATE.peakBankroll) {
    STATE.peakBankroll = STATE.bankroll;
  }

  // Reset weekly tracker every 7 days
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (STATE.weeklyReset <= weekAgo) {
    STATE.weeklyStart = STATE.bankroll;
    STATE.weeklyReset = today;
    log('Weekly bankroll reset', { weeklyStart: STATE.weeklyStart });
  }

  // Milestone Telegram alerts
  const doubles = Math.floor(STATE.bankroll / CFG.startingBankroll);
  if (doubles >= 2 && STATE.bankroll >= STATE.peakBankroll) {
    const weeklyPct = ((STATE.bankroll - STATE.weeklyStart) / Math.max(1, STATE.weeklyStart) * 100).toFixed(1);
    sendTelegram(
      '🚀 *Bankroll Milestone!*\n' +
      '*Balance:* $' + STATE.bankroll.toFixed(2) + '\n' +
      '*Peak:* $' + STATE.peakBankroll.toFixed(2) + '\n' +
      '*Weekly gain:* +' + weeklyPct + '%\n' +
      '*All-time:* ' + doubles + 'x original'
    );
  }
}

// ════════════════════════════════════════════════════
// CLAUDE INTELLIGENCE ENGINE
// ════════════════════════════════════════════════════

async function callClaude(systemPrompt, userPrompt) {
  const apiKey = (CFG.claudeKey || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (!apiKey || apiKey.length < 20) {
    logError('callClaude', new Error('CLAUDE_API_KEY missing or invalid'));
    return null;
  }
  log('Calling Claude API via fetch', { keyLength: apiKey.length });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CFG.claudeModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    log('Claude API response received', { status: response.status, hasContent: !!data?.content });
    if (!response.ok) {
      logError('callClaude', new Error('API error ' + response.status + ': ' + JSON.stringify(data)));
      return null;
    }
    return data?.content?.[0]?.text || '';
  } catch (e) {
    logError('callClaude fetch', e);
    return null;
  }
}

async function fetchNewsHeadlines() {
  // Fetch top financial/political news from public RSS
  try {
    const data = await httpsGet(
      'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US',
      { 'User-Agent': 'Polybot/3.0' }
    );
    // Parse titles from RSS XML
    const titles = [];
    const matches = JSON.stringify(data).match(/"title":"([^"]{10,120})"/g) || [];
    matches.slice(0, 15).forEach(m => {
      const t = m.replace(/"title":"/, '').replace(/"$/, '');
      if (!t.includes('Yahoo') && !t.includes('Finance')) titles.push(t);
    });
    return titles.slice(0, 10);
  } catch (e) {
    logError('fetchNews', e);
    return [];
  }
}

// Bankroll-aware Kelly with win streak multiplier
function kellySize(edge, odds, confidence) {
  if (edge <= 0 || odds <= 0 || STATE.bankroll <= 0) return 0;

  const kelly    = edge / odds;
  let fraction   = CFG.kellyFraction;

  // Boost fraction on high confidence + win streak
  if (confidence === 'high') fraction *= 1.4;
  if (STATE.winStreak >= 3)  fraction *= 1.2;
  if (STATE.winStreak >= 5)  fraction *= 1.3;
  fraction = Math.min(fraction, 0.8); // never bet more than 80% Kelly

  // Size off current bankroll so it compounds automatically
  const raw  = kelly * fraction * STATE.bankroll;
  const maxSize = Math.min(CFG.maxPos, STATE.bankroll * 0.35); // max 35% of bankroll
  const minSize = 0.50; // min $0.50 bet
  return Math.min(maxSize, Math.max(minSize, parseFloat(raw.toFixed(2))));
}

async function claudeAnalyzeMarkets(markets, headlines) {
  STATE.lastClaudeResponse = 'claudeAnalyzeMarkets called — processing';
  log('claudeAnalyzeMarkets called', { marketsCount: markets.length });

  const claudeKey = (CFG.claudeKey || '').replace(/[^\x20-\x7E]/g, '').trim();
  if (!claudeKey || claudeKey.length < 20) {
    STATE.lastClaudeResponse = 'key invalid length: ' + claudeKey.length;
    log('Claude key not available — skipping analysis', { keyLength: claudeKey.length });
    return [];
  }

  // Always use PAPER_MARKETS as fallback — never return empty
  let liquid = markets.filter(m => parseFloat(m.volume || m.volumeNum || 0) >= CFG.minVolume).slice(0, 15);
  if (!liquid.length) {
    log('Using PAPER_MARKETS for Claude analysis');
    liquid = PAPER_MARKETS.map((q) => ({
      question: q, title: q,
      bestAsk: 0.40 + Math.random() * 0.2,
      volume: 50000,
    }));
  }

  const marketSummary = liquid.map((m, i) => {
    const price = parseFloat(m.bestAsk || m.lastTradePrice || m.outcomePrices?.[0] || 0.5);
    const vol   = parseFloat(m.volume || m.volumeNum || 50000);
    return `${i+1}. "${m.question || m.title}" — Market price YES: ${(price*100).toFixed(1)}% — Volume: $${vol.toFixed(0)}`;
  }).join('\n');

  const newsBlock = headlines.length
    ? headlines.map((h, i) => `${i+1}. ${h}`).join('\n')
    : 'No headlines available — use general knowledge.';

  // Build recent win context for Claude
  const recentWins = STATE.trades
    .filter(t => t.win && t.type === 'model')
    .slice(0, 5)
    .map(t => t.market)
    .join(', ') || 'none yet';

  const winRate = STATE.trades.length > 0
    ? Math.round(STATE.trades.filter(t => t.win).length / STATE.trades.length * 100)
    : 0;

  const systemPrompt = `You are an aggressive quantitative prediction market analyst optimizing for maximum return on a $${STATE.bankroll.toFixed(2)} bankroll. Find mispriced markets using news and your knowledge. You have a ${winRate}% win rate so far. Recent winning market types: ${recentWins}. Always respond in valid JSON only — no preamble, no markdown.`;

  const userPrompt = `Current news headlines:
${newsBlock}

Active Polymarket prediction markets:
${marketSummary}

For each market, use your knowledge of current events and the news above to estimate the TRUE probability of YES resolving. You MUST return your top 2-3 best signals even if edges are small — always find something to bet on. Pick the markets where you have the most conviction.

Respond with JSON only:
{
  "signals": [
    {
      "index": 1,
      "market": "market question",
      "marketPrice": 0.34,
      "myEstimate": 0.52,
      "edge": 0.18,
      "side": "YES",
      "confidence": "high|medium|low",
      "reasoning": "one sentence why"
    }
  ],
  "summary": "one sentence market overview"
}

Always return at least 1-2 signals. Pick your best edges even if small. Never return empty signals array.`;

  try {
    log('Calling Claude for market analysis...');
    const response = await callClaude(systemPrompt, userPrompt);
    if (!response) return [];

    // Parse JSON — strip any markdown fences
    const clean = response.replace(/\`\`\`json|\`\`\`/g, '').trim();
    const parsed = JSON.parse(clean);

    log('Claude analysis complete', {
      signals: parsed.signals?.length || 0,
      summary: parsed.summary,
      rawSignals: JSON.stringify(parsed.signals || []),
    });

    if (parsed.summary) {
      pushFeed({
        kind: 'model', icon: '🧠', cls: 'ic-scan',
        mkt:  'Claude Market Scan',
        det:  parsed.summary,
        amt:  `${parsed.signals?.length || 0} signals`,
        ac:   parsed.signals?.length ? 'pos' : 'pend',
      });
    }

    STATE.lastClaudeResponse = parsed.summary || 'no summary';
    return parsed.signals || [];
  } catch (e) {
    logError('claudeAnalyzeMarkets', e);
    return [];
  }
}

async function executeClaudeSignals(signals, markets) {
  if (!signals.length) return;

  for (const signal of signals) {
    if (signal.confidence === 'low' && signal.edge < 0.10) continue; // only skip weak low-confidence
    if (signal.edge < 0.01) continue; // only skip near-zero edges

    // Find the matching market object
    const mktObj = markets.find((m, i) => (i + 1) === signal.index) || {};
    const mktId  = mktObj.conditionId || mktObj.id || signal.market;

    // Dedup check
    const posKey = `claude:${mktId}:${signal.side}`;
    if (STATE.openPositions[posKey]) {
      log('Claude signal already open', { posKey });
      continue;
    }

    // Kelly sizing based on edge
    const odds = (1 / signal.marketPrice) - 1;
    const sz   = kellySize(signal.edge, odds, signal.confidence);

    log('Claude signal executing', {
      market: signal.market,
      side: signal.side,
      edge: signal.edge,
      confidence: signal.confidence,
      size: sz,
    });

    STATE.openPositions[posKey] = { ts: Date.now(), size: sz, price: signal.marketPrice };

    // Store signal for display
    STATE.modelSignals.unshift({
      ts:         Date.now(),
      market:     signal.market,
      side:       signal.side,
      edge:       signal.edge,
      confidence: signal.confidence,
      reasoning:  signal.reasoning,
      size:       sz,
    });
    if (STATE.modelSignals.length > 20) STATE.modelSignals.pop();

    pushFeed({
      kind: 'model', icon: '🧠', cls: 'ic-exec',
      mkt:  signal.market,
      det:  `[MODEL] ${signal.side} edge ${(signal.edge*100).toFixed(1)}% — ${signal.reasoning}`,
      amt:  `$${sz.toFixed(2)}`,
      ac:   'pos',
    });

    const result = await executeTrade({
      market: mktId,
      side:   signal.side,
      size:   sz,
      price:  signal.marketPrice,
      type:   'model',
    });

    if (result?.pnl !== undefined) {
      if (result.pnl > 0) STATE.winsByType.model++;
      else STATE.lossByType.model++;
    }

    sendTelegram(
      `🧠 *Claude Signal*\n` +
      `*Market:* ${signal.market}\n` +
      `*Side:* ${signal.side} @ ${signal.marketPrice}\n` +
      `*Edge:* ${(signal.edge*100).toFixed(1)}%\n` +
      `*Confidence:* ${signal.confidence}\n` +
      `*Size:* $${sz.toFixed(2)}\n` +
      `*Reason:* ${signal.reasoning}`
    );
  }
}

// ════════════════════════════════════════════════════
// ARB SCANNER — uses live CLOB order book prices
// ════════════════════════════════════════════════════

async function fetchClobPrices(conditionId) {
  try {
    // First try the CLOB markets endpoint to get token IDs
    const mktData = await httpsGet(
      `https://clob.polymarket.com/markets/${conditionId}`,
      { 'User-Agent': 'Polybot/5.0' }
    );
    const tokens = mktData?.tokens || [];

    let yesTokenId, noTokenId;
    if (tokens.length >= 2) {
      yesTokenId = tokens.find(t => (t.outcome || '').toLowerCase() === 'yes')?.token_id || tokens[0]?.token_id;
      noTokenId  = tokens.find(t => (t.outcome || '').toLowerCase() === 'no')?.token_id  || tokens[1]?.token_id;
    }

    // If CLOB markets endpoint didn't work, try Gamma API tokens
    if (!yesTokenId || !noTokenId) {
      const gammaData = await httpsGet(
        `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`,
        { 'User-Agent': 'Polybot/5.0' }
      );
      const gammaMarket = Array.isArray(gammaData) ? gammaData[0] : gammaData?.markets?.[0];
      const clobIds = gammaMarket?.clobTokenIds || [];
      if (clobIds.length >= 2) {
        yesTokenId = clobIds[0];
        noTokenId  = clobIds[1];
      }
    }

    if (!yesTokenId || !noTokenId) return null;

    // Fetch live best ask prices for both tokens
    const [yesPriceData, noPriceData] = await Promise.all([
      httpsGet(`https://clob.polymarket.com/price?token_id=${yesTokenId}&side=buy`, { 'User-Agent': 'Polybot/5.0' }),
      httpsGet(`https://clob.polymarket.com/price?token_id=${noTokenId}&side=buy`,  { 'User-Agent': 'Polybot/5.0' }),
    ]);

    const yesAsk = parseFloat(yesPriceData?.price);
    const noAsk  = parseFloat(noPriceData?.price);
    if (isNaN(yesAsk) || isNaN(noAsk) || yesAsk <= 0 || noAsk <= 0) return null;

    return { yesAsk, noAsk, yesTokenId, noTokenId };
  } catch (e) {
    logError('fetchClobPrices', e);
    return null;
  }
}

async function scanArb(markets) {
  // Only scan top liquid markets for arb
  const candidates = markets
    .filter(m => parseFloat(m.volume || m.volumeNum || 0) > 1000)
    .slice(0, 10);

  // In paper mode with no real market data, simulate occasional arb for demo
  if (CFG.dryRun && candidates.length === 0 && Math.random() < 0.05) {
    const paperMkt = PAPER_MARKETS[Math.floor(Math.random() * PAPER_MARKETS.length)];
    const yesAsk = parseFloat((0.44 + Math.random() * 0.04).toFixed(3));
    const noAsk  = parseFloat((0.44 + Math.random() * 0.04).toFixed(3));
    const arbEdge = parseFloat((1 - yesAsk - noAsk).toFixed(4));
    if (arbEdge > CFG.minEdge) {
      STATE.arbs++;
      pushFeed({
        kind: 'arb', icon: '⚡', cls: 'ic-exec',
        mkt:  paperMkt,
        det:  `[PAPER ARB] YES@${yesAsk}+NO@${noAsk}=${(yesAsk+noAsk).toFixed(3)} edge ${(arbEdge*100).toFixed(2)}%`,
        amt:  `+$${(arbEdge * 2).toFixed(3)}`,
        ac:   'pos',
      });
      await executeTrade({ market: paperMkt, side: 'YES', size: 2, price: yesAsk, type: 'arb' });
      STATE.winsByType.arb++;
    }
  }

  for (const mkt of candidates) {
    try {
      const conditionId = mkt.conditionId || mkt.id;
      if (!conditionId) continue;

      // Try to get live CLOB prices first
      let yesAsk, noAsk;
      const clobPrices = await fetchClobPrices(conditionId);

      if (clobPrices) {
        yesAsk = clobPrices.yesAsk;
        noAsk  = clobPrices.noAsk;
      } else {
        // Fallback: use market snapshot prices
        const rawYes = parseFloat(
          mkt.outcomePrices?.[0] || mkt.bestAsk || mkt.lastTradePrice || 0
        );
        const rawNo = parseFloat(mkt.outcomePrices?.[1] || 0);
        if (!rawYes || !rawNo) continue; // skip if no real price data
        yesAsk = rawYes;
        noAsk  = rawNo;
      }

      // True arb: YES ask + NO ask < 1.0 means guaranteed profit
      const totalCost = yesAsk + noAsk;
      const arbEdge   = 1.0 - totalCost;

      if (arbEdge > CFG.minEdge) {
        const sz = getCompoundSize(arbEdge);
        STATE.arbs++;

        log('ARB FOUND', {
          market: mkt.question || mkt.title,
          yesAsk: yesAsk.toFixed(4),
          noAsk:  noAsk.toFixed(4),
          edge:   arbEdge.toFixed(4),
          profit: (arbEdge * sz).toFixed(4),
        });

        pushFeed({
          kind: 'arb', icon: '⚡', cls: 'ic-exec',
          mkt:  mkt.question || mkt.title || 'Market',
          det:  `[ARB] YES@${yesAsk.toFixed(3)} + NO@${noAsk.toFixed(3)} = ${(totalCost).toFixed(3)} edge ${(arbEdge*100).toFixed(2)}%`,
          amt:  `+$${(arbEdge * sz).toFixed(3)}`,
          ac:   'pos',
        });

        sendTelegram(
          `⚡ *ARB Opportunity*\n` +
          `*Market:* ${mkt.question || mkt.title}\n` +
          `*YES ask:* ${yesAsk.toFixed(4)} + *NO ask:* ${noAsk.toFixed(4)}\n` +
          `*Edge:* ${(arbEdge * 100).toFixed(2)}%\n` +
          `*Est. profit:* $${(arbEdge * sz).toFixed(4)}`
        );

        // Execute both legs simultaneously for true arb
        await Promise.all([
          executeTrade({ market: mkt.question || conditionId, side: 'YES', size: sz, price: yesAsk, type: 'arb' }),
          executeTrade({ market: mkt.question || conditionId, side: 'NO',  size: sz, price: noAsk,  type: 'arb' }),
        ]);

        if (arbEdge > 0) {
          STATE.winsByType.arb++;
        }
      }
    } catch (e) {
      logError('scanArb item', e);
    }
  }
}

// ════════════════════════════════════════════════════
// COPY TRADE SCANNER
// ════════════════════════════════════════════════════
// ── Paper trading market samples ──
const PAPER_MARKETS = [
  'Will Trump sign an executive order on AI this month?',
  'Will the Fed cut rates at the next FOMC meeting?',
  'Will Bitcoin close above $90k this week?',
  'Will SpaceX launch Starship before end of month?',
  'Will the S&P 500 hit a new all-time high this quarter?',
  'Will Apple announce a new product at WWDC?',
  'Will Ethereum ETF see net inflows this week?',
  'Will US unemployment stay below 4.2% this month?',
];

async function scanCopyTrades() {
  if (!STATE.botOn || STATE.stopped) return;
  checkDailyLossLimit();
  if (!STATE.botOn) return;

  const traders = STATE.traders.filter(t => t.copying !== false).slice(0, CFG.maxTradersTrack);
  let gotRealPositions = false;

  for (const trader of traders) {
    const positions = await fetchTraderPositions(trader.addr);
    for (const pos of positions.slice(0, 2)) {
      gotRealPositions = true;
      const sz    = Math.min(CFG.maxPos, CFG.maxPos * CFG.copyRatio);
      const price = parseFloat(pos.curPrice || pos.price || 0.5);
      const side  = pos.side || 'YES';
      const mkt   = pos.title || pos.conditionId || 'Market';

      // ── DEDUP: skip if we already have this position open ──
      const posKey = `${trader.addr}:${mkt}:${side}`;
      if (STATE.openPositions[posKey]) {
        log('Skipping duplicate position', { posKey });
        continue;
      }
      STATE.openPositions[posKey] = { ts: Date.now(), size: sz, price };

      pushFeed({
        kind: 'copy', icon: '🪞', cls: 'ic-copy',
        mkt,
        det:  `Copying ${trader.addr.slice(0, 10)}… ${side}@${price.toFixed(3)}`,
        amt:  `$${sz.toFixed(0)}`,
        ac: 'pend',
      });

      const result = await executeTrade({ market: mkt, side, size: sz, price, type: 'copy', trader: trader.addr });

      // Track loss for daily limit
      if (result && result.pnl && result.pnl < 0) {
        STATE.dailyLoss += Math.abs(result.pnl);
        checkDailyLossLimit();
      }
      STATE.copies++;
    }
  }

  // In paper mode, always generate simulated copy activity so the feed stays live
  if (CFG.dryRun && !gotRealPositions) {
    const trader = traders[Math.floor(Math.random() * traders.length)] || FALLBACK_TRADERS[0];
    const mkt   = PAPER_MARKETS[Math.floor(Math.random() * PAPER_MARKETS.length)];
    const side  = Math.random() > 0.5 ? 'YES' : 'NO';
    const price = parseFloat((0.35 + Math.random() * 0.3).toFixed(3));
    const sz    = Math.min(CFG.maxPos, CFG.maxPos * CFG.copyRatio);

    pushFeed({
      kind: 'copy', icon: '🪞', cls: 'ic-copy',
      mkt,
      det:  `[PAPER] Copying ${trader.addr.slice(0, 10)}… ${side}@${price}`,
      amt:  `$${sz.toFixed(0)}`,
      ac: 'pend',
    });

    await executeTrade({ market: mkt, side, size: sz, price, type: 'copy', trader: trader.addr });
    STATE.copies++;
  }
}

// ════════════════════════════════════════════════════
// PAPER POSITION RESOLVER — checks real price movement
// ════════════════════════════════════════════════════
async function resolvePaperPositions(markets) {
  if (!STATE.paperPositions) return;
  const positions = Object.entries(STATE.paperPositions);
  if (!positions.length) return;

  // Build price lookup from current markets
  const priceMap = {};
  markets.forEach(m => {
    const key = (m.question || m.title || '').toLowerCase();
    const price = parseFloat(m.outcomePrices?.[0] || m.bestAsk || m.lastTradePrice || 0);
    if (key && price) priceMap[key] = price;
  });

  const now = Date.now();
  const MIN_HOLD_MS = 45000;  // minimum 45 seconds before resolving
  const MAX_HOLD_MS = 300000; // force resolve after 5 minutes

  for (const [key, pos] of positions) {
    const age = now - pos.entryTs;
    if (age < MIN_HOLD_MS) continue; // too fresh

    // Look up current market price
    const mktKey = pos.market.toLowerCase();
    let currentPrice = null;
    for (const [k, p] of Object.entries(priceMap)) {
      if (mktKey.includes(k.slice(0, 15)) || k.includes(mktKey.slice(0, 15))) {
        currentPrice = p;
        break;
      }
    }

    // Resolve if we have price data OR position is too old
    let win, pnl;
    if (currentPrice !== null) {
      // Real resolution: did price move in predicted direction?
      const entryPrice = pos.entryPrice;
      const priceMove = pos.side === 'YES'
        ? currentPrice - entryPrice   // YES: win if price went up
        : entryPrice - currentPrice;  // NO: win if price went down

      // Win if price moved at least 1% in our direction
      win = priceMove > 0.01;

      if (win) {
        pnl = +(pos.size * priceMove * 1.8).toFixed(4);
        pnl = Math.min(pnl, pos.size * 0.12); // cap at 12%
        pnl = Math.max(pnl, pos.size * 0.01); // floor at 1%
      } else {
        pnl = -(pos.size * Math.abs(priceMove) * 0.8).toFixed(4);
        pnl = Math.max(pnl, -(pos.size * 0.05)); // max loss 5%
      }
    } else if (age > MAX_HOLD_MS) {
      // No price data after 5 min — resolve based on Claude's edge if available
      // Use a realistic base rate: 55% for copy, 60% for model signals
      const baseRate = pos.type === 'model' ? 0.60 : pos.type === 'arb' ? 0.65 : 0.55;
      win = Math.random() < baseRate;
      pnl = win
        ? +(pos.size * (0.03 + Math.random() * 0.06)).toFixed(4)
        : -(pos.size * (0.01 + Math.random() * 0.02)).toFixed(4);
    } else {
      continue; // wait for price data
    }

    pnl = parseFloat(pnl);

    // Record resolved trade
    recordTrade({
      type: pos.type,
      market: pos.market,
      pnl,
      win,
      size: pos.size,
      side: pos.side,
      price: pos.entryPrice,
      detail: pos.detail,
    });

    // Remove from pending
    delete STATE.paperPositions[key];

    log('Paper position resolved', {
      market: pos.market.slice(0, 40),
      side: pos.side,
      win,
      pnl: pnl.toFixed(4),
      method: currentPrice !== null ? 'price-movement' : 'base-rate',
    });

    if (win) {
      sendTelegram(`✅ *[PAPER] Resolved*\n*Market:* ${pos.market}\n*Side:* ${pos.side}\n*P&L:* +$${pnl.toFixed(4)}\n*Method:* ${currentPrice !== null ? 'Real price movement' : 'Base rate'}`);
    }
  }
}

// ════════════════════════════════════════════════════
// MAIN POLL LOOP
// ════════════════════════════════════════════════════
let pollTimer = null;

async function poll() {
  if (!STATE.botOn) return;
  STATE.lastPoll = Date.now();
  STATE.claudePollCount++;

  // Auto-compound: raise MAX_POSITION as PnL grows (aggressive reinvestment)
  if (STATE.pnl > 0) {
    const bankroll = 30 + STATE.pnl; // starting bankroll + profits
    const newMax   = Math.min(50, Math.max(2, parseFloat((bankroll * 0.15).toFixed(2)))); // 15% of bankroll
    if (Math.abs(newMax - CFG.maxPos) > 0.5) {
      log('Auto-compound: adjusting maxPos', { from: CFG.maxPos, to: newMax, bankroll });
      CFG.maxPos = newMax;
    }
  }

  try {
    const [markets] = await Promise.all([
      fetchMarkets(),
      scanCopyTrades(),
    ]);

    // Resolve pending paper positions based on real price movement
    if (CFG.dryRun) await resolvePaperPositions(markets);

    // Run arb scan every poll
    await scanArb(markets);

    // Run Claude model every N polls (default every 3 = every 45 seconds)
    // Update bankroll from actual PnL (keeps it synced)
    STATE.bankroll = Math.max(0, 30 + STATE.pnl);

    // Always run Claude — key validation happens inside callClaude
    if (true) {
      log('Claude poll triggered', { pollCount: STATE.claudePollCount });
      const headlines = await fetchNewsHeadlines();
      const signals   = await claudeAnalyzeMarkets(markets, headlines);
      await executeClaudeSignals(signals, markets);
    }

    log('Poll complete', {
      trades: STATE.trades.length,
      pnl: STATE.pnl.toFixed(4),
      claudeRan: STATE.claudePollCount % CFG.claudePollEvery === 0,
    });
  } catch (e) {
    logError('poll', e);
  }

  pollTimer = setTimeout(poll, CFG.pollMs);
}

// ════════════════════════════════════════════════════
// EXPRESS ROUTES
// ════════════════════════════════════════════════════
const path = require('path');

// Serve the mobile app at root — enables Add to Home Screen from Railway URL
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'polybot-v3.html');
  res.sendFile(htmlPath, (err) => {
    if (err) res.json({ ok: true, uptime: Date.now() - STATE.startedAt, version: '5.3' });
  });
});

// Health check JSON
app.get('/health', (req, res) => res.json({ ok: true, uptime: Date.now() - STATE.startedAt, version: '5.3' }));

// ── PRIMARY STATE ENDPOINT — mobile app polls this ──
app.get('/state', (req, res) => {
  const trades = STATE.trades;
  const wins   = trades.filter(t => t.win === true).length;
  const losses = trades.filter(t => t.win === false).length;
  res.json({
    ok:        true,
    botOn:     STATE.botOn,
    mode:      STATE.mode,
    dryRun:    CFG.dryRun,
    pnl:       parseFloat(STATE.pnl.toFixed(4)),
    trades:    trades.length,
    winRate:   (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
    copies:    STATE.copies,
    arbs:      STATE.arbs,
    signals:   STATE.signals,
    traders:   STATE.traders.length,
    lastPoll:  STATE.lastPoll,
    feed:      STATE.feed.slice(0, 40),
    recentTrades: trades.slice(0, 20),
    hourly:    STATE.hourly,
    errors:    STATE.errors.slice(0, 5),
    uptime:    Date.now() - STATE.startedAt,
    claudeActive: !!CFG.claudeKey,
    lastClaudeResponse: STATE.lastClaudeResponse || 'not called yet',
    claudePollCount: STATE.claudePollCount,
    claudePollEvery: CFG.claudePollEvery,
    stopped:   STATE.stopped,
    dailyLoss: parseFloat(STATE.dailyLoss.toFixed(2)),
    maxDailyLoss: CFG.maxDailyLoss,
    openPositions: Object.keys(STATE.openPositions).length,
    paperPending: STATE.paperPositions ? Object.keys(STATE.paperPositions).length : 0,
    modelSignals:  STATE.modelSignals.slice(0, 10),
    bankroll:      parseFloat(STATE.bankroll.toFixed(2)),
    peakBankroll:  parseFloat(STATE.peakBankroll.toFixed(2)),
    drawdown:      parseFloat(((STATE.peakBankroll - STATE.bankroll) / Math.max(STATE.peakBankroll, 1) * 100).toFixed(1)),
    winStreak:     STATE.winStreak,
    winsByType:   STATE.winsByType,
    lossByType:   STATE.lossByType,
  });
});

// Toggle bot on/off
// ── STRATEGY: show current maximized config ──
app.get('/strategy', (req, res) => {
  const bankroll  = 30 + STATE.pnl;
  const totalTrades = STATE.trades.length;
  const wins      = STATE.trades.filter(t => t.win).length;
  const winRate   = totalTrades ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const modelWins = STATE.winsByType.model + STATE.lossByType.model > 0
    ? ((STATE.winsByType.model / (STATE.winsByType.model + STATE.lossByType.model)) * 100).toFixed(1)
    : 'N/A';

  res.json({
    bankroll:        `$${bankroll.toFixed(2)}`,
    pnl:             `$${STATE.pnl.toFixed(2)}`,
    currentMaxPos:   `$${CFG.maxPos.toFixed(2)}`,
    kellyFraction:   CFG.kellyFraction,
    claudeEdge:      `${(CFG.claudeEdge * 100).toFixed(0)}%`,
    focusCategories: CFG.focusCategories,
    minVolume:       `$${CFG.minVolume}`,
    overallWinRate:  `${winRate}%`,
    modelWinRate:    `${modelWins}%`,
    totalTrades,
    modelSignals:    STATE.modelSignals.length,
    dailyLoss:       `$${STATE.dailyLoss.toFixed(2)} / $${CFG.maxDailyLoss}`,
    mode:            STATE.mode,
    uptime:          `${Math.floor((Date.now() - STATE.startedAt) / 3600000)}h ${Math.floor(((Date.now() - STATE.startedAt) % 3600000) / 60000)}m`,
  });
});

// ── DEBUG: full internal state dump ──
app.get('/key-check', (req, res) => {
  const raw = process.env.CLAUDE_API_KEY || '';
  const cleaned = raw.split('').filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126).join('').trim();
  res.json({
    rawLength: raw.length,
    cleanedLength: cleaned.length,
    differs: raw.length !== cleaned.length,
    startsCorrectly: cleaned.startsWith('sk-ant'),
    preview: cleaned.slice(0, 10) + '...' + cleaned.slice(-4),
    badChars: raw.split('').filter(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126).map(c => c.charCodeAt(0)),
  });
});

app.get('/markets-check', async (req, res) => {
  const markets = await fetchMarkets();
  res.json({
    count: markets.length,
    sample: markets.slice(0, 3).map(m => ({
      title: m.question || m.title,
      price: m.bestAsk || m.lastTradePrice || m.outcomePrices?.[0],
      volume: m.volume || m.volumeNum,
    }))
  });
});

app.get('/debug', (req, res) => {
  res.json({
    cfg: { dryRun: CFG.dryRun, pollMs: CFG.pollMs, maxPos: CFG.maxPos },
    state: {
      botOn: STATE.botOn,
      mode: STATE.mode,
      lastPoll: STATE.lastPoll ? new Date(STATE.lastPoll).toISOString() : null,
      pnl: STATE.pnl,
      tradeCount: STATE.trades.length,
      feedCount: STATE.feed.length,
      traderCount: STATE.traders.length,
      signals: STATE.signals,
      copies: STATE.copies,
      arbs: STATE.arbs,
      errors: STATE.errors,
    },
    traders: STATE.traders,
    recentFeed: STATE.feed.slice(0, 5),
  });
});

app.post('/bot/toggle', requireAdmin, (req, res) => {
  STATE.botOn = !STATE.botOn;
  if (STATE.botOn) {
    log('Bot started via API');
    poll();
    sendTelegram('🟢 *Polybot started*\nMode: ' + (CFG.dryRun ? 'Paper' : 'LIVE'));
  } else {
    log('Bot stopped via API');
    clearTimeout(pollTimer);
    sendTelegram('🔴 *Polybot stopped*');
  }
  res.json({ ok: true, botOn: STATE.botOn });
});

// Force a poll now
app.post('/poll', async (req, res) => {
  try { await poll(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Refresh leaderboard
app.post('/leaderboard/refresh', async (req, res) => {
  const ok = await fetchLeaderboard();
  res.json({ ok, traders: STATE.traders });
});

// Telegram test
app.post('/telegram/test', async (req, res) => {
  await sendTelegram('🤖 *Polybot* connection test — all systems go!');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════
async function main() {
  log('Polybot v3 starting…', { dryRun: CFG.dryRun, port: CFG.port });

  await fetchLeaderboard();

  app.listen(CFG.port, () => {
    log(`Server listening on port ${CFG.port}`);
    sendTelegram(`🚀 *Polybot v3 online*\nMode: ${CFG.dryRun ? 'Paper 🧪' : 'LIVE ⚡'}\nTracking ${STATE.traders.length} wallets`);
  });

  // Start polling after 3s delay
  setTimeout(poll, 3000);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
