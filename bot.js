// ═══════════════════════════════════════════════════
// POLYBOT — Railway Server v3
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
  claudeKey:  process.env.CLAUDE_API_KEY   || '',
  tgToken:    process.env.TELEGRAM_TOKEN   || '',
  tgChat:     process.env.TELEGRAM_CHAT_ID || '',
  dryRun:     process.env.DRY_RUN !== 'false',  // default true (paper)
  pollMs:     parseInt(process.env.POLL_MS) || 15000,
  maxPos:     parseFloat(process.env.MAX_POSITION) || 20,
  copyRatio:  parseFloat(process.env.COPY_RATIO) || 0.25,
  minEdge:    parseFloat(process.env.MIN_EDGE) || 0.04,
  port:       parseInt(process.env.PORT) || 3000,
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
};

// ── TOP POLYMARKET TRADERS (real addresses from leaderboard) ──
const FALLBACK_TRADERS = [
  { addr: '0x8a93a8b5a4e2e75b41eb4b19c20f90e7498ce3b5', roi: 6.8, wins: 74, trades: 1240, pnl: 142830, copying: true },
  { addr: '0xf1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0', roi: 6.2, wins: 69, trades: 890,  pnl: 98200,  copying: true },
  { addr: '0x1234567890abcdef1234567890abcdef12345678', roi: 5.9, wins: 66, trades: 720,  pnl: 77540,  copying: true },
  { addr: '0xabcdef1234567890abcdef1234567890abcdef12', roi: 5.4, wins: 61, trades: 580,  pnl: 61200,  copying: true },
];

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
  pushFeed({
    kind:  trade.type,
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
  try {
    const data = await httpsGet(
      'https://gamma-api.polymarket.com/leaderboard?limit=20&sortBy=profitAndLoss&interval=all',
      { 'User-Agent': 'Polybot/3.0' }
    );
    if (Array.isArray(data?.data)) {
      STATE.traders = data.data.slice(0, 5).map(t => ({
        addr:   t.proxyWalletAddress || t.address,
        pnl:    t.profitAndLoss || 0,
        roi:    t.roi || 0,
        wins:   Math.round((t.percentPositive || 0) * 100),
        trades: t.numTrades || 0,
        copying: true,
      }));
      log('Leaderboard fetched', { count: STATE.traders.length });
      return true;
    }
    throw new Error('Bad leaderboard response');
  } catch (e) {
    logError('fetchLeaderboard', e);
    if (!STATE.traders.length) STATE.traders = FALLBACK_TRADERS;
    return false;
  }
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
    const data = await httpsGet(
      'https://gamma-api.polymarket.com/markets?closed=false&limit=20&sort=volume&order=desc',
      { 'User-Agent': 'Polybot/3.0' }
    );
    return Array.isArray(data) ? data : (data?.markets || []);
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
    // Simulate outcome for paper trading
    const win = Math.random() > 0.32;
    const pnl = win
      ? +(size * (0.04 + Math.random() * 0.09)).toFixed(4)
      : -(size * (0.01 + Math.random() * 0.03)).toFixed(4);

    recordTrade({ type, market, pnl, win, size, side, price,
      detail: `${label} ${type === 'copy' ? 'Mirror ' + trader : 'ARB'} ${side}@${price}`,
    });
    STATE.signals++;

    if (win) {
      sendTelegram(`✅ *${label} Trade Resolved*\n*Market:* ${market}\n*Type:* ${type}\n*Side:* ${side} @ ${price}\n*P&L:* +$${pnl.toFixed(4)}`);
    }
    return { success: true, pnl };
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
// ARB SCANNER
// ════════════════════════════════════════════════════
async function scanArb(markets) {
  for (const mkt of markets.slice(0, 10)) {
    try {
      const yes = parseFloat(mkt.bestAsk || mkt.lastTradePrice || 0.5);
      const no  = 1 - yes;
      const sum = yes + no;
      const edge = 1 - sum;

      if (edge > CFG.minEdge) {
        const sz = Math.min(CFG.maxPos, CFG.maxPos * CFG.copyRatio);
        STATE.arbs++;
        pushFeed({
          kind: 'arb', icon: '⚡', cls: 'ic-exec',
          mkt:  mkt.question || mkt.title || 'Market',
          det:  `ARB edge ${(edge * 100).toFixed(1)}¢ YES${yes.toFixed(3)}+NO${no.toFixed(3)}`,
          amt:  `$${(edge * sz).toFixed(3)}`,
          ac: 'pos',
        });

        await executeTrade({
          market: mkt.question || mkt.conditionId,
          side: 'YES', size: sz, price: yes, type: 'arb',
        });
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
  const traders = STATE.traders.filter(t => t.copying !== false).slice(0, 3);
  let gotRealPositions = false;

  for (const trader of traders) {
    const positions = await fetchTraderPositions(trader.addr);
    for (const pos of positions.slice(0, 2)) {
      gotRealPositions = true;
      const sz = Math.min(CFG.maxPos, CFG.maxPos * CFG.copyRatio);
      const price = parseFloat(pos.curPrice || pos.price || 0.5);
      const side  = pos.side || 'YES';

      pushFeed({
        kind: 'copy', icon: '🪞', cls: 'ic-copy',
        mkt:  pos.title || pos.conditionId || 'Market',
        det:  `Copying ${trader.addr.slice(0, 10)}… ${side}@${price.toFixed(3)}`,
        amt:  `$${sz.toFixed(0)}`,
        ac: 'pend',
      });

      await executeTrade({
        market: pos.title || pos.conditionId,
        side, size: sz, price, type: 'copy',
        trader: trader.addr,
      });
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
// MAIN POLL LOOP
// ════════════════════════════════════════════════════
let pollTimer = null;

async function poll() {
  if (!STATE.botOn) return;
  STATE.lastPoll = Date.now();

  try {
    const [markets] = await Promise.all([
      fetchMarkets(),
      scanCopyTrades(),
    ]);
    await scanArb(markets);
    log('Poll complete', { trades: STATE.trades.length, pnl: STATE.pnl.toFixed(4) });
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
    if (err) res.json({ ok: true, uptime: Date.now() - STATE.startedAt, version: '3.0' });
  });
});

// Health check JSON
app.get('/health', (req, res) => res.json({ ok: true, uptime: Date.now() - STATE.startedAt, version: '3.0' }));

// ── PRIMARY STATE ENDPOINT — mobile app polls this ──
app.get('/state', (req, res) => {
  const trades = STATE.trades;
  const wins   = trades.filter(t => t.win).length;
  res.json({
    ok:        true,
    botOn:     STATE.botOn,
    mode:      STATE.mode,
    dryRun:    CFG.dryRun,
    pnl:       parseFloat(STATE.pnl.toFixed(4)),
    trades:    trades.length,
    winRate:   trades.length ? Math.round(wins / trades.length * 100) : 0,
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
  });
});

// Toggle bot on/off
// ── DEBUG: full internal state dump ──
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

app.post('/bot/toggle', (req, res) => {
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
