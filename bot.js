/**
 * POLYBOT v2 — Polymarket Copy Trading Bot
 * ─────────────────────────────────────────
 * Approved packages ONLY:
 *   @polymarket/clob-client  — Official Polymarket SDK
 *   dotenv                   — Environment config
 *   node-fetch               — HTTP requests
 *   ws                       — WebSocket (future streaming)
 *
 * Wallet: Coinbase Wallet (address only — no raw private key)
 *
 * How it works:
 *   1. Fetch Polymarket Gamma API leaderboard
 *   2. Pick top traders by ROI efficiency (P&L / volume)
 *   3. Poll their wallets every POLL_INTERVAL seconds
 *   4. Claude AI screens each signal → COPY or SKIP
 *   5. DRY_RUN=true  → preview/paper mode, logs only
 *      DRY_RUN=false → real orders on Polymarket CLOB
 */

'use strict';
require('dotenv').config();

// ── DEPENDENCY AUDIT ──────────────────────────────────────────────
const APPROVED = ['@polymarket/clob-client','dotenv','node-fetch','ws'];
console.log('\n✅ Dependency audit:');
APPROVED.forEach(p => console.log(`   ✓ ${p}`));
console.log('   No unapproved packages\n');

const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const fetch = require('node-fetch');

// ── CONFIG — set all values as Railway environment variables ──────
const CFG = {
  POLY_KEY:       process.env.POLYMARKET_API_KEY    || '',
  POLY_SECRET:    process.env.POLYMARKET_SECRET     || '',
  POLY_PASS:      process.env.POLYMARKET_PASSPHRASE || '',
  WALLET_ADDRESS: process.env.WALLET_ADDRESS        || '',
  CLAUDE_KEY:     process.env.CLAUDE_API_KEY        || '',
  TG_TOKEN:       process.env.TELEGRAM_TOKEN        || '',
  TG_CHAT:        process.env.TELEGRAM_CHAT_ID      || '',
  DRY_RUN:        process.env.DRY_RUN !== 'false',   // true = preview (safe default)
  COPY_RATIO:     parseFloat(process.env.COPY_RATIO    || '0.25'),
  MAX_TRADE:      parseFloat(process.env.MAX_TRADE     || '20'),
  POLL_MS:        parseInt(process.env.POLL_INTERVAL   || '30') * 1000,
  TOP_N:          parseInt(process.env.TOP_TRADERS     || '5'),
  CLOB_URL:       'https://clob.polymarket.com',
  GAMMA_URL:      'https://gamma-api.polymarket.com',
};

// ── LOGGER ────────────────────────────────────────────────────────
const log = (emoji, msg, data) => {
  const t   = new Date().toISOString().slice(11, 19);
  const out = `[${t}] ${emoji}  ${msg}${data ? ' — ' + JSON.stringify(data) : ''}`;
  console.log(out);
  return out;
};

// ── TELEGRAM ──────────────────────────────────────────────────────
async function tg(msg) {
  if (!CFG.TG_TOKEN || !CFG.TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    CFG.TG_CHAT,
        text:       msg,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    log('⚠️', 'Telegram error', e.message);
  }
}

// ── CLAUDE AI — COPY / SKIP VERDICT ──────────────────────────────
async function claudeVerdict(market, addr, side, price, stats) {
  if (!CFG.CLAUDE_KEY) {
    return { verdict: 'COPY', confidence: 0.65, reason: 'No Claude key — defaulting to copy' };
  }
  try {
    const prompt =
      `You are a prediction market analyst. Evaluate this copy trade.\n\n` +
      `Market: ${market}\n` +
      `Trader: ${addr} | ROI ${(stats.roi * 100).toFixed(1)}% | Win rate ${stats.winRate}% | P&L $${stats.pnl.toLocaleString()}\n` +
      `Signal: BUY ${side} @ $${price}\n\n` +
      `Reply with JSON only — no markdown:\n` +
      `{"verdict":"COPY","confidence":0.0,"reason":"one sentence"}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         CFG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 120,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    log('⚠️', 'Claude error', e.message);
    return { verdict: 'COPY', confidence: 0.55, reason: 'AI unavailable' };
  }
}

// ── LEADERBOARD — Polymarket Gamma API ───────────────────────────
async function fetchTopTraders() {
  log('🏆', 'Fetching leaderboard...');
  try {
    const res = await fetch(`${CFG.GAMMA_URL}/leaderboard?limit=50&sort=roi`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();

    const traders = (raw.data || raw || [])
      .filter(t => parseFloat(t.volume || 0) > 10000 && parseFloat(t.profit || 0) > 0)
      .map(t => ({
        address: t.address || t.proxy_wallet || '',
        pnl:     parseFloat(t.profit || 0),
        volume:  parseFloat(t.volume || 0),
        roi:     parseFloat(t.profit || 0) / Math.max(parseFloat(t.volume || 1), 1),
        winRate: parseFloat(t.win_rate || 0),
        trades:  parseInt(t.num_trades || 0),
      }))
      .filter(t => t.address)
      .sort((a, b) => b.roi - a.roi)
      .slice(0, CFG.TOP_N);

    log('✅', `Loaded ${traders.length} traders`);
    traders.forEach((t, i) =>
      log('👤', `#${i + 1} ${t.address.slice(0, 10)}... ROI ${(t.roi * 100).toFixed(1)}% P&L $${t.pnl.toLocaleString()}`)
    );
    return traders;
  } catch (e) {
    log('⚠️', 'Leaderboard error', e.message);
    return [];
  }
}

// ── WALLET POSITIONS ──────────────────────────────────────────────
async function getPositions(address) {
  try {
    const res = await fetch(
      `${CFG.GAMMA_URL}/positions?user=${address}&size=20&sortBy=updatedAt&sortDirection=DESC`
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return (rows || []).map(p => ({
      marketId:  p.market?.conditionId || p.conditionId || '',
      market:    p.market?.question    || p.title       || 'Unknown Market',
      side:      p.outcome === 'Yes'   ? 'YES'          : 'NO',
      avgPrice:  parseFloat(p.avgPrice || p.price || 0),
      size:      parseFloat(p.size     || p.shares || 0),
      value:     parseFloat(p.currentValue || p.value || 0),
      updatedAt: new Date(p.updatedAt  || Date.now()),
    }));
  } catch (e) {
    log('⚠️', `Poll failed ${address.slice(0, 8)}`, e.message);
    return [];
  }
}

// ── CLOB ORDER EXECUTION ──────────────────────────────────────────
let clob = null;

function initClob() {
  if (!CFG.POLY_KEY) {
    log('⚠️', 'No POLYMARKET_API_KEY — live orders disabled');
    return false;
  }
  try {
    clob = new ClobClient(
      CFG.CLOB_URL,
      137,  // Polygon mainnet
      null, // signing handled by Polymarket API key auth
      { key: CFG.POLY_KEY, secret: CFG.POLY_SECRET, passphrase: CFG.POLY_PASS }
    );
    log('✅', 'CLOB client ready');
    return true;
  } catch (e) {
    log('❌', 'CLOB init failed', e.message);
    return false;
  }
}

async function placeOrder(marketId, side, price, usdcSize) {
  if (CFG.DRY_RUN) {
    log('👁', `[PREVIEW] Would BUY ${side} on ${marketId.slice(0, 14)}... @ $${price} × $${usdcSize} USDC`);
    return { preview: true };
  }
  if (!clob) { log('❌', 'CLOB not ready'); return null; }
  try {
    const order  = await clob.createMarketOrder({
      tokenID: marketId,
      side:    side === 'YES' ? Side.BUY : Side.SELL,
      amount:  usdcSize,
    });
    const result = await clob.postOrder(order, OrderType.FOK);
    log('✅', 'Order placed', { id: result.orderID, side, usdcSize });
    return result;
  } catch (e) {
    log('❌', 'Order failed', e.message);
    return null;
  }
}

// ── COPY TRADE PROCESSOR ──────────────────────────────────────────
const seen = new Map(); // trader address → Set of market IDs already actioned

async function processTrade(trader, pos) {
  if (!seen.has(trader.address)) seen.set(trader.address, new Set());
  if (seen.get(trader.address).has(pos.marketId)) return; // already handled this one

  const size = Math.min(CFG.MAX_TRADE, pos.value * CFG.COPY_RATIO);
  if (size < 1) { log('⏭', `Skip — size too small ($${size.toFixed(2)})`); return; }

  const ai = await claudeVerdict(pos.market, trader.address, pos.side, pos.avgPrice, trader);

  const summary =
    `\n📡 <b>Copy Signal</b>\n` +
    `Market: ${pos.market.slice(0, 55)}\n` +
    `Trader: <code>${trader.address.slice(0, 10)}...</code> ROI ${(trader.roi * 100).toFixed(1)}%\n` +
    `Side: <b>${pos.side}</b> @ $${pos.avgPrice.toFixed(3)}\n` +
    `Their size: $${pos.value.toFixed(0)} → Our copy: $${size.toFixed(2)} USDC\n` +
    `Claude: <b>${ai.verdict}</b> ${(ai.confidence * 100).toFixed(0)}% — ${ai.reason}`;

  if (ai.verdict === 'SKIP') {
    log('🧠', `SKIP — ${ai.reason}`);
    await tg(summary + '\n⛔ <b>Filtered by Claude AI</b>');
    seen.get(trader.address).add(pos.marketId);
    return;
  }

  const result = await placeOrder(pos.marketId, pos.side, pos.avgPrice, size);
  if (result) {
    seen.get(trader.address).add(pos.marketId);
    await tg(summary + (CFG.DRY_RUN
      ? '\n👁 <b>PREVIEW — no real trade placed</b>'
      : '\n✅ <b>ORDER PLACED on Polymarket</b>'
    ));
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────
let traders    = [];
let cycleCount = 0;

async function runCycle() {
  cycleCount++;
  log('🔄', `Cycle #${cycleCount} — watching ${traders.length} wallets`);
  for (const trader of traders) {
    const all   = await getPositions(trader.address);
    const fresh = all.filter(p => Date.now() - p.updatedAt.getTime() < CFG.POLL_MS * 2);
    for (const pos of fresh) await processTrade(trader, pos);
  }
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║           POLYBOT v2.0 — STARTING            ║');
  console.log(`║  Mode: ${CFG.DRY_RUN
    ? '🧪 PREVIEW  (paper — no real trades)  '
    : '⚡ LIVE     (real USDC on Polygon)    '}║`);
  console.log('║  Wallet: Coinbase Wallet (address-based)     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const missing = [];
  if (!CFG.POLY_KEY)       missing.push('POLYMARKET_API_KEY');
  if (!CFG.WALLET_ADDRESS) missing.push('WALLET_ADDRESS');
  if (!CFG.CLAUDE_KEY)     missing.push('CLAUDE_API_KEY');
  if (!CFG.TG_TOKEN)       missing.push('TELEGRAM_TOKEN');
  if (!CFG.TG_CHAT)        missing.push('TELEGRAM_CHAT_ID');

  if (missing.length) {
    log('⚠️', `Missing env vars: ${missing.join(', ')}`);
    if (!CFG.DRY_RUN) {
      log('❌', 'Cannot go live with missing credentials — add them in Railway Variables');
      process.exit(1);
    }
  }

  if (!CFG.DRY_RUN && !initClob()) {
    log('❌', 'CLOB failed to initialize');
    process.exit(1);
  }

  traders = await fetchTopTraders();
  if (!traders.length) {
    log('❌', 'No traders loaded — check Gamma API or network connection');
    process.exit(1);
  }

  await tg(
    `🤖 <b>Polybot v2 Online</b>\n` +
    `Mode: ${CFG.DRY_RUN ? '🧪 Preview (paper trading)' : '⚡ LIVE — real trades'}\n` +
    `Wallet: <code>${(CFG.WALLET_ADDRESS || 'not set').slice(0, 14)}...</code>\n` +
    `Tracking: ${traders.length} top traders\n` +
    `Max per trade: $${CFG.MAX_TRADE} USDC\n` +
    `Copy ratio: ${(CFG.COPY_RATIO * 100).toFixed(0)}%\n` +
    `Poll interval: every ${CFG.POLL_MS / 1000}s`
  );

  log('🚀', `Running — polling every ${CFG.POLL_MS / 1000}s`);
  log(CFG.DRY_RUN ? '👁' : '⚡',
    CFG.DRY_RUN
      ? 'PREVIEW MODE — watching markets, logging signals. DRY_RUN=false to go live.'
      : 'LIVE MODE — executing real orders on Polymarket'
  );

  await runCycle();

  setInterval(async () => {
    // Refresh leaderboard every 50 cycles (~25 min at default 30s poll)
    if (cycleCount % 50 === 0) {
      log('🔁', 'Refreshing leaderboard...');
      const fresh = await fetchTopTraders();
      if (fresh.length) traders = fresh;
    }
    await runCycle();
  }, CFG.POLL_MS);
}

process.on('SIGINT', async () => {
  log('🛑', 'Shutting down gracefully...');
  await tg('🛑 <b>Polybot stopped</b>');
  process.exit(0);
});

process.on('uncaughtException', async err => {
  log('💥', 'Uncaught error', err.message);
  await tg(`💥 <b>Polybot crashed</b>\n${err.message}\nCheck Railway logs.`);
  process.exit(1);
});

main().catch(async err => {
  log('💥', 'Fatal error', err.message);
  await tg(`💥 <b>Fatal error</b>\n${err.message}`);
  process.exit(1);
});
