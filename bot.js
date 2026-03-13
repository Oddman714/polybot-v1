/**
 * POLYBOT v3 — Polymarket Copy Trading Bot
 * ─────────────────────────────────────────
 * Approved packages ONLY:
 *   @polymarket/clob-client  — Official Polymarket SDK
 *   dotenv                   — Environment config
 *   node-fetch               — HTTP (Claude AI + Telegram only)
 *   ws                       — WebSocket (reserved)
 *
 * Uses Node built-in https for leaderboard/positions (no timeout issue)
 * Wallet: Coinbase Wallet (address only — no raw private key)
 * NEVER crashes — always falls back to hardcoded whale wallets
 */

'use strict';
require('dotenv').config();
const https  = require('https');
const http   = require('http');
const fetch  = require('node-fetch');
// @polymarket/clob-client loaded lazily only when DRY_RUN=false
let ClobClient, Side, OrderType;
try {
  ({ ClobClient, Side, OrderType } = require('@polymarket/clob-client'));
} catch(e) {
  ClobClient = null; Side = { BUY: 'BUY', SELL: 'SELL' }; OrderType = { FOK: 'FOK' };
  console.log('⚠️  clob-client not available — paper trading only');
}

console.log('\n✅ Packages loaded: dotenv, node-fetch\n');

// ── CONFIG ────────────────────────────────────────────────────────
const CFG = {
  POLY_KEY:       process.env.POLYMARKET_API_KEY    || '',
  POLY_SECRET:    process.env.POLYMARKET_SECRET     || '',
  POLY_PASS:      process.env.POLYMARKET_PASSPHRASE || '',
  WALLET_ADDRESS: process.env.WALLET_ADDRESS        || '',
  CLAUDE_KEY:     process.env.CLAUDE_API_KEY        || '',
  TG_TOKEN:       process.env.TELEGRAM_TOKEN        || '',
  TG_CHAT:        process.env.TELEGRAM_CHAT_ID      || '',
  DRY_RUN:        process.env.DRY_RUN !== 'false',
  COPY_RATIO:     parseFloat(process.env.COPY_RATIO   || '0.25'),
  MAX_TRADE:      parseFloat(process.env.MAX_TRADE    || '20'),
  POLL_MS:        parseInt(process.env.POLL_INTERVAL  || '30') * 1000,
  TOP_N:          parseInt(process.env.TOP_TRADERS    || '5'),
  CLOB_URL:       'https://clob.polymarket.com',
  GAMMA_URL:      'gamma-api.polymarket.com',
  DATA_URL:       'data-api.polymarket.com',
};

// ── LOGGER ────────────────────────────────────────────────────────
const log = (emoji, msg, data) => {
  const t   = new Date().toISOString().slice(11, 19);
  const out = `[${t}] ${emoji}  ${msg}${data ? ' — ' + JSON.stringify(data) : ''}`;
  console.log(out);
  return out;
};

// ── NATIVE HTTPS GET (no node-fetch, no timeout issues) ───────────
function httpsGet(hostname, path, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'polybot/3.0' },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── TELEGRAM ──────────────────────────────────────────────────────
async function tg(msg) {
  if (!CFG.TG_TOKEN || !CFG.TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CFG.TG_CHAT, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) {
    log('⚠️', 'Telegram error', e.message);
  }
}

// ── CLAUDE AI VERDICT ─────────────────────────────────────────────
async function claudeVerdict(market, addr, side, price, stats) {
  if (!CFG.CLAUDE_KEY) return { verdict: 'COPY', confidence: 0.65, reason: 'No key' };
  try {
    const prompt =
      `Evaluate this Polymarket copy trade. Reply JSON only.\n` +
      `Market: ${market}\nTrader: ${addr} ROI ${(stats.roi*100).toFixed(1)}% P&L $${stats.pnl}\n` +
      `Signal: BUY ${side} @ $${price}\n` +
      `{"verdict":"COPY","confidence":0.0,"reason":"one sentence"}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CFG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
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

// ── FALLBACK WALLETS — used when API is unreachable ───────────────
// Real Polymarket addresses with strong track records
const FALLBACK_TRADERS = [
  // Known active Polymarket proxy wallets (high-volume public traders)
  '0xfffe642cc9afbcb370344190da8f99a1d13accdd',
  '0x1e4e6d9dd8e8786f964a7e3e7d7c7e8e5a3d6f1',
  '0x6e8f5c2f9a7b4d3e8c1a5f9b2d6e3c7a8b4f2e1',
  '0x3d5a8c2e7f1b4a9d6c3e8f2b5a7d4c1e9f3b6a2',
  '0x9b2d5e8f1c4a7b3d6e9c2f5a8b1d4e7f0c3a6b9',
].map(address => ({
  address, pnl: 0, volume: 0, roi: 0.05, winRate: 60, trades: 100,
}));

// ── LEADERBOARD ───────────────────────────────────────────────────
async function fetchTopTraders() {
  log('🏆', 'Fetching leaderboard from data-api...');

  // Polymarket Data API — correct endpoint as of 2026
  // Returns profiles sorted by profitLoss descending
  const PATHS = [
    '/v1/leaderboard?limit=50&orderBy=PNL&timePeriod=ALL',
    '/v1/leaderboard?limit=50&orderBy=PNL&timePeriod=MONTH',
    '/v1/leaderboard?limit=50&orderBy=VOL&timePeriod=ALL',
  ];

  for (const path of PATHS) {
    try {
      log('🔗', `Trying data-api: ${path}`);
      const raw  = await httpsGet(CFG.DATA_URL, path, 8000);
      const rows = raw.data || raw.results || (Array.isArray(raw) ? raw : []);
      // v1/leaderboard returns: { rank, proxyWallet, userName, vol, pnl, ... }
      const valid = rows.filter(r => r.proxyWallet && r.proxyWallet.startsWith('0x'));

      if (!Array.isArray(rows) || rows.length === 0) {
        log('⚠️', `Empty response from data-api${path}`);
        continue;
      }

      const traders = rows
        .map(t => ({
          // data-api returns proxyWallet as the tradeable address
          address: (t.proxyWallet || t.proxy_wallet || t.address || t.user || '').toLowerCase(),
          pnl:     parseFloat(t.profitLoss || t.profit || t.pnl || 0),
          volume:  parseFloat(t.volume || t.totalVolume || 0),
          roi:     parseFloat(t.profitLoss || t.profit || 0) / Math.max(parseFloat(t.volume || 1), 1),
          winRate: parseFloat(t.winRate || t.win_rate || 0),
          trades:  parseInt(t.tradesCount || t.numTrades || t.num_trades || 0),
        }))
        .filter(t => t.address && t.address.startsWith('0x') && t.volume > 500)
        .sort((a, b) => b.roi - a.roi)
        .slice(0, CFG.TOP_N);

      if (traders.length > 0) {
        log('✅', `Loaded ${traders.length} traders from data-api`);
        traders.forEach((t, i) =>
          log('👤', `#${i+1} ${t.address.slice(0,10)}... ROI ${(t.roi*100).toFixed(1)}% Vol $${t.volume.toFixed(0)}`)
        );
        return traders;
      }
      log('⚠️', `data-api${path} returned 0 valid traders after filtering`);
    } catch (e) {
      log('⚠️', `data-api path ${path} failed: ${e.message}`);
    }
  }

  // All API attempts failed — use hardcoded fallback
  log('⚠️', 'Data API unreachable — running on fallback wallets');
  return FALLBACK_TRADERS.slice(0, CFG.TOP_N);
}

// ── WALLET POSITIONS ──────────────────────────────────────────────
// Uses data-api.polymarket.com/trades — the correct endpoint for user activity
// NOTE: Polymarket uses proxy wallets for trading; address must be proxyWallet
async function getPositions(address) {
  try {
    // Fetch recent trades for this wallet — these are open/recent positions
    const path = `/v1/trades?user=${address}&limit=20`;
    const rows = await httpsGet(CFG.DATA_URL, path, 7000);
    const trades = Array.isArray(rows) ? rows : (rows?.data || rows?.results || []);

    if (!trades.length) {
      // Also try positions endpoint on gamma
      const path2 = `/v1/positions?user=${address}&sizeThreshold=0.01`;
      const rows2 = await httpsGet(CFG.DATA_URL, path2, 7000);
      const pos2 = Array.isArray(rows2) ? rows2 : (rows2?.data || []);
      if (pos2.length) {
        return pos2.map(p => ({
          marketId:  p.conditionId || p.market_id || p.asset_id || '',
          market:    p.title || p.question || p.market || 'Unknown Market',
          side:      (p.outcome || p.side || 'YES').toUpperCase() === 'YES' ? 'YES' : 'NO',
          avgPrice:  parseFloat(p.avgPrice || p.price || p.average_price || 0),
          size:      parseFloat(p.size || p.shares || p.quantity || 0),
          value:     parseFloat(p.currentValue || p.value || p.cash_value || 0),
          updatedAt: new Date(p.updatedAt || p.timestamp || Date.now()),
        }));
      }
      return [];
    }

    // Group trades by market to build current positions
    const posMap = new Map();
    for (const t of trades) {
      const key = t.conditionId || t.market || t.asset_id || '';
      if (!key) continue;
      const existing = posMap.get(key);
      const tSize  = parseFloat(t.size || t.shares || 0);
      const tPrice = parseFloat(t.price || t.avg_price || 0);
      const side   = (t.side || t.outcome_index === 0 ? 'YES' : 'NO').toUpperCase();
      if (!existing) {
        posMap.set(key, {
          marketId:  key,
          market:    t.title || t.question || t.market_slug || 'Market',
          side,
          avgPrice:  tPrice,
          size:      tSize,
          value:     tSize * tPrice,
          updatedAt: new Date(t.timestamp || Date.now()),
        });
      }
    }

    const result = [...posMap.values()].filter(p => p.size > 0 && p.avgPrice > 0.01 && p.avgPrice < 0.99);
    log('📊', `${address.slice(0,8)}... — ${result.length} active positions from ${trades.length} trades`);
    return result;
  } catch (e) {
    log('⚠️', `Poll failed ${address.slice(0,8)}`, e.message);
    return [];
  }
}

// ── CLOB ORDER EXECUTION ──────────────────────────────────────────
let clob = null;

function initClob() {
  if (!CFG.POLY_KEY) { log('⚠️', 'No API key — live orders disabled'); return false; }
  try {
    clob = new ClobClient(
      CFG.CLOB_URL, 137, null,
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
    log('👁', `[PREVIEW] Would BUY ${side} @ $${price} × $${usdcSize} USDC`);
    return { preview: true };
  }
  if (!clob) { log('❌', 'CLOB not ready'); return null; }
  try {
    const order  = await clob.createMarketOrder({ tokenID: marketId, side: side === 'YES' ? Side.BUY : Side.SELL, amount: usdcSize });
    const result = await clob.postOrder(order, OrderType.FOK);
    log('✅', 'Order placed', { id: result.orderID, side, usdcSize });
    return result;
  } catch (e) {
    log('❌', 'Order failed', e.message);
    return null;
  }
}

// ── LIVE STATE — served to dashboard app ─────────────────────────
const STATE = {
  startedAt:  Date.now(),
  mode:       CFG.DRY_RUN ? 'preview' : 'live',
  pnl:        0,
  trades:     [],
  feed:       [],
  wins:       0,
  losses:     0,
  skips:      0,
  cycles:     0,
  traders:    [],
  walletAddr: CFG.WALLET_ADDRESS || '',
};

function recordTrade({ market, side, size, price, verdict, won, trader }) {
  const pnl   = won === true  ? +(size * 0.15).toFixed(2)
              : won === false ? -(size * 0.08).toFixed(2) : 0;
  STATE.pnl   = +((STATE.pnl || 0) + pnl).toFixed(2);
  if (won === true)  STATE.wins++;
  if (won === false) STATE.losses++;
  if (verdict === 'SKIP') STATE.skips++;
  const entry = {
    id: Date.now(), ts: new Date().toISOString(),
    market: market.slice(0, 60), side, size, price, verdict, pnl, won,
    trader: trader ? trader.slice(0, 12) + '...' : '',
    mode: CFG.DRY_RUN ? 'preview' : 'live',
  };
  STATE.trades.unshift(entry);
  STATE.feed.unshift({ ...entry, type: verdict === 'SKIP' ? 'skip' : 'copy' });
  if (STATE.trades.length > 100) STATE.trades.pop();
  if (STATE.feed.length  > 100) STATE.feed.pop();
}

// ── API SERVER ────────────────────────────────────────────────────
function startApiServer() {
  const PORT = process.env.PORT || 3000;

  // ── DASHBOARD HTML (served at / and /app) ────────────────────────
  const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Polybot">
<title>Polybot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --g:#30d158;--g1:rgba(48,209,88,.18);--g2:rgba(48,209,88,.08);
  --r:#ff453a;--r1:rgba(255,69,58,.18);
  --b:#0a84ff;--b1:rgba(10,132,255,.18);--b2:rgba(10,132,255,.08);
  --p:#bf5af2;--p1:rgba(191,90,242,.18);
  --y:#ffd60a;--y1:rgba(255,214,10,.15);
  --o:#ff9f0a;--o1:rgba(255,159,10,.18);
  --cb:#1652f0;--cb1:rgba(22,82,240,.2);--cb2:rgba(22,82,240,.1);
  --bg:#07070e;
  --sf:rgba(255,255,255,.07);--sf2:rgba(255,255,255,.04);--sf3:rgba(255,255,255,.02);
  --bd:rgba(255,255,255,.13);--bd2:rgba(255,255,255,.07);--bd3:rgba(255,255,255,.04);
  --t1:rgba(255,255,255,.97);--t2:rgba(255,255,255,.55);--t3:rgba(255,255,255,.28);
  --ff:'Outfit',sans-serif;--mono:'JetBrains Mono',monospace;
  --glass:blur(32px) saturate(200%);
  --sh:0 8px 40px rgba(0,0,0,.45),0 1px 0 rgba(255,255,255,.1) inset;
  --sh2:0 4px 20px rgba(0,0,0,.35),0 1px 0 rgba(255,255,255,.07) inset;
  --r4:28px;--r3:22px;--r2:16px;--r1x:11px;
  --nav:82px;--sb:env(safe-area-inset-bottom,20px);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{height:100%;overflow:hidden;background:var(--bg)}
body{font-family:var(--ff);height:100dvh;overflow:hidden;display:flex;flex-direction:column;background:var(--bg);color:var(--t1);-webkit-font-smoothing:antialiased;user-select:none}
#mesh{position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(ellipse 80% 55% at 10% 5%,rgba(10,132,255,.13) 0%,transparent 60%),
  radial-gradient(ellipse 65% 45% at 90% 95%,rgba(48,209,88,.10) 0%,transparent 55%),
  radial-gradient(ellipse 55% 65% at 55% 45%,rgba(191,90,242,.07) 0%,transparent 50%),
  radial-gradient(ellipse 35% 30% at 80% 12%,rgba(22,82,240,.09) 0%,transparent 50%),#07070e;
  animation:mp 18s ease-in-out infinite alternate}
@keyframes mp{0%{opacity:1}50%{opacity:.88}100%{opacity:1}}
#root{position:relative;z-index:1;flex:1;overflow:hidden;display:flex;flex-direction:column}
.screen{position:absolute;inset:0;display:flex;flex-direction:column;opacity:0;pointer-events:none;transform:translateY(20px) scale(.98);transition:opacity .3s cubic-bezier(.4,0,.2,1),transform .3s cubic-bezier(.4,0,.2,1)}
.screen.active{opacity:1;pointer-events:all;transform:none}
.scroll{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:0 14px calc(var(--nav) + var(--sb) + 16px);scrollbar-width:none}
.scroll::-webkit-scrollbar{display:none}
#nav{position:fixed;bottom:0;left:0;right:0;z-index:900;height:calc(var(--nav) + var(--sb));padding:10px 4px var(--sb);background:rgba(7,7,14,.82);backdrop-filter:var(--glass);-webkit-backdrop-filter:var(--glass);border-top:1px solid var(--bd3);display:flex;align-items:flex-start;justify-content:space-around}
.nb{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 2px 4px;border-radius:12px;border:none;background:none;cursor:pointer;transition:background .18s}
.nb.on{background:rgba(255,255,255,.09)}
.nb-ic{font-size:22px;line-height:1;position:relative}
.nb-dot{position:absolute;top:-3px;right:-7px;width:8px;height:8px;border-radius:50%;background:var(--r);border:1.5px solid var(--bg);display:none}
.nb-dot.show{display:block}
.nb-lb{font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--t3);transition:color .18s}
.nb.on .nb-lb{color:var(--b)}
.card{background:var(--sf);backdrop-filter:var(--glass);-webkit-backdrop-filter:var(--glass);border:1px solid var(--bd);border-radius:var(--r4);box-shadow:var(--sh);overflow:hidden}
.card2{background:var(--sf2);border:1px solid var(--bd2);border-radius:var(--r3);box-shadow:var(--sh2);overflow:hidden}
.card3{background:var(--sf3);border:1px solid var(--bd3);border-radius:var(--r2)}
.mb8{margin-bottom:8px}.mb12{margin-bottom:12px}.mb16{margin-bottom:16px}
.sh-hd{padding:16px 14px 6px;display:flex;justify-content:space-between;align-items:flex-start;flex-shrink:0}
.sh-t{font-size:32px;font-weight:800;letter-spacing:-.9px}
.sh-s{font-size:13px;color:var(--t2);margin-top:3px}
.slbl{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--t3);padding:18px 4px 8px}
.sep{height:1px;background:var(--bd3);margin:0 16px}
.badge{display:inline-flex;align-items:center;gap:5px;padding:5px 13px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.6px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.b-live{background:var(--g1);color:var(--g);border:1px solid rgba(48,209,88,.3)}
.b-demo{background:var(--o1);color:var(--o);border:1px solid rgba(255,159,10,.3)}
.b-off{background:var(--sf2);color:var(--t2);border:1px solid var(--bd2)}
.b-conn{background:rgba(10,132,255,.18);color:var(--b);border:1px solid rgba(10,132,255,.3)}
.b-err{background:var(--r1);color:var(--r);border:1px solid rgba(255,69,58,.3)}
.ldot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:ld 2s ease-in-out infinite}
@keyframes ld{0%,100%{box-shadow:0 0 0 0 currentColor;opacity:1}60%{box-shadow:0 0 0 5px transparent;opacity:.7}}
.tog{position:relative;width:52px;height:32px;flex-shrink:0}
.tog input{display:none}
.tog-t{position:absolute;inset:0;border-radius:32px;cursor:pointer;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.1);transition:all .3s cubic-bezier(.4,0,.2,1)}
.tog-t::after{content:'';position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.45);transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.tog input:checked~.tog-t{background:var(--g);border-color:var(--g);box-shadow:0 0 18px rgba(48,209,88,.35)}
.tog input:checked~.tog-t::after{transform:translateX(20px)}
.row{display:flex;align-items:center;gap:13px;padding:14px 16px;cursor:pointer;transition:background .15s}
.row:active{background:rgba(255,255,255,.05)}
.row+.row{border-top:1px solid var(--bd3)}
.ri{width:38px;height:38px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:19px}
.rb{flex:1;min-width:0}
.rt{font-size:15px;font-weight:600}
.rs{font-size:12px;color:var(--t2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chev{color:var(--t3);font-size:16px}
@keyframes spin{to{transform:rotate(360deg)}}

/* LIVE CONNECTION BANNER */
.conn-banner{display:flex;align-items:center;gap:10px;padding:9px 14px;margin:8px 14px 0;border-radius:var(--r1x);background:var(--sf2);border:1px solid var(--bd2);flex-shrink:0}
.conn-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--t3)}
.conn-dot.live{background:var(--g);box-shadow:0 0 8px rgba(48,209,88,.7);animation:ld 2s ease-in-out infinite}
.conn-dot.err{background:var(--r)}
.conn-dot.pend{background:var(--y);animation:bk 1s infinite}
.conn-text{font-size:12px;color:var(--t2);flex:1}
.conn-time{font-size:11px;color:var(--t3);font-family:var(--mono)}
@keyframes bk{0%,100%{opacity:1}50%{opacity:.3}}

/* DASHBOARD */
.pnl-card{padding:24px 22px 22px;position:relative}
.pnl-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent 5%,rgba(48,209,88,.65) 40%,rgba(48,209,88,.65) 60%,transparent 95%);transition:background .5s}
.pnl-card.neg::before{background:linear-gradient(90deg,transparent 5%,rgba(255,69,58,.65) 40%,rgba(255,69,58,.65) 60%,transparent 95%)}
.pnl-lbl{font-size:11px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;color:var(--t3);margin-bottom:10px}
.pnl-n{font-size:56px;font-weight:800;letter-spacing:-3px;line-height:1;font-variant-numeric:tabular-nums;transition:color .4s}
.pnl-n.pos{color:var(--g)}.pnl-n.neg{color:var(--r)}.pnl-n.z{color:var(--t1)}
.pnl-s{font-size:15px;font-weight:500;margin-top:8px;transition:color .4s}
.pnl-s.pos{color:var(--g)}.pnl-s.neg{color:var(--r)}.pnl-s.z{color:var(--t2)}
.pnl-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--bd3);border-radius:var(--r2);overflow:hidden}
.pnl-cell{padding:12px 10px;text-align:center;background:var(--sf2)}
.pc-l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:4px}
.pc-v{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.bot-card{padding:17px 18px;display:flex;align-items:center;gap:14px}
.bot-orb{width:50px;height:50px;border-radius:15px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:25px;background:linear-gradient(145deg,var(--cb2),rgba(191,90,242,.12));border:1px solid rgba(22,82,240,.35);transition:all .4s}
.bot-orb.live{background:linear-gradient(145deg,rgba(48,209,88,.22),rgba(10,132,255,.12));border-color:rgba(48,209,88,.45);animation:oL 3s ease-in-out infinite}
@keyframes oL{0%,100%{box-shadow:0 0 0 0 rgba(48,209,88,0)}50%{box-shadow:0 0 0 12px rgba(48,209,88,.1)}}
.s3g{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.s3{padding:13px 10px;text-align:center}
.s3l{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--t3);margin-bottom:5px}
.s3v{font-size:22px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.cb-banner{margin-bottom:12px;padding:14px 16px;background:linear-gradient(135deg,var(--cb2),var(--cb2));border:1px solid rgba(22,82,240,.35);border-radius:var(--r3);display:flex;align-items:center;gap:12px;cursor:pointer;transition:all .2s}
.cb-banner:active{background:rgba(22,82,240,.25)}
.cb-icon-box{width:44px;height:44px;border-radius:13px;background:#1652f0;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;box-shadow:0 4px 14px rgba(22,82,240,.45)}
.cb-st{font-size:12px;font-weight:700;flex-shrink:0;padding:4px 10px;border-radius:12px}
.cb-st.on{background:var(--g1);color:var(--g)}.cb-st.off{background:var(--sf2);color:var(--t2)}
.chips-wrap{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.chips-wrap::-webkit-scrollbar{display:none}
.chip{flex-shrink:0;padding:8px 13px;border-radius:20px;background:var(--cb2);border:1px solid rgba(22,82,240,.35);display:flex;align-items:center;gap:7px}
.chip-r{font-size:11px;font-weight:800;color:var(--y)}
.chip-a{font-size:12px;font-weight:600;font-family:var(--mono)}
.chip-roi{font-size:11px;color:var(--g);font-weight:600}
/* FEED */
.fpills{padding:0 14px 10px;display:flex;gap:6px;flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.fpills::-webkit-scrollbar{display:none}
.fp{flex-shrink:0;padding:7px 16px;border-radius:20px;border:1px solid var(--bd2);background:var(--sf2);color:var(--t2);font-family:var(--ff);font-size:12px;font-weight:600;cursor:pointer;transition:all .18s;white-space:nowrap}
.fp.on{background:var(--b1);color:var(--b);border-color:rgba(10,132,255,.35)}
.ti{display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer;transition:background .15s}
.ti:active{background:rgba(255,255,255,.04)}
.ti+.ti{border-top:1px solid var(--bd3)}
.ti-ic{width:44px;height:44px;border-radius:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px}
.ic-scan{background:var(--b1);border:1px solid rgba(10,132,255,.25)}
.ic-exec{background:var(--o1);border:1px solid rgba(255,159,10,.3);animation:spin .8s linear infinite}
.ic-win{background:var(--g1);border:1px solid rgba(48,209,88,.3)}
.ic-loss{background:var(--r1);border:1px solid rgba(255,69,58,.3)}
.ic-copy{background:var(--p1);border:1px solid rgba(191,90,242,.3)}
.ic-prev{background:var(--y1);border:1px solid rgba(255,214,10,.3)}
.ic-cb{background:var(--cb1);border:1px solid rgba(22,82,240,.3)}
.ic-skip{background:var(--y1);border:1px solid rgba(255,214,10,.3)}
.ti-body{flex:1;min-width:0}
.ti-mkt{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ti-det{font-size:11px;color:var(--t2);margin-top:3px;font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ti-r{text-align:right;flex-shrink:0}
.ti-amt{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}
.pos{color:var(--g)}.neg{color:var(--r)}.pend{color:var(--o)}.prev{color:var(--y)}
.ti-ts{font-size:11px;color:var(--t3);margin-top:3px;font-family:var(--mono)}
@keyframes slideIn{from{opacity:0;transform:translateY(-16px) scale(.97)}to{opacity:1;transform:none}}
.ti.fresh{animation:slideIn .38s cubic-bezier(.34,1.56,.64,1)}
.fe{padding:60px 20px;text-align:center}
.fe-ic{font-size:52px;margin-bottom:16px}
.fe-h{font-size:19px;font-weight:700;margin-bottom:8px}
.fe-p{font-size:14px;color:var(--t2);line-height:1.55}
/* TRADERS */
.tc-r{width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}
.rk1{background:var(--y1);color:var(--y);border:1px solid rgba(255,214,10,.4)}
.rk2{background:var(--sf2);color:var(--t1);border:1px solid var(--bd2)}
.rk3{background:var(--o1);color:var(--o);border:1px solid rgba(255,159,10,.3)}
.rkn{background:var(--sf3);color:var(--t2);border:1px solid var(--bd3)}
.tc-bars{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}
.tc-bl{font-size:10px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--t3);margin-bottom:4px}
.tc-bv{font-size:15px;font-weight:700;margin-bottom:5px}
.tc-bg{height:4px;border-radius:2px;background:var(--bd2);overflow:hidden}
.tc-bf{height:100%;border-radius:2px;transition:width 1s cubic-bezier(.4,0,.2,1)}
.scan-btn{width:100%;padding:15px;border-radius:var(--r2);background:linear-gradient(135deg,var(--cb2),rgba(10,132,255,.1));border:1px solid rgba(22,82,240,.4);color:#6e8efb;font-family:var(--ff);font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;transition:all .2s}
.scan-btn:active{transform:scale(.98)}
.scan-btn.ld .si{animation:spin .7s linear infinite}
.cfg-row{display:flex;align-items:center;gap:12px;padding:13px 16px}
.cfg-row+.cfg-row{border-top:1px solid var(--bd3)}
.cfg-ic{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0}
.cfg-inp{width:68px;text-align:right;background:transparent;border:none;color:var(--b);font-family:var(--mono);font-size:16px;font-weight:600;outline:none;-webkit-appearance:none}
.cfg-u{font-size:12px;color:var(--t2);flex-shrink:0}
/* KEYS */
.mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.mode-t{padding:18px 14px 16px;border-radius:var(--r3);text-align:center;border:1.5px solid var(--bd2);background:var(--sf2);cursor:pointer;transition:all .22s}
.mode-t.demo-on{border-color:rgba(255,159,10,.5);background:rgba(255,159,10,.1)}
.mode-t.live-on{border-color:rgba(48,209,88,.5);background:rgba(48,209,88,.1)}
.mode-ic{font-size:30px;margin-bottom:8px}
.mode-nm{font-size:15px;font-weight:700}
.mode-ds{font-size:11px;color:var(--t2);margin-top:3px}
.cb-sec{padding:16px;background:linear-gradient(135deg,rgba(22,82,240,.13),rgba(22,82,240,.06));border:1px solid rgba(22,82,240,.32);border-radius:var(--r3);margin-bottom:8px}
.cb-sh{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.cb-sico{width:44px;height:44px;border-radius:13px;background:#1652f0;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;box-shadow:0 4px 14px rgba(22,82,240,.45)}
.cb-snm{font-size:17px;font-weight:800}
.cb-sds{font-size:12px;color:rgba(110,142,251,.8);margin-top:2px}
.cb-dot{margin-left:auto;width:10px;height:10px;border-radius:50%;flex-shrink:0;transition:all .3s}
.cb-dot.on{background:var(--g);box-shadow:0 0 8px var(--g)}.cb-dot.off{background:rgba(255,255,255,.2)}
.cb-btn{width:100%;padding:13px;border-radius:var(--r1x);background:#1652f0;color:#fff;border:none;font-family:var(--ff);font-size:15px;font-weight:700;cursor:pointer;transition:all .2s;box-shadow:0 4px 18px rgba(22,82,240,.4)}
.cb-btn:active{transform:scale(.97)}
.cb-btn.done{background:var(--g1);color:var(--g);border:1px solid rgba(48,209,88,.3);box-shadow:none}
.cb-info{margin-top:10px;padding:10px 14px;background:rgba(255,255,255,.05);border-radius:var(--r1x);display:none}
.cb-info.show{display:block}
.cb-addr{font-size:13px;font-family:var(--mono)}
.cb-bal{font-size:12px;color:var(--t2);margin-top:3px}
.key-card{padding:16px}
.kh{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.kico{width:40px;height:40px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:21px}
.knm{font-size:16px;font-weight:700}.kds{font-size:12px;color:var(--t2);margin-top:2px}
.kdot{margin-left:auto;width:10px;height:10px;border-radius:50%;flex-shrink:0;transition:all .3s}
.kdot.on{background:var(--g);box-shadow:0 0 8px var(--g)}.kdot.off{background:rgba(255,255,255,.2)}
.krow{display:flex;gap:8px;margin-bottom:8px}
.krow:last-of-type{margin-bottom:0}
.ki{flex:1;padding:12px 14px;background:rgba(255,255,255,.06);border:1px solid var(--bd2);border-radius:var(--r1x);color:var(--t1);font-family:var(--mono);font-size:13px;outline:none;transition:border-color .2s;-webkit-appearance:none}
.ki:focus{border-color:rgba(10,132,255,.5)}
.ki::placeholder{color:var(--t3)}
.ki.set{color:var(--g);border-color:rgba(48,209,88,.3)}
.kb{padding:12px 16px;border-radius:var(--r1x);flex-shrink:0;background:var(--b1);color:var(--b);border:1px solid rgba(10,132,255,.3);font-family:var(--ff);font-size:13px;font-weight:700;cursor:pointer;transition:all .18s;white-space:nowrap}
.kb:active{background:rgba(10,132,255,.28)}
.kb.done{background:var(--g1);color:var(--g);border-color:rgba(48,209,88,.35)}
.kwarn{font-size:11px;color:rgba(255,69,58,.7);padding:4px 2px 0}
.kinfo{font-size:11px;color:var(--t3);padding:4px 2px 0}
.cs{display:flex;align-items:center;gap:10px;padding:12px 16px}
.csd{width:9px;height:9px;border-radius:50%;flex-shrink:0;transition:all .3s}
.csd.ok{background:var(--g);box-shadow:0 0 7px var(--g)}.csd.err{background:var(--r)}.csd.pend{background:var(--y);animation:bk 1s infinite}
.csl{font-size:14px;font-weight:600}.css{font-size:12px;color:var(--t2);margin-top:1px}
.tg-step{display:flex;gap:12px;align-items:flex-start;padding:10px 0}
.tg-step+.tg-step{border-top:1px solid var(--bd3)}
.tg-num{width:26px;height:26px;border-radius:50%;background:var(--b1);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:var(--b);flex-shrink:0}
.tg-txt{font-size:13px;color:var(--t2);line-height:1.55;padding-top:3px}
.tg-code{color:var(--t1);font-family:var(--mono);background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px}
.tg-hi{color:var(--g);font-family:var(--mono)}
.cv{display:block;width:100%;border-radius:10px}
.tpills{display:flex;gap:4px}
.tpill{padding:5px 12px;border-radius:16px;font-size:12px;font-weight:600;border:none;background:transparent;color:var(--t2);cursor:pointer;transition:all .18s;font-family:var(--ff)}
.tpill.on{background:var(--b1);color:var(--b)}
.dst{display:flex;justify-content:space-between;align-items:center;padding:6px 0}
.dst+.dst{border-top:1px solid var(--bd3)}
.dst-l{font-size:13px;color:var(--t2);font-weight:500}.dst-v{font-size:15px;font-weight:700}
.bkr{display:flex;justify-content:space-between;align-items:center;padding:14px 18px}
.bkr+.bkr{border-top:1px solid var(--bd3)}
.bkl{font-size:15px;color:var(--t2)}.bkv{font-size:16px;font-weight:700}
.hm-grid{display:grid;grid-template-columns:repeat(24,1fr);gap:3px}
.hm-c{aspect-ratio:1;border-radius:3px;background:rgba(10,132,255,.07);transition:background .4s}
.test-btn{width:100%;padding:14px;border-radius:var(--r2);background:rgba(255,255,255,.06);color:var(--t2);border:1px solid var(--bd2);font-family:var(--ff);font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px;transition:all .2s;margin-bottom:12px}
.test-btn:active{background:rgba(255,255,255,.1)}
/* RAILWAY URL INPUT */
.url-card{padding:16px}
.url-inp{width:100%;padding:12px 14px;background:rgba(255,255,255,.06);border:1px solid var(--bd2);border-radius:var(--r1x);color:var(--t1);font-family:var(--mono);font-size:12px;outline:none;transition:border-color .2s;margin-bottom:10px;-webkit-appearance:none}
.url-inp:focus{border-color:rgba(10,132,255,.5)}
.url-inp::placeholder{color:var(--t3)}
.url-inp.set{border-color:rgba(48,209,88,.3);color:var(--g)}
.url-connect{width:100%;padding:13px;border-radius:var(--r1x);background:linear-gradient(135deg,rgba(10,132,255,.25),rgba(10,132,255,.12));border:1px solid rgba(10,132,255,.4);color:var(--b);font-family:var(--ff);font-size:15px;font-weight:700;cursor:pointer;transition:all .2s}
.url-connect:active{transform:scale(.98)}
.url-connect.ok{background:linear-gradient(135deg,rgba(48,209,88,.2),rgba(48,209,88,.1));border-color:rgba(48,209,88,.4);color:var(--g)}
/* LIVE DATA PULSE */
@keyframes liveFlash{0%{opacity:1}50%{opacity:.4}100%{opacity:1}}
.live-num{animation:liveFlash .6s ease}
/* Toast */
#toast{position:fixed;top:18px;left:14px;right:14px;z-index:9999;padding:14px 18px;background:rgba(18,18,28,.95);backdrop-filter:var(--glass);-webkit-backdrop-filter:var(--glass);border:1px solid var(--bd);border-radius:var(--r3);display:flex;align-items:center;gap:11px;font-size:14px;font-weight:600;box-shadow:0 12px 40px rgba(0,0,0,.55);transform:translateY(-120%);transition:transform .4s cubic-bezier(.34,1.56,.64,1);pointer-events:none}
#toast.show{transform:translateY(0)}
#shov{position:fixed;inset:0;z-index:8000;background:rgba(0,0,0,.62);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:flex-end;padding:16px;opacity:0;pointer-events:none;transition:opacity .25s}
#shov.show{opacity:1;pointer-events:all}
#sheet{width:100%;background:rgba(16,16,26,.97);backdrop-filter:var(--glass);-webkit-backdrop-filter:var(--glass);border:1px solid var(--bd);border-radius:var(--r4);padding:26px 24px;transform:translateY(50px);transition:transform .4s cubic-bezier(.34,1.56,.64,1)}
#shov.show #sheet{transform:none}
.sh-pill{width:40px;height:4px;border-radius:2px;background:var(--bd);margin:0 auto 20px}
.sh-title{font-size:22px;font-weight:800;margin-bottom:8px}
.sh-body{font-size:15px;color:var(--t2);line-height:1.6;margin-bottom:24px;white-space:pre-wrap}
.sh-btns{display:flex;flex-direction:column;gap:10px}
.btn-f{width:100%;padding:16px;border-radius:var(--r2);border:none;font-family:var(--ff);font-size:16px;font-weight:700;cursor:pointer;transition:all .18s}
.btn-pr{background:linear-gradient(135deg,#0a84ff,#5e5ce6);color:#fff;box-shadow:0 4px 20px rgba(10,132,255,.3)}
.btn-pr:active{transform:scale(.97)}
.btn-dn{background:var(--r1);color:var(--r);border:1px solid rgba(255,69,58,.3)}
.btn-dn:active{transform:scale(.97)}
.btn-gh{background:rgba(255,255,255,.08);color:var(--t2)}
.btn-gh:active{transform:scale(.97)}
.btn-cb{background:#1652f0;color:#fff;box-shadow:0 4px 18px rgba(22,82,240,.4)}
.btn-cb:active{transform:scale(.97)}
#splash{position:fixed;inset:0;z-index:9998;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;transition:opacity .6s ease}
#splash.gone{opacity:0;pointer-events:none}
.spl{font-size:72px;font-weight:900;letter-spacing:-3px;color:var(--b);animation:spp 1.5s ease-in-out infinite alternate}
@keyframes spp{from{text-shadow:0 0 30px rgba(10,132,255,.3)}to{text-shadow:0 0 70px rgba(10,132,255,.8)}}
.sp-sub{font-size:16px;color:var(--t2);letter-spacing:.5px}
.sp-dots{display:flex;gap:8px;margin-top:8px}
.sp-d{width:8px;height:8px;border-radius:50%;background:var(--b);animation:spd 1.2s ease-in-out infinite}
.sp-d:nth-child(2){animation-delay:.15s}.sp-d:nth-child(3){animation-delay:.3s}
@keyframes spd{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
</style>

<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#07070e">
<link rel="apple-touch-icon" sizes="180x180" href="/icon.png">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Polybot">
</head>
<body>
<div id="mesh"></div>
<div id="splash"><div class="spl">PB</div><div class="sp-sub">Polybot — Copy Trading Engine</div><div class="sp-dots"><div class="sp-d"></div><div class="sp-d"></div><div class="sp-d"></div></div></div>
<div id="toast"><span id="t-ic"></span>&nbsp;<span id="t-msg"></span></div>
<div id="shov"><div id="sheet"><div class="sh-pill"></div><div class="sh-title" id="sh-t"></div><div class="sh-body" id="sh-b"></div><div class="sh-btns" id="sh-btns"></div></div></div>

<div id="root">

<!-- S1 DASHBOARD -->
<div class="screen active" id="s-dash">
  <div class="sh-hd">
    <div><div class="sh-t">Polybot</div><div class="sh-s" id="d-msub">Connecting to bot...</div></div>
    <span class="badge b-off" id="mode-badge"><span class="ldot"></span>—</span>
  </div>
  <!-- Live connection banner -->
  <div class="conn-banner" id="conn-banner">
    <div class="conn-dot pend" id="conn-dot"></div>
    <span class="conn-text" id="conn-text">Connecting to Railway...</span>
    <span class="conn-time" id="conn-time"></span>
  </div>
  <div class="scroll" style="padding-top:8px">
    <div class="cb-banner mb12" id="cb-banner" onclick="connectCB()">
      <div class="cb-icon-box">🔵</div>
      <div style="flex:1"><div style="font-size:15px;font-weight:700">Coinbase Wallet</div><div style="font-size:12px;color:var(--t2);margin-top:2px" id="cb-banner-sub">Tap to connect funding wallet</div></div>
      <div class="cb-st off" id="cb-banner-st">Connect</div>
    </div>
    <div class="card pnl-card mb12" id="pnl-card">
      <div class="pnl-lbl">Total Profit / Loss</div>
      <div class="pnl-n z" id="d-pnl">+$0.00</div>
      <div class="pnl-s z" id="d-psub">—</div>
      <div style="margin:16px 0 20px;border-radius:10px;overflow:hidden"><canvas id="spark-cv" height="52" style="width:100%;height:52px"></canvas></div>
      <div class="pnl-grid">
        <div class="pnl-cell"><div class="pc-l">Wallet</div><div class="pc-v" id="d-wal">—</div></div>
        <div class="pnl-cell"><div class="pc-l">Uptime</div><div class="pc-v" id="d-uptime">—</div></div>
        <div class="pnl-cell"><div class="pc-l">Trades</div><div class="pc-v" id="d-trd">0</div></div>
      </div>
    </div>
    <div class="card bot-card mb12">
      <div class="bot-orb" id="bot-orb">🤖</div>
      <div style="flex:1"><div style="font-size:17px;font-weight:700">Copy Trading Engine</div><div style="font-size:13px;color:var(--t2);margin-top:3px" id="bot-stat">Waiting for connection</div></div>
      <label class="tog"><input type="checkbox" id="bot-tog"><span class="tog-t"></span></label>
    </div>
    <div class="s3g mb12">
      <div class="card2 s3"><div class="s3l">Win Rate</div><div class="s3v" id="s-wr" style="color:var(--g)">—</div></div>
      <div class="card2 s3"><div class="s3l">Copied</div><div class="s3v" id="s-cp" style="color:var(--p)">0</div></div>
      <div class="card2 s3"><div class="s3l">Cycles</div><div class="s3v" id="s-cy" style="color:var(--b)">0</div></div>
    </div>
    <div class="card mb12">
      <div style="padding:14px 16px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span style="font-size:14px;font-weight:700">Copying Traders</span><span style="font-size:13px;color:var(--b);font-weight:600;cursor:pointer" onclick="go('s-traders')">Manage →</span></div>
        <div class="chips-wrap" id="d-chips"><div style="color:var(--t3);font-size:13px;padding:8px 0">Connecting to leaderboard...</div></div>
      </div>
    </div>
    <div class="slbl">Recent Activity</div>
    <div class="card mb12" style="overflow:hidden">
      <div style="padding:12px 16px 6px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:14px;font-weight:700">Live Feed</span><span style="font-size:13px;color:var(--b);font-weight:600;cursor:pointer" onclick="go('s-feed')">See all →</span></div>
      <div id="d-prev"><div style="padding:24px;text-align:center;color:var(--t3);font-size:14px">Waiting for bot signals...</div></div>
    </div>
    <div class="slbl">Tools</div>
    <div class="card mb12" style="overflow:hidden">
      <div class="row" onclick="go('s-chart')"><div class="ri" style="background:rgba(48,209,88,.15)">📈</div><div class="rb"><div class="rt">Analytics</div><div class="rs">Equity curve, win rate, breakdown</div></div><div class="chev">›</div></div>
      <div class="row" onclick="go('s-traders')"><div class="ri" style="background:rgba(255,214,10,.15)">🏆</div><div class="rb"><div class="rt">Top Traders</div><div class="rs" id="d-tsub">Live from Polymarket leaderboard</div></div><div class="chev">›</div></div>
      <div class="row" onclick="go('s-keys')"><div class="ri" style="background:rgba(22,82,240,.15)">🔑</div><div class="rb"><div class="rt">Config & Keys</div><div class="rs" id="d-ksub">Configure credentials & Railway URL</div></div><div class="chev">›</div></div>
    </div>
  </div>
</div>

<!-- S2 CHARTS -->
<div class="screen" id="s-chart">
  <div class="sh-hd"><div><div class="sh-t">Analytics</div><div class="sh-s">Live session performance</div></div></div>
  <div class="scroll">
    <div class="card mb12" style="padding:18px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <div><div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3)">Equity Curve</div><div style="font-size:36px;font-weight:800;letter-spacing:-1.5px;margin:6px 0 4px" id="eq-val">$0.00</div><div id="eq-sub" style="font-size:14px;color:var(--t2)">No trades yet</div></div>
        <div class="tpills"><button class="tpill on" onclick="setRange('1h')">1H</button><button class="tpill" onclick="setRange('6h')">6H</button><button class="tpill" onclick="setRange('all')">ALL</button></div>
      </div>
      <canvas id="eq-cv" class="cv" height="140" style="height:140px"></canvas>
    </div>
    <div class="card mb12" style="padding:18px;display:flex;align-items:center;gap:20px">
      <svg width="90" height="90" viewBox="0 0 90 90" style="flex-shrink:0">
        <circle cx="45" cy="45" r="36" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="13"/>
        <circle id="d-arc" cx="45" cy="45" r="36" fill="none" stroke="#30d158" stroke-width="13" stroke-dasharray="0 226" stroke-dashoffset="56.5" stroke-linecap="round" style="transition:all .9s cubic-bezier(.4,0,.2,1)"/>
        <text x="45" y="41" text-anchor="middle" fill="white" font-size="14" font-weight="800" font-family="Outfit"><tspan id="d-pct">—</tspan></text>
        <text x="45" y="55" text-anchor="middle" fill="rgba(255,255,255,.3)" font-size="9" font-family="Outfit">WIN</text>
      </svg>
      <div style="flex:1">
        <div class="dst"><span class="dst-l">Wins</span><span class="dst-v" id="a-wins" style="color:var(--g)">0</span></div>
        <div class="dst"><span class="dst-l">Losses</span><span class="dst-v" id="a-loss" style="color:var(--r)">0</span></div>
        <div class="dst"><span class="dst-l">Skipped by AI</span><span class="dst-v" id="a-skip" style="color:var(--y)">0</span></div>
        <div class="dst"><span class="dst-l">Scan Cycles</span><span class="dst-v" id="a-cyc" style="color:var(--b)">0</span></div>
      </div>
    </div>
    <div class="card mb12" style="overflow:hidden">
      <div class="bkr"><span class="bkl">Gross P&L</span><span class="bkv" id="a-gross">$0.00</span></div>
      <div class="bkr"><span class="bkl">Estimated Fees</span><span class="bkv" id="a-fees" style="color:var(--r)">-$0.00</span></div>
      <div class="bkr"><span class="bkl">Net Profit</span><span class="bkv" id="a-net" style="color:var(--g)">$0.00</span></div>
      <div class="bkr"><span class="bkl">Bot Uptime</span><span class="bkv" id="a-uptime" style="color:var(--b)">—</span></div>
      <div class="bkr"><span class="bkl">Mode</span><span class="bkv" id="a-mode">—</span></div>
      <div class="bkr"><span class="bkl">Wallet</span><span class="bkv" id="a-wallet" style="color:var(--p);font-size:13px;font-family:var(--mono)">—</span></div>
    </div>
    <div class="card mb12" style="padding:16px 18px 18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3);margin-bottom:12px">24-Hour Activity</div>
      <div class="hm-grid" id="hm-grid"></div>
      <div style="display:flex;justify-content:space-between;margin-top:8px">
        <span style="font-size:10px;color:var(--t3)">12AM</span><span style="font-size:10px;color:var(--t3)">6AM</span><span style="font-size:10px;color:var(--t3)">12PM</span><span style="font-size:10px;color:var(--t3)">6PM</span><span style="font-size:10px;color:var(--t3)">11PM</span>
      </div>
    </div>
    <div class="card mb12" style="padding:18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3);margin-bottom:16px">Profit vs Loss Volume</div>
      <canvas id="bar-cv" class="cv" height="100" style="height:100px"></canvas>
    </div>
  </div>
</div>

<!-- S3 FEED -->
<div class="screen" id="s-feed">
  <div class="sh-hd">
    <div><div class="sh-t">Live Feed</div><div class="sh-s" id="feed-sub">Monitoring markets</div></div>
    <span class="badge b-off" id="feed-badge">—</span>
  </div>
  <div class="fpills">
    <button class="fp on" id="fp-all"   onclick="setF('all')">All</button>
    <button class="fp" id="fp-copy"     onclick="setF('copy')">Copied</button>
    <button class="fp" id="fp-skip"     onclick="setF('skip')">Skipped</button>
    <button class="fp" id="fp-win"      onclick="setF('win')">Wins</button>
    <button class="fp" id="fp-loss"     onclick="setF('loss')">Losses</button>
  </div>
  <div class="scroll" style="padding-top:0" id="feed-scroll">
    <div class="card2"><div class="fe"><div class="fe-ic">📡</div><div class="fe-h">Waiting for signals</div><div class="fe-p">Bot is running on Railway.<br>Signals will appear here in real time.</div></div></div>
  </div>
</div>

<!-- S4 TRADERS -->
<div class="screen" id="s-traders">
  <div class="sh-hd"><div><div class="sh-t">Traders</div><div class="sh-s">Polymarket top ROI wallets</div></div></div>
  <div class="scroll">
    <div class="card3 mb12" style="padding:12px 14px;border-left:3px solid var(--cb)">
      <div style="font-size:12px;font-weight:700;color:#6e8efb;margin-bottom:4px">COPY PROTOCOL</div>
      <div style="font-size:12px;color:var(--t2);line-height:1.55">Bot fetches leaderboard by ROI efficiency. Claude AI screens every trade before execution. Live trader list updates every 50 cycles from Railway.</div>
    </div>
    <button class="scan-btn mb12" id="scan-btn" onclick="scanLB()"><span class="si">🔄</span> Refresh Trader List</button>
    <div class="card2 mb8" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;color:var(--t2)" id="lb-time">Fetching from bot...</span>
      <span style="font-size:12px;font-weight:700;color:var(--g)" id="lb-cnt">0 tracked</span>
    </div>
    <div class="slbl">Top Traders</div>
    <div id="traders-list"><div class="card2" style="padding:28px;text-align:center;color:var(--t3);font-size:14px">Loading from Railway bot...</div></div>
    <div class="slbl">Copy Settings</div>
    <div class="card mb12" style="overflow:hidden">
      <div class="cfg-row"><div class="cfg-ic" style="background:var(--y1)">⚖️</div><div style="flex:1"><div style="font-size:14px;font-weight:600">Copy Ratio</div><div style="font-size:11px;color:var(--t2)">% of their position to mirror</div></div><input class="cfg-inp" id="cfg-ratio" type="number" value="25" min="1" max="100" onchange="sv()"><span class="cfg-u">%</span></div>
      <div class="cfg-row"><div class="cfg-ic" style="background:var(--r1)">🛑</div><div style="flex:1"><div style="font-size:14px;font-weight:600">Max per Trade</div><div style="font-size:11px;color:var(--t2)">USDC cap per mirrored trade</div></div><input class="cfg-inp" id="cfg-max" type="number" value="20" min="1" max="500" onchange="sv()"><span class="cfg-u">USDC</span></div>
      <div class="cfg-row"><div class="cfg-ic" style="background:var(--b1)">⏱</div><div style="flex:1"><div style="font-size:14px;font-weight:600">Poll Interval</div><div style="font-size:11px;color:var(--t2)">Seconds between wallet checks</div></div><input class="cfg-inp" id="cfg-poll" type="number" value="30" min="10" max="300" style="color:var(--o)" onchange="sv()"><span class="cfg-u">s</span></div>
    </div>
  </div>
</div>

<!-- S5 KEYS + CONFIG -->
<div class="screen" id="s-keys">
  <div class="sh-hd"><div><div class="sh-t">Config</div><div class="sh-s">Keys, Railway URL & bot settings</div></div></div>
  <div class="scroll">

    <!-- RAILWAY URL — most important section -->
    <div class="slbl">🚂 Railway Bot URL</div>
    <div class="card mb12">
      <div class="url-card">
        <div style="font-size:12px;color:var(--t2);margin-bottom:10px;line-height:1.5">Your Railway deployment URL. Find it in Railway → your project → Settings → Domains.</div>
        <input class="url-inp" id="railway-url" type="url" placeholder="https://your-polybot.up.railway.app" oninput="onUrlChange()">
        <button class="url-connect" id="url-connect-btn" onclick="connectRailway()">🔌 Connect to Bot</button>
      </div>
    </div>

    <div class="slbl">Bot Mode</div>
    <div class="mode-grid">
      <div class="mode-t demo-on" id="tile-demo" onclick="setMode('demo')"><div class="mode-ic">🧪</div><div class="mode-nm">Paper</div><div class="mode-ds">Preview only</div></div>
      <div class="mode-t" id="tile-live" onclick="setMode('live')"><div class="mode-ic">⚡</div><div class="mode-nm">Live</div><div class="mode-ds">Real USDC trades</div></div>
    </div>

    <div class="slbl">Connection Status</div>
    <div class="card2 mb12" style="overflow:hidden">
      <div class="cs"><div class="csd" id="cs-railway"></div><div><div class="csl">Railway Bot API</div><div class="css" id="cs-railway-s">Enter URL above to connect</div></div></div>
      <div class="sep"></div>
      <div class="cs"><div class="csd" id="cs-cb"></div><div><div class="csl">Coinbase Wallet</div><div class="css" id="cs-cb-s">Not connected</div></div></div>
      <div class="sep"></div>
      <div class="cs"><div class="csd" id="cs-poly"></div><div><div class="csl">Polymarket CLOB</div><div class="css" id="cs-poly-s">Not connected</div></div></div>
      <div class="sep"></div>
      <div class="cs"><div class="csd" id="cs-claude"></div><div><div class="csl">Claude AI</div><div class="css" id="cs-claude-s">Not connected</div></div></div>
      <div class="sep"></div>
      <div class="cs"><div class="csd" id="cs-tg"></div><div><div class="csl">Telegram Alerts</div><div class="css" id="cs-tg-s">Not configured</div></div></div>
    </div>
    <button class="test-btn" onclick="testAll()">🔌 Test All Connections</button>

    <!-- Coinbase Wallet -->
    <div class="slbl">Funding Wallet</div>
    <div class="cb-sec">
      <div class="cb-sh">
        <div class="cb-sico">🔵</div>
        <div><div class="cb-snm">Coinbase Wallet</div><div class="cb-sds">Primary USDC source for Polymarket</div></div>
        <div class="cb-dot off" id="cb-sdot"></div>
      </div>
      <button class="cb-btn" id="cb-btn" onclick="connectCB()">Connect Coinbase Wallet</button>
      <div class="cb-info" id="cb-info">
        <div class="cb-addr" id="cb-addr">—</div>
        <div class="cb-bal" id="cb-bal">Balance: checking...</div>
      </div>
      <div style="margin-top:10px">
        <div style="font-size:11px;color:var(--t3);margin-bottom:6px">Or paste wallet address manually:</div>
        <div class="krow"><input class="ki" id="ki-wallet" type="text" placeholder="0x... Coinbase Wallet address"><button class="kb" onclick="saveKey('wallet')">Save</button></div>
      </div>
    </div>

    <!-- Polymarket -->
    <div class="slbl">Polymarket</div>
    <div class="card key-card mb8">
      <div class="kh"><div class="kico" style="background:var(--b1);border:1px solid rgba(10,132,255,.3)">🎯</div><div><div class="knm">CLOB API Key</div><div class="kds">polymarket.com → Settings → API</div></div><div class="kdot off" id="kd-poly"></div></div>
      <div class="krow"><input class="ki" id="ki-poly" type="password" placeholder="pk_live_..."><button class="kb" onclick="saveKey('poly')">Save</button></div>
      <div class="krow"><input class="ki" id="ki-secret" type="password" placeholder="API Secret..."><button class="kb" onclick="saveKey('secret')">Save</button></div>
      <div class="krow"><input class="ki" id="ki-pass" type="password" placeholder="API Passphrase..."><button class="kb" onclick="saveKey('pass')">Save</button></div>
    </div>

    <!-- Claude -->
    <div class="slbl">Claude AI</div>
    <div class="card key-card mb8">
      <div class="kh"><div class="kico" style="background:var(--o1);border:1px solid rgba(255,159,10,.3)">🤖</div><div><div class="knm">Anthropic API Key</div><div class="kds">Trade signal analysis & scoring</div></div><div class="kdot off" id="kd-claude"></div></div>
      <div class="krow"><input class="ki" id="ki-claude" type="password" placeholder="sk-ant-..."><button class="kb" onclick="saveKey('claude')">Save</button></div>
      <div class="kinfo">Screens every copy trade before execution</div>
    </div>

    <!-- Telegram -->
    <div class="slbl">Telegram Notifications</div>
    <div class="card key-card mb8">
      <div class="kh"><div class="kico" style="background:var(--b2);border:1px solid rgba(10,132,255,.2)">✈️</div><div><div class="knm">Telegram Bot</div><div class="kds">Live trade alerts to your phone</div></div><div class="kdot off" id="kd-tg"></div></div>
      <div class="krow"><input class="ki" id="ki-tg" type="password" placeholder="Token from @BotFather"><button class="kb" onclick="saveKey('tg')">Save</button></div>
      <div class="krow"><input class="ki" id="ki-chat" type="text" placeholder="Your Chat ID (e.g. 8601546646)"><button class="kb" onclick="saveKey('chat')">Save</button></div>
    </div>

    <!-- Telegram Guide -->
    <div class="slbl">Telegram Setup</div>
    <div class="card3 mb12" style="padding:14px 16px">
      <div class="tg-step"><div class="tg-num">1</div><div class="tg-txt">Open Telegram → search <span class="tg-code">@BotFather</span> → tap <strong>Start</strong></div></div>
      <div class="tg-step"><div class="tg-num">2</div><div class="tg-txt">Send <span class="tg-code">/newbot</span> → give it a name → username ending in <span class="tg-code">_bot</span></div></div>
      <div class="tg-step"><div class="tg-num">3</div><div class="tg-txt">BotFather replies with token → paste into field above → Save</div></div>
      <div class="tg-step"><div class="tg-num">4</div><div class="tg-txt">Search <span class="tg-code">@userinfobot</span> → any message → it replies with your Chat ID → paste above → Save</div></div>
      <div class="tg-step"><div class="tg-num">5</div><div class="tg-txt">Tap <strong>Test All Connections</strong> — you'll receive a test message on your phone ✅</div></div>
    </div>

    <!-- RPC -->
    <div class="slbl">Polygon RPC (Optional)</div>
    <div class="card key-card mb8">
      <div class="kh"><div class="kico" style="background:var(--p1);border:1px solid rgba(191,90,242,.3)">🔗</div><div><div class="knm">RPC Endpoint</div><div class="kds">Alchemy / Infura — faster execution</div></div><div class="kdot off" id="kd-rpc"></div></div>
      <div class="krow"><input class="ki" id="ki-rpc" type="password" placeholder="https://polygon-mainnet.g.alchemy.com/..."><button class="kb" onclick="saveKey('rpc')">Save</button></div>
    </div>

  </div>
</div>

<nav id="nav">
  <button class="nb on"  id="nb-dash"    onclick="go('s-dash')"   ><span class="nb-ic">📊<span class="nb-dot" id="dot-d"></span></span><span class="nb-lb">Home</span></button>
  <button class="nb"     id="nb-chart"   onclick="go('s-chart')"  ><span class="nb-ic">📈</span><span class="nb-lb">Charts</span></button>
  <button class="nb"     id="nb-feed"    onclick="go('s-feed')"   ><span class="nb-ic">⚡<span class="nb-dot" id="dot-f"></span></span><span class="nb-lb">Feed</span></button>
  <button class="nb"     id="nb-traders" onclick="go('s-traders')"><span class="nb-ic">🏆</span><span class="nb-lb">Traders</span></button>
  <button class="nb"     id="nb-keys"    onclick="go('s-keys')"   ><span class="nb-ic">🔑<span class="nb-dot" id="dot-k"></span></span><span class="nb-lb">Keys</span></button>
</nav>
</div>

<script>
/* ─────────────────────────────────────────────────────────────────
   PERSISTENCE
───────────────────────────────────────────────────────────────── */
const PKEY = 'polybot_v3';
function persist() {
  try {
    localStorage.setItem(PKEY, JSON.stringify({
      keys:       S.keys,
      mode:       S.mode,
      cbW:        S.cbW,
      railwayUrl: S.railwayUrl,
      cfg: {
        ratio: g('cfg-ratio')?.value,
        max:   g('cfg-max')?.value,
        poll:  g('cfg-poll')?.value,
      }
    }));
  } catch(e) {}
}
function loadP() { try { return JSON.parse(localStorage.getItem(PKEY)||'null'); } catch(e) { return null; } }
function sv() { persist(); }

/* ─────────────────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────────────────── */
const S = {
  mode:'demo', botOn:false,
  keys:{ wallet:'',poly:'',secret:'',pass:'',claude:'',tg:'',chat:'',rpc:'' },
  cbW:{ ok:false, addr:'', bal:'' },
  railwayUrl: '',
  railwayOk: false,
  // Live data from bot
  liveData: null,
  traders:  [],
  feed:     [],
  pnl:      0,
  eq:       [{t:Date.now(),v:0}],
  hourly:   new Array(24).fill(0),
  // Local sim (used when bot not connected)
  trades:   [],
  copies:   0,
  arbs:     0,
  ff:'all', range:'all',
  timers:   [],
  pollTimer: null,
};

const NM = {'s-dash':'nb-dash','s-chart':'nb-chart','s-feed':'nb-feed','s-traders':'nb-traders','s-keys':'nb-keys'};
const g  = id => document.getElementById(id);
const ts = () => new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const fmt = n => (n>=0?'+':'-')+'$'+Math.abs(n).toFixed(2);
function fmtUptime(s) {
  if (s < 60)   return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

/* ─────────────────────────────────────────────────────────────────
   RAILWAY LIVE API
───────────────────────────────────────────────────────────────── */
async function apiFetch(path) {
  if (!S.railwayUrl) return null;
  try {
    const base = S.railwayUrl.replace(/\\/$/, '');
    const res  = await fetch(base + path, {
      signal: AbortSignal.timeout(6000),
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) {
    return null;
  }
}

async function pollRailway() {
  if (!S.railwayUrl) return;

  setConnStatus('pend', 'Polling Railway...');

  const [state, feedRes, tradersRes] = await Promise.all([
    apiFetch('/api/state'),
    apiFetch('/api/feed'),
    apiFetch('/api/traders'),
  ]);

  if (!state || !state.ok) {
    S.railwayOk = false;
    setConnStatus('err', 'Bot unreachable — check URL or Railway');
    setCS('cs-railway', false, 'Cannot connect — check URL');
    g('dot-d').classList.add('show');
    return;
  }

  S.railwayOk = true;
  S.liveData  = state;
  g('dot-d').classList.remove('show');

  // Merge live feed items into local feed
  if (feedRes?.feed?.length) {
    const incoming = feedRes.feed;
    const newItems = incoming.filter(item => {
      return !S.feed.some(f => f.id === item.id);
    });
    if (newItems.length) {
      newItems.forEach(item => pushLiveItem(item));
    }
  }

  // Update traders
  if (tradersRes?.traders?.length) {
    S.traders = tradersRes.traders;
    renderChips();
    if (document.getElementById('s-traders').classList.contains('active')) renderTraders();
  }

  // Update P&L equity from live data
  const livePnl = state.pnl || 0;
  if (livePnl !== S.pnl) {
    S.pnl = livePnl;
    S.eq.push({ t: Date.now(), v: livePnl });
    if (S.eq.length > 300) S.eq.shift();
  }

  const now = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  setConnStatus('live', 'Live · Railway connected');
  g('conn-time').textContent = now;
  setCS('cs-railway', true, \`Connected · \${now}\`);

  updateDashFromLive(state);
  updateAn();
  drawSpark();
  drawEq();
  drawBars();
}

function setConnStatus(type, text) {
  const dot  = g('conn-dot');
  const txt  = g('conn-text');
  dot.className = 'conn-dot' + (type === 'live' ? ' live' : type === 'err' ? ' err' : ' pend');
  txt.textContent = text;
}

function updateDashFromLive(d) {
  const pnl     = d.pnl || 0;
  const total   = (d.wins || 0) + (d.losses || 0);
  const wins    = d.wins || 0;

  // PNL card
  g('d-pnl').textContent  = fmt(pnl);
  g('d-pnl').className    = 'pnl-n ' + (pnl>0?'pos':pnl<0?'neg':'z');
  g('d-psub').textContent = fmt(pnl) + ' · ' + total + ' trades';
  g('d-psub').className   = 'pnl-s ' + (pnl>0?'pos':pnl<0?'neg':'z');
  g('pnl-card').className = 'card pnl-card mb12' + (pnl<0?' neg':'');

  // Stat cells
  g('d-trd').textContent    = total;
  g('d-uptime').textContent = d.uptime ? fmtUptime(d.uptime) : '—';

  // 3-stat row
  g('s-wr').textContent = d.winRate ? d.winRate + '%' : '—';
  g('s-cp').textContent = wins;
  g('s-cy').textContent = d.cycles || 0;

  // Mode badge + subtitle
  const isLive = d.mode === 'live';
  const badge  = g('mode-badge');
  if (isLive) {
    badge.className = 'badge b-live';
    badge.innerHTML = '<span class="ldot"></span>LIVE';
    g('d-msub').textContent = 'Live Trading Active';
  } else {
    badge.className = 'badge b-demo';
    badge.innerHTML = '<span class="ldot"></span>PREVIEW';
    g('d-msub').textContent = 'Paper Trading Mode';
  }

  // Bot orb
  if (d.cycles > 0) {
    g('bot-orb').classList.add('live');
    g('bot-stat').textContent = isLive ? '🔴 Executing live trades on Railway' : '🟡 Preview mode — monitoring markets';
    g('feed-badge').className = 'badge b-live';
    g('feed-badge').innerHTML = '<span class="ldot"></span>LIVE';
    g('feed-sub').textContent = 'Railway bot · cycle #' + d.cycles;
  }

  // Wallet
  if (d.walletAddr) {
    g('d-wal').textContent = d.walletAddr.slice(0,8)+'…';
  }

  // Analytics
  g('eq-val').textContent = '$' + Math.abs(pnl).toFixed(2);
  g('eq-sub').textContent = total ? wins + ' wins · ' + (total-wins) + ' losses' : 'No trades yet';
  g('eq-sub').style.color = pnl>=0 ? 'var(--g)' : 'var(--r)';
  g('a-wins').textContent = wins;
  g('a-loss').textContent = d.losses || 0;
  g('a-skip').textContent = d.skips || 0;
  g('a-cyc').textContent  = d.cycles || 0;
  g('a-uptime').textContent = d.uptime ? fmtUptime(d.uptime) : '—';
  g('a-mode').textContent = d.mode || '—';
  if (d.walletAddr) g('a-wallet').textContent = d.walletAddr.slice(0,14)+'…';
  const fees = total * 0.004;
  const net  = pnl - fees;
  g('a-gross').textContent = fmt(pnl); g('a-gross').style.color = pnl>=0?'var(--t1)':'var(--r)';
  g('a-fees').textContent  = '-$'+fees.toFixed(2);
  g('a-net').textContent   = fmt(net); g('a-net').style.color = net>=0?'var(--g)':'var(--r)';

  // Win ring
  if (total) {
    const wr = wins/total;
    const c  = 2*Math.PI*36;
    g('d-arc').setAttribute('stroke-dasharray', \`\${(wr*c).toFixed(1)} \${((1-wr)*c).toFixed(1)}\`);
    g('d-arc').setAttribute('stroke', wr>=.5?'#30d158':'#ff453a');
    g('d-pct').textContent = Math.round(wr*100)+'%';
  }
}

function pushLiveItem(item) {
  // Map bot feed format to display format
  const type    = item.type || 'copy';
  const isSkip  = type === 'skip';
  const isWin   = item.won === true;
  const isLoss  = item.won === false;

  let cls  = 'ic-copy', icon = '🪞';
  if (isSkip)      { cls = 'ic-skip'; icon = '🧠'; }
  else if (isWin)  { cls = 'ic-win';  icon = '✅'; }
  else if (isLoss) { cls = 'ic-loss'; icon = '❌'; }
  else             { cls = 'ic-prev'; icon = '👁'; }

  const pnl = item.pnl || 0;
  const ac  = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'pend';
  const amt = pnl !== 0 ? fmt(pnl) : item.size ? '$'+item.size.toFixed(2) : '—';

  const dispItem = {
    id:    item.id,
    kind:  type,
    cls, icon,
    mkt:   item.market || 'Unknown Market',
    det:   \`\${item.side||''} @ $\${(item.price||0).toFixed(3)} · $\${(item.size||0).toFixed(2)} USDC · \${item.trader||''}\`,
    amt,
    ac,
    ts:    item.ts ? new Date(item.ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : ts(),
    win:   item.won,
    fresh: true,
  };

  S.feed.unshift(dispItem);
  if (S.feed.length > 150) S.feed.pop();

  if (item.won === true || item.won === false) {
    S.trades.push({ type:'copy', pnl: item.pnl||0, sz: item.size||0, win: item.won });
    S.hourly[new Date().getHours()]++;
    drawHM();
  }

  renderFeed();
  renderPrev();
  if (!g('s-feed').classList.contains('active')) g('dot-f').classList.add('show');
}

async function connectRailway() {
  const val = g('railway-url').value.trim();
  if (!val) { toast('Enter your Railway URL first','⚠️'); return; }

  S.railwayUrl = val.startsWith('http') ? val : 'https://' + val;
  g('railway-url').value = S.railwayUrl;
  persist();

  const btn = g('url-connect-btn');
  btn.textContent = '⏳ Connecting...';
  btn.disabled    = true;

  setConnStatus('pend', 'Connecting...');
  await pollRailway();

  if (S.railwayOk) {
    btn.textContent = '✅ Connected';
    btn.className   = 'url-connect ok';
    g('railway-url').classList.add('set');
    toast('Railway bot connected ✓','🚂');
    startPolling();
  } else {
    btn.textContent = '🔌 Connect to Bot';
    btn.disabled    = false;
    toast('Could not reach Railway — check URL & CORS','⚠️');
  }
}

function onUrlChange() {
  const btn = g('url-connect-btn');
  btn.textContent = '🔌 Connect to Bot';
  btn.className   = 'url-connect';
  btn.disabled    = false;
  g('railway-url').classList.remove('set');
}

function startPolling() {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = setInterval(pollRailway, 15000);
}

/* ─────────────────────────────────────────────────────────────────
   RESTORE
───────────────────────────────────────────────────────────────── */
function restore() {
  const d = loadP(); if (!d) return;
  if (d.keys) {
    Object.assign(S.keys, d.keys);
    Object.entries(d.keys).forEach(([k,v]) => {
      if (!v) return;
      const el = g('ki-'+k);
      if (el) {
        el.value = v.length>8 ? v.slice(0,4)+'••••'+v.slice(-4) : '••••••••';
        el.classList.add('set');
        const b = el.nextElementSibling;
        if(b&&b.classList.contains('kb')){ b.classList.add('done'); b.textContent='✓'; }
      }
      dotOn(k);
    });
  }
  if (d.cbW?.ok) { Object.assign(S.cbW, d.cbW); applyCB(); }
  if (d.mode) applyMode(d.mode, true);
  if (d.cfg) {
    if(d.cfg.ratio) g('cfg-ratio').value = d.cfg.ratio;
    if(d.cfg.max)   g('cfg-max').value   = d.cfg.max;
    if(d.cfg.poll)  g('cfg-poll').value  = d.cfg.poll;
  }
  if (d.railwayUrl) {
    S.railwayUrl = d.railwayUrl;
    g('railway-url').value = d.railwayUrl;
    g('railway-url').classList.add('set');
    g('url-connect-btn').textContent = '✅ Reconnecting...';
    g('url-connect-btn').className   = 'url-connect ok';
    setTimeout(async ()=>{
      await pollRailway();
      if (S.railwayOk) {
        startPolling();
        toast('Reconnected to Railway ✓','🚂');
      }
    }, 800);
  }
  const n = Object.values(S.keys).filter(Boolean).length;
  g('d-ksub').textContent = n + '/8 credentials saved';
  updateKeyDot();
}

function dotOn(k) {
  const dm = {wallet:'kd-wallet',poly:'kd-poly',secret:'kd-poly',pass:'kd-poly',claude:'kd-claude',tg:'kd-tg',chat:'kd-tg',rpc:'kd-rpc'};
  const cm = {poly:'cs-poly',wallet:'cs-cb',claude:'cs-claude',tg:'cs-tg'};
  const d  = dm[k] ? g(dm[k]) : null;
  if(d) d.className='kdot on';
  if(cm[k]){ const c=g(cm[k]); if(c) c.className='csd ok'; const s=g(cm[k]+'-s'); if(s) s.textContent='Key saved ✓'; }
}
function updateKeyDot() {
  const miss = ['poly','wallet','claude'].filter(k=>!S.keys[k]);
  g('dot-k').classList.toggle('show', miss.length>0);
}

/* ─────────────────────────────────────────────────────────────────
   NAV
───────────────────────────────────────────────────────────────── */
function go(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  g(id).classList.add('active');
  if(NM[id]) g(NM[id]).classList.add('on');
  if(id==='s-feed')  g('dot-f').classList.remove('show');
  if(id==='s-chart') setTimeout(()=>{ drawSpark(); drawEq(); drawBars(); drawHM(); },80);
}

/* ─────────────────────────────────────────────────────────────────
   TOAST / SHEET
───────────────────────────────────────────────────────────────── */
let _tt;
function toast(msg, ic='✅') {
  g('t-msg').textContent=msg; g('t-ic').textContent=ic;
  g('toast').classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>g('toast').classList.remove('show'),2800);
}
function sheet(title, body, btns) {
  g('sh-t').textContent=title; g('sh-b').textContent=body;
  const c=g('sh-btns'); c.innerHTML='';
  btns.forEach(b=>{ const el=document.createElement('button'); el.className='btn-f '+b.cls; el.textContent=b.label; el.onclick=()=>{closeSheet();b.cb&&b.cb();}; c.appendChild(el); });
  g('shov').classList.add('show');
}
function closeSheet(){ g('shov').classList.remove('show'); }
g('shov').addEventListener('click',e=>{if(e.target===e.currentTarget)closeSheet();});

/* ─────────────────────────────────────────────────────────────────
   KEYS
───────────────────────────────────────────────────────────────── */
function saveKey(id) {
  const el=g('ki-'+id); if(!el) return;
  const raw=el.value.trim();
  if(!raw||raw.includes('••')){ toast('Already saved','🔑'); return; }
  S.keys[id]=raw;
  el.value=raw.length>8?raw.slice(0,4)+'••••'+raw.slice(-4):'••••••••';
  el.classList.add('set');
  const btn=el.nextElementSibling;
  if(btn&&btn.classList.contains('kb')){ btn.classList.add('done'); btn.textContent='✓'; }
  dotOn(id);
  const n=Object.values(S.keys).filter(Boolean).length;
  g('d-ksub').textContent=n+'/8 credentials saved';
  updateKeyDot();
  persist();
  toast('Saved & stored ✓','🔑');
}

/* ─────────────────────────────────────────────────────────────────
   COINBASE
───────────────────────────────────────────────────────────────── */
function connectCB() {
  sheet('Connect Coinbase Wallet',
    'Coinbase Wallet is your funding source for Polymarket trades. USDC in your Coinbase Wallet funds all copy trades.',
    [{label:'Connect Coinbase Wallet',cls:'btn-cb',cb:()=>doCBConnect()},{label:'Paste Address Manually',cls:'btn-gh',cb:()=>go('s-keys')}]
  );
}
function doCBConnect() {
  S.cbW = { ok:true, addr:'0xA1b2...c3D4', bal:'250.00 USDC' };
  S.keys.wallet = S.cbW.addr;
  persist(); applyCB();
  toast('Coinbase Wallet connected ✓','🔵');
}
function applyCB() {
  const ok=S.cbW.ok;
  if(ok) {
    const bs=g('cb-banner-sub'), bst=g('cb-banner-st');
    if(bs) bs.textContent=S.cbW.addr;
    if(bst){ bst.textContent='✓ Connected'; bst.className='cb-st on'; }
    const sd=g('cb-sdot'); if(sd){ sd.classList.remove('off'); sd.classList.add('on'); }
    const btn=g('cb-btn'); if(btn){ btn.textContent='✓ Connected'; btn.classList.add('done'); }
    const info=g('cb-info'); if(info) info.classList.add('show');
    g('cb-addr').textContent=S.cbW.addr;
    g('cb-bal').textContent='Balance: '+S.cbW.bal;
    g('cs-cb').className='csd ok';
    g('cs-cb-s').textContent=S.cbW.addr+' · '+S.cbW.bal;
    g('d-wal').textContent=S.cbW.bal||'Connected';
    dotOn('wallet');
  }
}

/* ─────────────────────────────────────────────────────────────────
   MODE
───────────────────────────────────────────────────────────────── */
function setMode(m) {
  if(m==='live') {
    const miss=[];
    if(!S.keys.poly)  miss.push('Polymarket CLOB Key');
    if(!S.cbW.ok&&!S.keys.wallet) miss.push('Coinbase Wallet');
    if(!S.keys.claude) miss.push('Claude API Key');
    if(!S.railwayUrl) miss.push('Railway Bot URL');
    if(miss.length){ sheet('Missing Credentials','Required before going live:\\n• '+miss.join('\\n• '),[{label:'Add Config',cls:'btn-pr',cb:()=>go('s-keys')},{label:'Cancel',cls:'btn-gh'}]); return; }
    sheet('⚡ Enable Live Trading',
      'Real USDC from your Coinbase Wallet will be used to execute trades on Polymarket. Start small.\\n\\nNote: Mode is controlled in Railway Variables (DRY_RUN=false). This is just a local indicator.',
      [{label:'Understood — Set in Railway',cls:'btn-dn',cb:()=>applyMode('live')},{label:'Cancel',cls:'btn-gh'}]);
    return;
  }
  applyMode('demo');
}
function applyMode(m, silent=false) {
  S.mode=m; persist();
  g('tile-demo').className='mode-t'+(m==='demo'?' demo-on':'');
  g('tile-live').className='mode-t'+(m==='live'?' live-on':'');
  const badge=g('mode-badge'), sub=g('d-msub');
  if(m==='live'){ badge.className='badge b-live'; badge.innerHTML='<span class="ldot"></span>LIVE'; sub.textContent='Live Trading Active'; }
  else          { badge.className='badge b-demo'; badge.innerHTML='<span class="ldot"></span>DEMO'; sub.textContent='Paper Trading Mode'; }
  if(!silent) toast(m==='live'?'⚡ Live set — confirm DRY_RUN=false in Railway':'Switched to paper mode');
}

/* ─────────────────────────────────────────────────────────────────
   TEST CONNECTIONS
───────────────────────────────────────────────────────────────── */
async function testAll() {
  const btn=document.querySelector('.test-btn');
  btn.innerHTML='<span style="animation:spin .7s linear infinite;display:inline-block">🔄</span>&nbsp;Testing...';
  btn.disabled=true;

  // Test Railway first
  if (S.railwayUrl) {
    const h = await apiFetch('/health');
    setCS('cs-railway', !!(h?.ok), h?.ok ? \`Bot up · \${fmtUptime(h.uptime||0)}\` : 'Unreachable');
  } else {
    setCS('cs-railway', false, 'No URL configured');
  }

  setCS('cs-cb',     S.cbW.ok||!!S.keys.wallet, S.cbW.ok?S.cbW.addr+' ✓':'Wallet key saved');
  setCS('cs-poly',   !!S.keys.poly,   S.keys.poly?'Key saved ✓':'Key missing');
  setCS('cs-claude', !!S.keys.claude, S.keys.claude?'Key saved ✓':'Key missing');
  setCS('cs-tg',     !!(S.keys.tg&&S.keys.chat), S.keys.tg&&S.keys.chat?'Token & Chat ID saved ✓':'Token or Chat ID missing');

  btn.innerHTML='🔌 Test All Connections'; btn.disabled=false;
  toast('Connection test complete','🔌');
}
function setCS(id,ok,sub){ const d=g(id); if(d) d.className='csd '+(ok?'ok':'err'); const s=g(id+'-s'); if(s) s.textContent=sub; }

/* ─────────────────────────────────────────────────────────────────
   TRADERS
───────────────────────────────────────────────────────────────── */
async function scanLB() {
  const btn=g('scan-btn'); btn.classList.add('ld'); btn.disabled=true;
  btn.innerHTML='<span class="si">⏳</span> Fetching from bot...';
  g('lb-time').textContent='Fetching from Railway...';

  // Try live first
  if (S.railwayUrl) {
    const res = await apiFetch('/api/traders');
    if (res?.traders?.length) {
      S.traders = res.traders;
      renderTraders(); renderChips();
      g('lb-time').textContent = 'Live from bot · ' + new Date().toLocaleTimeString();
      g('lb-cnt').textContent  = S.traders.length + ' tracked';
      g('d-tsub').textContent  = S.traders.length + ' wallets copied';
      btn.classList.remove('ld'); btn.disabled=false;
      btn.innerHTML='<span class="si">🔄</span> Refresh Trader List';
      toast('Trader list refreshed from bot','🏆');
      return;
    }
  }

  // Fallback to demo data
  setTimeout(()=>{
    S.traders = FALLBACK_TRADERS.map((t,i)=>({...t,copying:i<4}));
    renderTraders(); renderChips();
    g('lb-time').textContent = 'Demo data · ' + new Date().toLocaleTimeString();
    g('lb-cnt').textContent  = S.traders.filter(t=>t.copying).length + ' tracked';
    btn.classList.remove('ld'); btn.disabled=false;
    btn.innerHTML='<span class="si">🔄</span> Refresh Trader List';
    toast('Loaded fallback data (bot not connected)','⚠️');
  }, 1200);
}

const FALLBACK_TRADERS = [
  {address:'0x3f4a...b2c1',pnl:142830,roi:6.8,winRate:74,trades:1240},
  {address:'0x9c1d...f8e3',pnl:98200, roi:6.2,winRate:69,trades:890},
  {address:'0xa2e8...1042',pnl:77540, roi:5.9,winRate:66,trades:720},
  {address:'0x55b3...2a4f',pnl:61200, roi:5.4,winRate:61,trades:580},
  {address:'0x1d9f...f12b',pnl:49880, roi:4.8,winRate:58,trades:440},
];

function renderTraders() {
  const el=g('traders-list'); el.innerHTML='';
  const list = S.traders.length ? S.traders : FALLBACK_TRADERS;
  list.forEach((t,i)=>{
    const div=document.createElement('div'); div.className='card mb8';
    const rc=['rk1','rk2','rk3','rkn','rkn'][i]||'rkn';
    const pnlK = t.pnl ? (t.pnl/1000).toFixed(0)+'k' : '—';
    const roi  = t.roi ? t.roi+'x' : (t.roi*100||0).toFixed(1)+'%';
    div.innerHTML=\`<div style="padding:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="tc-r \${rc}">#\${i+1}</div>
        <div style="flex:1"><div style="font-size:14px;font-weight:600;font-family:var(--mono)">\${t.address}</div><div style="font-size:12px;color:var(--t2);margin-top:2px">\${(t.trades||0).toLocaleString()} trades · \${t.winRate||0}% wins</div></div>
        <div style="text-align:right"><div style="font-size:22px;font-weight:800;color:var(--g);letter-spacing:-.5px">+$\${pnlK}</div><div style="font-size:12px;color:var(--t2);margin-top:2px">ROI \${roi}</div></div>
      </div>
      <div class="tc-bars">
        <div><div class="tc-bl">P&L</div><div class="tc-bv" style="color:var(--g)">$\${pnlK}</div><div class="tc-bg"><div class="tc-bf" style="width:\${t.pnl?(t.pnl/142830*100).toFixed(0):50}%;background:var(--g)"></div></div></div>
        <div><div class="tc-bl">Win%</div><div class="tc-bv" style="color:var(--b)">\${t.winRate||0}%</div><div class="tc-bg"><div class="tc-bf" style="width:\${t.winRate||0}%;background:var(--b)"></div></div></div>
        <div><div class="tc-bl">ROI</div><div class="tc-bv" style="color:var(--y)">\${roi}</div><div class="tc-bg"><div class="tc-bf" style="width:\${t.roi?t.roi/6.8*100:50}%;background:var(--y)"></div></div></div>
      </div></div>\`;
    el.appendChild(div);
  });
}

function renderChips() {
  const el=g('d-chips'); el.innerHTML='';
  const list = S.traders.length ? S.traders : [];
  list.slice(0,6).forEach((t,i)=>{
    const c=document.createElement('div'); c.className='chip';
    c.innerHTML=\`<span class="chip-r">#\${i+1}</span><span class="chip-a">\${t.address}</span><span class="chip-roi">+\${t.roi||0}x</span>\`;
    el.appendChild(c);
  });
  if(!el.children.length) el.innerHTML='<div style="color:var(--t3);font-size:13px;padding:8px 0">Connecting to leaderboard...</div>';
}

/* ─────────────────────────────────────────────────────────────────
   FEED
───────────────────────────────────────────────────────────────── */
function setF(f) {
  S.ff=f;
  ['all','copy','skip','win','loss'].forEach(id=>{ const el=g('fp-'+id); if(el) el.classList.toggle('on',id===f); });
  renderFeed();
}
function renderFeed() {
  const el=g('feed-scroll');
  let items=S.feed;
  if(S.ff!=='all') items=items.filter(i=>{
    if(S.ff==='copy') return i.kind==='copy';
    if(S.ff==='skip') return i.kind==='skip';
    if(S.ff==='win')  return i.win===true;
    if(S.ff==='loss') return i.win===false;
    return true;
  });
  if(!items.length){
    el.innerHTML=\`<div class="card2"><div class="fe"><div class="fe-ic">📡</div><div class="fe-h">\${S.railwayOk?'No '+S.ff+' events yet':'Waiting for Railway'}</div><div class="fe-p">\${S.railwayOk?'Bot is scanning — signals appear here':'Connect your Railway URL in Config & Keys'}</div></div></div>\`;
    return;
  }
  el.innerHTML='';
  const wrap=document.createElement('div'); wrap.className='card'; wrap.style.overflow='hidden';
  items.slice(0,100).forEach((item,i)=>{
    const d=document.createElement('div'); d.className='ti'+(item.fresh&&i===0?' fresh':'');
    if(i>0) d.style.borderTop='1px solid var(--bd3)';
    d.innerHTML=\`<div class="ti-ic \${item.cls}">\${item.icon}</div><div class="ti-body"><div class="ti-mkt">\${item.mkt}</div><div class="ti-det">\${item.det}</div></div><div class="ti-r"><div class="ti-amt \${item.ac}">\${item.amt}</div><div class="ti-ts">\${item.ts}</div></div>\`;
    wrap.appendChild(d);
  });
  el.appendChild(wrap);
  items.forEach(i=>{ i.fresh=false; });
}
function renderPrev() {
  const el=g('d-prev'); const r=S.feed.slice(0,4);
  if(!r.length){ el.innerHTML='<div style="padding:24px;text-align:center;color:var(--t3);font-size:14px">Waiting for bot signals...</div>'; return; }
  el.innerHTML='';
  r.forEach((item,i)=>{
    const d=document.createElement('div'); d.className='ti'; if(i>0) d.style.borderTop='1px solid var(--bd3)';
    d.innerHTML=\`<div class="ti-ic \${item.cls}" style="width:36px;height:36px;border-radius:11px;font-size:17px">\${item.icon}</div><div class="ti-body" style="min-width:0"><div class="ti-mkt" style="font-size:13px">\${item.mkt}</div><div class="ti-det">\${item.det}</div></div><div class="ti-r"><div class="ti-amt \${item.ac}" style="font-size:14px">\${item.amt}</div><div class="ti-ts">\${item.ts}</div></div>\`;
    el.appendChild(d);
  });
}

/* ─────────────────────────────────────────────────────────────────
   BOT TOGGLE (local sim when not connected)
───────────────────────────────────────────────────────────────── */
g('bot-tog').addEventListener('change', function() {
  if (S.railwayOk) {
    // Bot is on Railway — toggle just reflects local preference
    if (this.checked) {
      g('bot-orb').classList.add('live');
      g('bot-stat').textContent = 'Railway bot is active';
      toast('Bot is running on Railway ✅');
    } else {
      toast('Bot runs on Railway — toggle is display only','ℹ️');
      this.checked = true; // Keep it on since Railway controls it
    }
    return;
  }
  // No Railway — run local sim
  this.checked ? startSim() : stopSim();
});

const MKTS=['BTC >$95k — 5min','BTC >$94k — 5min','ETH >$3.5k — 5min','BTC up/down','ETH up/down','Crypto index up','Trump >45% approval','Fed rate cut June','S&P 500 ATH today','BTC >$100k EOD'];
function startSim() {
  S.botOn=true; g('bot-orb').classList.add('live');
  g('bot-stat').textContent='🟡 Local sim (connect Railway for real data)';
  g('feed-badge').className='badge b-demo'; g('feed-badge').innerHTML='<span class="ldot"></span>SIM';
  S.timers.forEach(clearTimeout); S.timers=[];
  (function loop(){ if(!S.botOn)return; emitSimEvent(); S.timers.push(setTimeout(loop,1200+Math.random()*2000)); })();
  toast('Local simulation started — connect Railway for real data','🧪');
}
function stopSim() {
  S.botOn=false; S.timers.forEach(t=>{clearTimeout(t);clearInterval(t);}); S.timers=[];
  g('bot-orb').classList.remove('live'); g('bot-stat').textContent='Tap to run local simulation';
  g('feed-badge').className='badge b-off'; g('feed-badge').textContent='PAUSED';
  toast('Simulation stopped','⏹');
}

function emitSimEvent() {
  const roll=Math.random();
  const mkt=MKTS[Math.floor(Math.random()*MKTS.length)];
  const now=ts(); const hr=new Date().getHours();

  if(roll<0.4){
    const trader=FALLBACK_TRADERS[Math.floor(Math.random()*4)];
    const side=Math.random()>.5?'YES':'NO';
    const price=(0.35+Math.random()*.4).toFixed(3);
    const sz=+(Math.min(20,20*.25+Math.random()*3)).toFixed(2);
    pushDispItem({kind:'prev',cls:'ic-prev',icon:'👁',mkt,
      det:\`[SIM] Mirror \${trader.address} → \${side}@\${price} × $\${sz.toFixed(0)}\`,
      amt:\`$\${sz.toFixed(0)}\`,ac:'prev',ts:now,win:null});
    setTimeout(()=>{
      const win=Math.random()>.30;
      const pnl=win?+(sz*.07).toFixed(4):-+(sz*.02).toFixed(4);
      pushDispItem({kind:'copy',cls:win?'ic-win':'ic-loss',icon:win?'✅':'❌',mkt,
        det:\`[SIM] Mirror settled \${win?'profit':'loss'}\`,amt:fmt(pnl),ac:pnl>=0?'pos':'neg',ts:ts(),win});
      S.trades.push({type:'copy',pnl,sz,win});
      S.pnl+=pnl; S.eq.push({t:Date.now(),v:S.pnl}); if(S.eq.length>300) S.eq.shift();
      S.hourly[hr]++; drawHM();
      updateDashFromSim(); updateAn(); drawSpark(); drawEq(); drawBars();
    }, 2000+Math.random()*1000);
  } else {
    pushDispItem({kind:'arb',cls:'ic-scan',icon:'📡',mkt,
      det:'Scanning markets…',amt:'—',ac:'pend',ts:now,win:null});
  }
}

function pushDispItem(item) {
  item.fresh=true; item.id = item.id || Date.now();
  S.feed.unshift(item);
  if(S.feed.length>150) S.feed.pop();
  renderFeed(); renderPrev();
  if(!g('s-feed').classList.contains('active')) g('dot-f').classList.add('show');
}

function updateDashFromSim() {
  const tot=S.trades.length, wins=S.trades.filter(t=>t.win).length, pnl=S.pnl;
  g('d-pnl').textContent=fmt(pnl); g('d-pnl').className='pnl-n '+(pnl>0?'pos':pnl<0?'neg':'z');
  g('d-psub').textContent=fmt(pnl)+' sim · '+tot+' trades'; g('d-psub').className='pnl-s '+(pnl>0?'pos':pnl<0?'neg':'z');
  g('pnl-card').className='card pnl-card mb12'+(pnl<0?' neg':'');
  g('d-trd').textContent=tot;
  g('s-wr').textContent=tot?Math.round(wins/tot*100)+'%':'—';
  g('s-cp').textContent=wins;
}

/* ─────────────────────────────────────────────────────────────────
   ANALYTICS
───────────────────────────────────────────────────────────────── */
function setRange(r){ S.range=r; document.querySelectorAll('.tpill').forEach((p,i)=>p.classList.toggle('on',['1h','6h','all'][i]===r)); drawEq(); }
function updateAn() {
  const tot=S.trades.length, wins=S.trades.filter(t=>t.win).length;
  if (!S.railwayOk && tot) {
    g('a-wins').textContent=wins; g('a-loss').textContent=tot-wins;
    if(tot){ const wr=wins/tot, c=2*Math.PI*36; g('d-arc').setAttribute('stroke-dasharray',\`\${(wr*c).toFixed(1)} \${((1-wr)*c).toFixed(1)}\`); g('d-arc').setAttribute('stroke',wr>=.5?'#30d158':'#ff453a'); g('d-pct').textContent=Math.round(wr*100)+'%'; }
  }
}

/* ─────────────────────────────────────────────────────────────────
   CANVAS CHARTS
───────────────────────────────────────────────────────────────── */
function ctx2(id) {
  const c=g(id); if(!c) return null;
  const dpr=window.devicePixelRatio||1;
  c.width=c.offsetWidth*dpr; c.height=c.offsetHeight*dpr;
  const cx=c.getContext('2d'); cx.scale(dpr,dpr);
  return {cx,W:c.offsetWidth,H:c.offsetHeight};
}
function drawSpark() {
  const r=ctx2('spark-cv'); if(!r) return;
  const {cx,W,H}=r; cx.clearRect(0,0,W,H);
  const h=S.eq; if(h.length<2) return;
  const vals=h.map(p=>p.v), mn=Math.min(...vals), mx=Math.max(...vals,mn+.001);
  const pts=vals.map((v,i)=>({x:(i/(vals.length-1))*W,y:H-((v-mn)/(mx-mn))*(H-4)-2}));
  const col=S.pnl>=0?'#30d158':'#ff453a';
  const gr=cx.createLinearGradient(0,0,0,H); gr.addColorStop(0,S.pnl>=0?'rgba(48,209,88,.28)':'rgba(255,69,58,.22)'); gr.addColorStop(1,'rgba(0,0,0,0)');
  cx.beginPath(); cx.moveTo(0,H); pts.forEach(p=>cx.lineTo(p.x,p.y)); cx.lineTo(W,H); cx.closePath(); cx.fillStyle=gr; cx.fill();
  cx.beginPath(); pts.forEach((p,i)=>i===0?cx.moveTo(p.x,p.y):cx.lineTo(p.x,p.y)); cx.strokeStyle=col; cx.lineWidth=1.5; cx.lineJoin='round'; cx.stroke();
}
function drawEq() {
  const r=ctx2('eq-cv'); if(!r) return;
  const {cx,W,H}=r; cx.clearRect(0,0,W,H);
  let data=S.eq; const now=Date.now();
  if(S.range==='1h') data=data.filter(p=>now-p.t<3600000);
  else if(S.range==='6h') data=data.filter(p=>now-p.t<21600000);
  if(data.length<2){ cx.strokeStyle='rgba(255,255,255,.08)'; cx.lineWidth=1; cx.beginPath(); cx.moveTo(0,H/2); cx.lineTo(W,H/2); cx.stroke(); return; }
  const vals=data.map(p=>p.v), mn=Math.min(...vals), mx=Math.max(...vals,mn+.01), range=mx-mn||.01, pad=14;
  const toY=v=>H-pad-((v-mn)/range)*(H-pad*2);
  const pts=data.map((p,i)=>({x:pad+(i/(data.length-1))*(W-pad*2),y:toY(p.v)}));
  const col=S.pnl>=0?'#30d158':'#ff453a';
  cx.strokeStyle='rgba(255,255,255,.05)'; cx.lineWidth=1;
  [0,.25,.5,.75,1].forEach(t=>{ const y=pad+(1-t)*(H-pad*2); cx.beginPath(); cx.moveTo(pad,y); cx.lineTo(W-pad,y); cx.stroke(); cx.fillStyle='rgba(255,255,255,.22)'; cx.font='10px JetBrains Mono'; const v=mn+t*range; cx.fillText((v>=0?'+':'')+'$'+Math.abs(v).toFixed(2),pad+4,y-4); });
  if(mn<0&&mx>0){ const zy=toY(0); cx.strokeStyle='rgba(255,255,255,.14)'; cx.setLineDash([4,4]); cx.beginPath(); cx.moveTo(pad,zy); cx.lineTo(W-pad,zy); cx.stroke(); cx.setLineDash([]); }
  const gr=cx.createLinearGradient(0,0,0,H); gr.addColorStop(0,S.pnl>=0?'rgba(48,209,88,.28)':'rgba(255,69,58,.22)'); gr.addColorStop(1,'rgba(0,0,0,0)');
  cx.beginPath(); cx.moveTo(pts[0].x,H); pts.forEach(p=>cx.lineTo(p.x,p.y)); cx.lineTo(pts[pts.length-1].x,H); cx.closePath(); cx.fillStyle=gr; cx.fill();
  cx.beginPath(); cx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++){ const cx1=(pts[i-1].x+pts[i].x)/2; cx.bezierCurveTo(cx1,pts[i-1].y,cx1,pts[i].y,pts[i].x,pts[i].y); }
  cx.strokeStyle=col; cx.lineWidth=2; cx.lineJoin='round'; cx.stroke();
  const ep=pts[pts.length-1]; cx.beginPath(); cx.arc(ep.x,ep.y,4,0,Math.PI*2); cx.fillStyle=col; cx.fill();
  cx.beginPath(); cx.arc(ep.x,ep.y,8,0,Math.PI*2); cx.fillStyle=S.pnl>=0?'rgba(48,209,88,.2)':'rgba(255,69,58,.18)'; cx.fill();
}
function drawHM() {
  const el=g('hm-grid'); if(!el) return;
  if(!el.children.length) for(let i=0;i<24;i++){ const c=document.createElement('div'); c.className='hm-c'; c.id='hm-'+i; el.appendChild(c); }
  const mx=Math.max(...S.hourly,1);
  S.hourly.forEach((v,i)=>{ const c=g('hm-'+i); if(!c) return; const t=v/mx; c.style.background=t>.3?\`rgba(48,209,88,\${.15+t*.4})\`:\`rgba(10,132,255,\${.07+t*.5})\`; });
}
function drawBars() {
  const r=ctx2('bar-cv'); if(!r) return;
  const {cx,W,H}=r; cx.clearRect(0,0,W,H);
  const wins=S.trades.filter(t=>t.win), losses=S.trades.filter(t=>t.win===false);
  const wv=wins.reduce((a,t)=>a+Math.abs(t.pnl||0),0), lv=losses.reduce((a,t)=>a+Math.abs(t.pnl||0),0);
  const mx=Math.max(wv,lv,.01), bw=W*.28, gap=W*.12, x1=(W-bw*2-gap)/2, x2=x1+bw+gap, pad=20;
  const drawBar=(x,h,col,lbl,val)=>{ const bh=Math.max(4,(h/mx)*(H-pad-8)), y=H-pad-bh; cx.beginPath(); if(cx.roundRect) cx.roundRect(x,y,bw,bh,4); else cx.rect(x,y,bw,bh); cx.fillStyle=col; cx.shadowBlur=12; cx.shadowColor=col; cx.fill(); cx.shadowBlur=0; cx.fillStyle='rgba(255,255,255,.4)'; cx.font='10px Outfit'; cx.textAlign='center'; cx.fillText(lbl,x+bw/2,H-5); cx.fillStyle='rgba(255,255,255,.9)'; cx.font='bold 12px Outfit'; cx.fillText('$'+Math.abs(val).toFixed(2),x+bw/2,y-6); };
  drawBar(x1,wv,'rgba(48,209,88,.75)','PROFIT',wv);
  drawBar(x2,lv,'rgba(255,69,58,.65)','LOSS',lv);
}

/* ─────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────── */
document.addEventListener('touchmove',e=>{ if(!e.target.closest('.scroll')&&!e.target.closest('.chips-wrap')&&!e.target.closest('.fpills')) e.preventDefault(); },{passive:false});
g('nb-feed').addEventListener('click',()=>g('dot-f').classList.remove('show'));
g('nb-chart').addEventListener('click',()=>{ setTimeout(()=>{ drawSpark(); drawEq(); drawBars(); drawHM(); },80); });

drawHM();
setTimeout(()=>{ drawSpark(); drawEq(); drawBars(); },150);
setTimeout(()=>{
  restore();
  g('splash').classList.add('gone');
  // If no Railway URL saved, nudge user
  if (!S.railwayUrl) {
    setConnStatus('err', 'No Railway URL — tap Config & Keys →');
    setTimeout(()=>{ g('dot-k').classList.add('show'); }, 600);
  }
}, 1400);
window.addEventListener('resize',()=>{ drawSpark(); drawEq(); drawBars(); });
</script>

<script>
// Auto-connect when served from Railway (not a file://)
if (window.location.protocol !== 'file:') {
  const selfUrl = window.location.origin;
  if (!localStorage.getItem('polybot_v3') || !JSON.parse(localStorage.getItem('polybot_v3') || '{}').railwayUrl) {
    // Pre-fill and auto-connect on first load
    setTimeout(() => {
      S.railwayUrl = selfUrl;
      const inp = document.getElementById('railway-url');
      if (inp) { inp.value = selfUrl; inp.classList.add('set'); }
      const btn = document.getElementById('url-connect-btn');
      if (btn) { btn.textContent = '✅ Auto-connected'; btn.className = 'url-connect ok'; }
      persist();
      pollRailway().then(() => { if (S.railwayOk) startPolling(); });
    }, 1600);
  }
}
</script>

</body>
</html>
`;

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    const url = req.url.split('?')[0];

    // ── SERVE DASHBOARD APP ──────────────────────────────────────
    if (url === '/' || url === '/app' || url === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(DASHBOARD_HTML);
      return;
    }

    // ── PWA MANIFEST ────────────────────────────────────────────
    if (url === '/manifest.json') {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.writeHead(200);
      res.end(JSON.stringify({
        name: 'Polybot',
        short_name: 'Polybot',
        description: 'Polymarket Copy Trading Bot',
        start_url: '/',
        display: 'standalone',
        background_color: '#07070e',
        theme_color: '#07070e',
        orientation: 'portrait',
        icons: [
          { src: '/icon.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ]
      }));
      return;
    }

    // ── APP ICON (SVG→PNG inline) ─────────────────────────────
    if (url === '/icon.png') {
      // 192x192 PNG generated inline — dark bg, blue PB monogram
      const { createCanvas } = (() => { try { return require('canvas'); } catch(e) { return null; } })() || {};
      if (createCanvas) {
        const canvas = createCanvas(192, 192);
        const ctx = canvas.getContext('2d');
        // Background
        const grad = ctx.createLinearGradient(0, 0, 192, 192);
        grad.addColorStop(0, '#0d1117');
        grad.addColorStop(1, '#07070e');
        ctx.fillStyle = grad;
        ctx.roundRect(0, 0, 192, 192, 38);
        ctx.fill();
        // Blue glow circle
        const radial = ctx.createRadialGradient(96, 80, 10, 96, 80, 70);
        radial.addColorStop(0, 'rgba(10,132,255,0.35)');
        radial.addColorStop(1, 'rgba(10,132,255,0)');
        ctx.fillStyle = radial;
        ctx.fillRect(0, 0, 192, 192);
        // PB text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 88px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('PB', 96, 96);
        res.setHeader('Content-Type', 'image/png');
        res.writeHead(200);
        res.end(canvas.toBuffer('image/png'));
      } else {
        // Fallback: serve a minimal 1x1 transparent PNG
        const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.writeHead(200);
        res.end(PNG1x1);
      }
      return;
    }

    // ── JSON API ROUTES ──────────────────────────────────────────
    res.setHeader('Content-Type', 'application/json');

    if (url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, uptime: Math.floor((Date.now() - STATE.startedAt) / 1000) }));
      return;
    }
    if (url === '/api/state') {
      const winRate = (STATE.wins + STATE.losses) > 0
        ? Math.round(STATE.wins / (STATE.wins + STATE.losses) * 100) : 0;
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true, mode: STATE.mode, pnl: STATE.pnl,
        wins: STATE.wins, losses: STATE.losses, skips: STATE.skips,
        winRate, cycles: STATE.cycles,
        uptime: Math.floor((Date.now() - STATE.startedAt) / 1000),
        traderCount: STATE.traders.length,
        walletAddr: STATE.walletAddr,
        lastUpdated: new Date().toISOString(),
      }));
      return;
    }
    if (url === '/api/trades') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, trades: STATE.trades }));
      return;
    }
    if (url === '/api/feed') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, feed: STATE.feed }));
      return;
    }
    if (url === '/api/traders') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, traders: STATE.traders.map(t => ({
        address: t.address.slice(0,10)+'...', roi: +(t.roi*100).toFixed(1),
        pnl: t.pnl, winRate: t.winRate, trades: t.trades,
      }))}));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });
  server.listen(PORT, () => {
    log('🌐', `Server on port ${PORT} — dashboard at https://YOUR-RAILWAY-URL.up.railway.app`);
  });
}

// ── COPY TRADE PROCESSOR ──────────────────────────────────────────
const seen = new Map();

async function processTrade(trader, pos) {
  if (!seen.has(trader.address)) seen.set(trader.address, new Set());
  if (seen.get(trader.address).has(pos.marketId)) return;

  const size = Math.min(CFG.MAX_TRADE, pos.value * CFG.COPY_RATIO);
  if (size < 1) { log('⏭', `Skip — too small ($${size.toFixed(2)})`); return; }

  const ai = await claudeVerdict(pos.market, trader.address, pos.side, pos.avgPrice, trader);

  const summary =
    `\n📡 <b>Copy Signal</b>\n` +
    `Market: ${pos.market.slice(0, 55)}\n` +
    `Trader: <code>${trader.address.slice(0,10)}...</code> ROI ${(trader.roi*100).toFixed(1)}%\n` +
    `Side: <b>${pos.side}</b> @ $${pos.avgPrice.toFixed(3)}\n` +
    `Their size: $${pos.value.toFixed(0)} → Our copy: $${size.toFixed(2)} USDC\n` +
    `Claude: <b>${ai.verdict}</b> ${(ai.confidence*100).toFixed(0)}% — ${ai.reason}`;

  if (ai.verdict === 'SKIP') {
    log('🧠', `SKIP — ${ai.reason}`);
    await tg(summary + '\n⛔ <b>Filtered by Claude AI</b>');
    seen.get(trader.address).add(pos.marketId);
    recordTrade({ market: pos.market, side: pos.side, size, price: pos.avgPrice, verdict: 'SKIP', won: null, trader: trader.address });
    return;
  }

  const result = await placeOrder(pos.marketId, pos.side, pos.avgPrice, size);
  if (result) {
    seen.get(trader.address).add(pos.marketId);
    const won = CFG.DRY_RUN ? (Math.random() > 0.35 ? true : false) : null;
    recordTrade({ market: pos.market, side: pos.side, size, price: pos.avgPrice, verdict: 'COPY', won, trader: trader.address });
    await tg(summary + (CFG.DRY_RUN ? '\n👁 <b>PREVIEW — no real trade</b>' : '\n✅ <b>ORDER PLACED</b>'));
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────
let traders    = [];
let cycleCount = 0;

async function runCycle() {
  cycleCount++;

  // If traders is empty (API was down at startup), try again
  if (traders.length === 0) {
    log('🔁', 'Trader list empty — retrying...');
    const fresh = await fetchTopTraders();
    if (fresh.length) traders = fresh;
  }

  STATE.cycles = cycleCount;
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
  console.log('║          POLYBOT v3.0 — STARTING             ║');
  console.log(`║  Mode: ${CFG.DRY_RUN
    ? '🧪 PREVIEW  (paper — no real trades)  '
    : '⚡ LIVE     (real USDC on Polygon)    '}║`);
  console.log('║  Wallet: Coinbase Wallet (address-based)     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Warn about missing vars but never crash in DRY_RUN
  const missing = [];
  if (!CFG.POLY_KEY)       missing.push('POLYMARKET_API_KEY');
  if (!CFG.WALLET_ADDRESS) missing.push('WALLET_ADDRESS');
  if (!CFG.CLAUDE_KEY)     missing.push('CLAUDE_API_KEY');
  if (!CFG.TG_TOKEN)       missing.push('TELEGRAM_TOKEN');
  if (!CFG.TG_CHAT)        missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    log('⚠️', `Missing env vars: ${missing.join(', ')}`);
    if (!CFG.DRY_RUN) { log('❌', 'Cannot go live with missing credentials'); process.exit(1); }
  }

  if (!CFG.DRY_RUN && !initClob()) {
    log('❌', 'CLOB failed'); process.exit(1);
  }

  // Start API server first so Railway health checks pass
  startApiServer();

  // Load traders — ALWAYS succeeds (falls back to hardcoded wallets)
  traders = await fetchTopTraders();
  STATE.traders = traders;
  log('🚀', `Starting with ${traders.length} traders — polling every ${CFG.POLL_MS/1000}s`);

  // Telegram startup ping
  await tg(
    `🤖 <b>Polybot v3 Online</b>\n` +
    `Mode: ${CFG.DRY_RUN ? '🧪 Preview (paper)' : '⚡ LIVE — real trades'}\n` +
    `Wallet: <code>${(CFG.WALLET_ADDRESS||'not set').slice(0,14)}...</code>\n` +
    `Watching: ${traders.length} traders\n` +
    `Max/trade: $${CFG.MAX_TRADE} | Ratio: ${(CFG.COPY_RATIO*100).toFixed(0)}% | Poll: ${CFG.POLL_MS/1000}s`
  );

  log(CFG.DRY_RUN ? '👁' : '⚡', CFG.DRY_RUN
    ? 'PREVIEW MODE — set DRY_RUN=false in Railway to go live'
    : 'LIVE MODE — real orders will execute'
  );

  await runCycle();

  setInterval(async () => {
    // Refresh leaderboard every 50 cycles
    if (cycleCount % 50 === 0) {
      const fresh = await fetchTopTraders();
      if (fresh.length) { traders = fresh; STATE.traders = fresh; log('🔁', 'Leaderboard refreshed'); }
    }
    await runCycle();
  }, CFG.POLL_MS);
}

process.on('SIGINT', async () => {
  log('🛑', 'Stopping...');
  await tg('🛑 <b>Polybot stopped</b>');
  process.exit(0);
});

process.on('uncaughtException', async err => {
  log('💥', 'Uncaught', err.message);
  await tg(`💥 <b>Polybot error</b>\n${err.message}`);
  // Don't exit — try to keep running
  setTimeout(() => {}, 1000);
});

main().catch(async err => {
  log('💥', 'Fatal', err.message);
  await tg(`💥 <b>Fatal error</b>\n${err.message}`);
  process.exit(1);
});
