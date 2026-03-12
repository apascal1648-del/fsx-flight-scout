/**
 * FSX · Flight Scout — Scraper Server v2
 * Uses direct URL navigation instead of form-filling (much more reliable)
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Browser singleton ─────────────────────────────────────────────────────
let browser = null;
let launching = false;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) {
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (browser && browser.isConnected()) return browser;
    }
  }
  launching = true;
  console.log('[FSX] Launching browser…');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });
  launching = false;
  console.log('[FSX] Browser ready');
  return browser;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtDate(isoStr) {
  const d = new Date(isoStr + 'T12:00:00');
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[d.getDay()] + ' ' + d.getDate() + ' ' + mons[d.getMonth()] + ' ' + d.getFullYear();
}

function stayDays(dep, ret) {
  const a = new Date(dep + 'T12:00:00');
  const b = new Date(ret + 'T12:00:00');
  const d = Math.round((b - a) / 86400000);
  const w = Math.round(d / 7);
  return w > 0 ? w + ' wks (' + d + 'd)' : d + 'd';
}

function cabinCode(cabin) {
  if (/economy/i.test(cabin)) return 1;
  if (/first/i.test(cabin)) return 3;
  return 2; // Business
}

// ── Core scraper ──────────────────────────────────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin, params }) {
  const b = await getBrowser();
  const page = await b.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    const cc = cabinCode(cabin);
    // Direct URL — no form filling needed
    const url = `https://www.google.com/travel/flights?hl=en&curr=EUR#flt=${from}.${to}.${depart}*${to}.${from}.${ret};c:EUR;e:${cc};s:0*1;sd:1;t:f`;
    console.log('[FSX] GET', url.slice(0, 80));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1500);

    // Accept cookies
    try {
      const btn = page.locator('button').filter({ hasText: /Accept all|I agree|Agree/i }).first();
      if (await btn.isVisible({ timeout: 3000 })) { await btn.click(); await sleep(1500); }
    } catch {}

    // Wait for flights to appear
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(3500);

    const flights = await page.evaluate(() => {
      const results = [];

      // Strategy 1: known Google Flights list item selectors
      const itemSelectors = [
        '[jsname="IWWMLc"]',
        'li[jsname]',
        '.pIav2d',
        '.Rk10dc',
        '.yR1fYc',
        '[data-id]',
      ];

      let cards = [];
      for (const sel of itemSelectors) {
        const found = [...document.querySelectorAll(sel)];
        // Filter: must have a price-like pattern and time pattern
        const filtered = found.filter(el => {
          const t = el.innerText || '';
          return t.match(/\d{1,2}:\d{2}/) && (t.match(/EUR|€|\$/) || t.match(/[\d,]{3,}/)) && t.length > 40;
        });
        if (filtered.length >= 1) { cards = filtered.slice(0, 10); break; }
      }

      // Strategy 2: scan all divs for flight-shaped text blocks
      if (cards.length === 0) {
        const all = [...document.querySelectorAll('div, li')];
        cards = all.filter(el => {
          const t = el.innerText || '';
          const hasTimes = (t.match(/\d{1,2}:\d{2}/g) || []).length >= 2;
          const hasPrice = /EUR\s*[\d,]+|[\d,]+\s*EUR|€\s*[\d,]+/.test(t);
          return hasTimes && hasPrice && t.length > 50 && t.length < 600;
        }).slice(0, 10);
      }

      cards.forEach(card => {
        try {
          const txt = (card.innerText || '').trim();
          if (txt.length < 40) return;
          const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

          // Price
          const pm = txt.match(/EUR\s*([\d,]+)/) || txt.match(/([\d,]+)\s*EUR/) || txt.match(/€\s*([\d,]+)/);
          if (!pm) return;
          const priceNum = parseInt(pm[1].replace(/,/g, ''));
          if (priceNum < 100 || priceNum > 50000) return;
          const price = 'EUR ' + pm[1].replace(',', '');

          // Times
          const times = [...txt.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => m[1]);

          // Duration
          const dm = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?/) || txt.match(/(\d+)h\s*(\d+)?m?/);
          const dur = dm ? dm[1] + 'h' + (dm[2] ? dm[2] + 'm' : '') : '';

          // Stops
          let stops = 0, via = '';
          if (/nonstop|direct/i.test(txt)) stops = 0;
          else if (/1 stop/i.test(txt)) {
            stops = 1;
            const vm = txt.match(/1 stop\s*\(([^)]+)\)/i);
            if (vm) via = vm[1];
          } else if (/(\d+) stops?/i.test(txt)) stops = parseInt(txt.match(/(\d+) stops?/i)[1]);

          // Airline: first short line that looks like an airline name
          const airline = lines.find(l =>
            l.length >= 2 && l.length <= 40 &&
            !l.match(/^\d|EUR|€|stop|hr|min|nonstop|direct|AM|PM/i)
          ) || lines[0] || 'Unknown';

          results.push({ airline, depTime: times[0]||'', arrTime: times[1]||'', dur, stops, via, price, priceNum });
        } catch {}
      });

      return results;
    });

    console.log('[FSX]', from, '->', to, ':', flights.length, 'flights found');

    return flights.map(f => ({
      from: (params && params.fromName) || from,
      to:   (params && params.toName)   || to,
      fromCode: from, toCode: to,
      airline: f.airline,
      dur: f.dur, stops: f.stops, via: f.via,
      price: f.price,
      numPrice: f.priceNum,
      dep: fmtDate(depart) + (f.depTime ? ' ' + f.depTime : ''),
      ret: fmtDate(ret)    + (f.arrTime ? ' ' + f.arrTime : ''),
      depDate: depart, retDate: ret,
      stayLabel: stayDays(depart, ret),
      cabin, real: true,
      buyUrl: `https://www.google.com/travel/flights?hl=en&curr=EUR#flt=${from}.${to}.${depart}*${to}.${from}.${ret};c:EUR;e:${cc};s:0*1;sd:1;t:f`,
    }));

  } finally {
    await page.close().catch(() => {});
  }
}

// ── Airports ──────────────────────────────────────────────────────────────
const EU_HUBS = [
  {code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},
  {code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},
  {code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'},
];
const AS_AIRPORTS = [
  {code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},
  {code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},
  {code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},
  {code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'},
];

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '2.0' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'FSX-standalone.html')));

app.get('/scrape', async (req, res) => {
  const { from, to, depart, ret, cabin = 'Business', fromName, toName } = req.query;
  if (!from || !to || !depart || !ret)
    return res.status(400).json({ error: 'from, to, depart, ret required' });
  try {
    const results = await scrapeRoute({ from, to, depart, ret, cabin, params: { fromName, toName } });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/scan', async (req, res) => {
  const { fromCode, toCode, depart, ret, cabin = 'Business' } = req.query;
  if (!depart || !ret) return res.status(400).json({ error: 'depart and ret required' });

  // Support comma-separated hub/dest lists or ALL
  const origins = (!fromCode || fromCode === 'ALL')
    ? EU_HUBS
    : EU_HUBS.filter(h => fromCode.split(',').includes(h.code));
  const dests   = (!toCode || toCode === 'ALL')
    ? AS_AIRPORTS
    : AS_AIRPORTS.filter(a => toCode.split(',').includes(a.code));

  const all = [];
  for (const org of origins) {
    for (const dst of dests) {
      try {
        console.log('[FSX] Scanning', org.code, '->', dst.code);
        const results = await scrapeRoute({ from: org.code, to: dst.code, depart, ret, cabin, params: { fromName: org.name, toName: dst.name } });
        results.forEach(r => { r.from = org.name; r.to = dst.name; });
        all.push(...results);
        await sleep(1500);
      } catch (e) {
        console.error('[FSX] Failed', org.code, '->', dst.code, ':', e.message.slice(0, 60));
      }
    }
  }

  all.sort((a, b) => a.numPrice - b.numPrice);

  // Mark best per route
  const seen = {};
  all.forEach(r => {
    const k = r.fromCode + '-' + r.toCode;
    if (!seen[k]) { r.best = true; seen[k] = true; }
  });

  res.json({ ok: true, count: all.length, results: all.slice(0, 30) });
});

app.listen(PORT, () => console.log('[FSX] Server on port', PORT));
