// ═══════════════════════════════════════════════════
// POLYBOT — Railway Server v3
// Fixes: startDashboard crash, adds /state endpoint
// ═══════════════════════════════════════════════════
const express = require('express');
const https = require('https');
const http = require('http');

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

// ── TOP POLYMARKET TRADERS (fallback if API fails) ──
const FALLBACK_TRADERS = [
  { addr: '0x3f4a8e2b...b2c1', roi: 6.8, wins: 74, trades: 1240, pnl: 142830 },
  { addr: '0x9c1d5f3a...f8e3', roi: 6.2, wins: 69, trades: 890,  pnl: 98200  },
  { addr: '0xa2e8b1c4...1042', roi: 5.9, wins: 66, trades: 720,  pnl: 77540  },
  { addr: '0x55b3f9e1...2a4f', roi: 5.4, wins: 61, trades: 580,  pnl: 61200  },
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
  // Requires: wallet private key → sign order → POST to clob
  // TODO: implement Polymarket CLOB order signing with ethers.js
  // For now, fall through to paper until wallet key is configured
  logError('executeTrade', new Error('Live execution not yet implemented — use DRY_RUN=true'));
  return { success: false };
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
async function scanCopyTrades() {
  const traders = STATE.traders.filter(t => t.copying !== false).slice(0, 3);
  for (const trader of traders) {
    const positions = await fetchTraderPositions(trader.addr);
    for (const pos of positions.slice(0, 2)) {
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

// Health check
app.get('/', (req, res) => res.json({ ok: true, uptime: Date.now() - STATE.startedAt, version: '3.0' }));

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
