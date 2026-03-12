/**
 * FSX · Flight Scout — Scraper Server v3
 * FIXED: replaces deprecated #flt= hash URLs with actual form filling
 */
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Browser singleton ───────────────────────────────────────────────────
let browser = null, launching = false;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) {
    for (let i = 0; i < 30; i++) { await sleep(500); if (browser?.isConnected()) return browser; }
  }
  launching = true;
  console.log('[FSX] Launching browser…');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled','--window-size=1280,900'],
  });
  launching = false;
  console.log('[FSX] Browser ready');
  return browser;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}
function stayDays(dep, ret) {
  const d = Math.round((new Date(ret+'T12:00:00') - new Date(dep+'T12:00:00')) / 86400000);
  return d + 'd';
}
function cabinCode(cabin) {
  if (/economy/i.test(cabin)) return 1;
  if (/first/i.test(cabin))   return 3;
  return 2;
}
// Google Flights date format: "Feb 15 2027"
function gfDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

// ── Core scraper — uses form filling ────────────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business' }) {
  const b    = await getBrowser();
  const page = await b.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    // 1. Load Google Flights homepage
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2500);

    // 2. Dismiss any cookie consent (multi-language)
    for (const txt of ['Accept all','Reject all','I agree','Accept','Tout accepter','Alle akzeptieren']) {
      try {
        const btn = page.getByRole('button', { name: txt, exact: true });
        if (await btn.isVisible({ timeout: 600 })) { await btn.click(); await sleep(1000); break; }
      } catch {}
    }

    // 3. Switch cabin class if not Economy
    if (!/economy/i.test(cabin)) {
      try {
        const cabinBtn = page.locator('button', { hasText: /^Economy$/ }).first();
        if (await cabinBtn.isVisible({ timeout: 2000 })) {
          await cabinBtn.click(); await sleep(600);
          await page.locator('li', { hasText: new RegExp('^'+cabin+'$','i') }).first().click();
          await sleep(500);
        }
      } catch {}
    }

    // 4. Fill origin (click, clear, type IATA, pick first suggestion)
    const originSel = 'input[aria-label*="Where from"], input[placeholder*="Where from"]';
    await page.locator(originSel).first().click();
    await sleep(400);
    await page.keyboard.press('Control+a');
    await page.keyboard.type(from, { delay: 70 });
    await sleep(1800);
    await page.keyboard.press('ArrowDown');
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(800);

    // 5. Fill destination
    const destSel = 'input[aria-label*="Where to"], input[placeholder*="Where to"]';
    await page.locator(destSel).first().click();
    await sleep(400);
    await page.keyboard.type(to, { delay: 70 });
    await sleep(1800);
    await page.keyboard.press('ArrowDown');
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(800);

    // 6. Fill departure date
    const depDateSel = '[aria-label="Departure"], input[placeholder="Departure"]';
    const depInput = page.locator(depDateSel).first();
    if (await depInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await depInput.click(); await sleep(400);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(gfDate(depart), { delay: 50 });
      await sleep(600);
      await page.keyboard.press('Tab');
      await sleep(400);
    }

    // 7. Fill return date
    const retDateSel = '[aria-label="Return"], input[placeholder="Return"]';
    const retInput = page.locator(retDateSel).first();
    if (await retInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await retInput.click(); await sleep(400);
      await page.keyboard.press('Control+a');
      await page.keyboard.type(gfDate(ret), { delay: 50 });
      await sleep(600);
    }

    // 8. Click Done (closes date picker)
    try {
      const doneBtn = page.getByRole('button', { name: 'Done' }).last();
      if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await doneBtn.click(); await sleep(500);
      }
    } catch {}

    // 9. Click Search / Explore button
    try {
      const searchBtn = page.getByRole('button', { name: /^(Search|Explore)$/i }).last();
      await searchBtn.waitFor({ state: 'visible', timeout: 5000 });
      await searchBtn.click();
    } catch {
      await page.keyboard.press('Enter');
    }

    // 10. Wait for results
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await sleep(4000);

    const resultUrl = page.url();
    console.log(`[FSX] ${from}->${to} results at: ${resultUrl.slice(0,80)}`);

    // 11. Extract flights from DOM
    const flights = await page.evaluate(() => {
      const results = [];

      // Try various selectors for flight list items
      const selectors = [
        '[role="listitem"]', 'li[data-id]', '.gws-flights-results__result-item',
        'li[jsname]', '.pIav2d',
      ];
      let cards = [];
      for (const sel of selectors) {
        const found = [...document.querySelectorAll(sel)].filter(el => {
          const t = el.innerText || '';
          return (t.match(/\d{1,2}:\d{2}/g)||[]).length >= 2 &&
                 /EUR\s*[\d,]+|[\d,]+\s*EUR|€/.test(t) &&
                 t.length > 50 && t.length < 1200;
        });
        if (found.length > 0) { cards = found.slice(0, 12); break; }
      }

      // Fallback: scan all divs/lis
      if (cards.length === 0) {
        cards = [...document.querySelectorAll('div,li')].filter(el => {
          const t = el.innerText || '';
          return (t.match(/\d{1,2}:\d{2}/g)||[]).length >= 2 &&
                 /EUR\s*[\d,]+|[\d,]+\s*EUR|€\s*[\d,]+/.test(t) &&
                 t.length > 50 && t.length < 700;
        }).slice(0, 12);
      }

      cards.forEach(card => {
        try {
          const txt = (card.innerText || '').trim();
          if (txt.length < 40) return;
          const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

          // Price
          const pm = txt.match(/EUR\s*([\d,]+)/) || txt.match(/([\d,]+)\s*EUR/) || txt.match(/€\s*([\d,]+)/);
          if (!pm) return;
          const priceNum = parseInt(pm[1].replace(/,/g,''));
          if (priceNum < 100 || priceNum > 60000) return;

          // Times
          const times = [...txt.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => m[1]);

          // Duration
          const dm = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?/) || txt.match(/(\d+)h\s*(\d+)?m?/);
          const dur = dm ? dm[1]+'h'+(dm[2] ? dm[2]+'m' : '') : '';

          // Stops
          let stops = 0, via = '';
          if (/nonstop|direct/i.test(txt)) stops = 0;
          else if (/1 stop/i.test(txt)) {
            stops = 1;
            const vm = txt.match(/1 stop\s*\(([^)]+)\)/i);
            if (vm) via = vm[1];
          } else if (/(\d) stop/i.test(txt)) stops = parseInt(txt.match(/(\d) stop/i)[1]);

          // Airline name
          const airline = lines.find(l =>
            l.length >= 2 && l.length <= 45 &&
            !/^\d|EUR|€|stop|nonstop|hr |min|AM|PM|\d:\d|\+\d/.test(l)
          ) || 'Unknown';

          results.push({ airline, depTime: times[0]||'', arrTime: times[1]||'', dur, stops, via, priceNum, price: 'EUR '+(pm[1]) });
        } catch {}
      });
      return results;
    });

    console.log(`[FSX] ${from}->${to}: ${flights.length} flights extracted`);

    const cc = cabinCode(cabin);
    return flights.map(f => ({
      from, to, fromCode: from, toCode: to,
      airline: f.airline,
      dur: f.dur, stops: f.stops, via: f.via,
      price: f.price, numPrice: f.priceNum,
      dep: fmtDate(depart) + (f.depTime ? ' '+f.depTime : ''),
      ret: fmtDate(ret)    + (f.arrTime ? ' '+f.arrTime : ''),
      depDate: depart, retDate: ret,
      stayLabel: stayDays(depart, ret),
      cabin, real: true,
      // Link to the exact same search result page
      buyUrl: resultUrl || `https://www.google.com/travel/flights?hl=en&curr=EUR#flt=${from}.${to}.${depart}*${to}.${from}.${ret};c:EUR;e:${cc};s:0*1;sd:1;t:f`,
    }));

  } finally {
    await page.close().catch(() => {});
  }
}

// ── Airports ────────────────────────────────────────────────────────────
const EU_HUBS = [
  {code:'ZRH',name:'Zurich'}, {code:'FRA',name:'Frankfurt'}, {code:'CDG',name:'Paris'},
  {code:'LHR',name:'London'}, {code:'AMS',name:'Amsterdam'}, {code:'VIE',name:'Vienna'},
  {code:'BCN',name:'Barcelona'}, {code:'FCO',name:'Rome'},
];
const AS_AIRPORTS = [
  {code:'NRT',name:'Tokyo'},   {code:'ICN',name:'Seoul'},     {code:'SIN',name:'Singapore'},
  {code:'BKK',name:'Bangkok'}, {code:'HKG',name:'Hong Kong'}, {code:'KUL',name:'Kuala Lumpur'},
  {code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},     {code:'SGN',name:'Ho Chi Minh'},
  {code:'MNL',name:'Manila'},  {code:'TPE',name:'Taipei'},    {code:'CGK',name:'Jakarta'},
];

// ── Routes ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '3.0' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'FSX-standalone.html')));

// Debug endpoint: returns screenshot of what the scraper sees
app.get('/debug', async (req, res) => {
  const { from='ZRH', to='SIN', depart, ret } = req.query;
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    const d = depart || new Date(Date.now()+90*86400000).toISOString().slice(0,10);
    const r = ret    || new Date(Date.now()+195*86400000).toISOString().slice(0,10);
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 20000
    });
    await sleep(2000);
    const buf = await page.screenshot({ fullPage: false });
    res.set('Content-Type','image/png');
    res.send(buf);
  } finally { await page.close().catch(()=>{}); }
});

app.get('/scrape', async (req, res) => {
  const { from, to, depart, ret, cabin='Business' } = req.query;
  if (!from || !to || !depart || !ret)
    return res.status(400).json({ error: 'from, to, depart, ret required' });
  try {
    const results = await scrapeRoute({ from, to, depart, ret, cabin });
    res.json({ ok: true, results });
  } catch(e) {
    console.error('[FSX] /scrape error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/scan', async (req, res) => {
  const { fromCode, toCode, depart, ret, cabin='Business' } = req.query;
  if (!depart || !ret) return res.status(400).json({ error: 'depart and ret required' });

  const origins = (!fromCode || fromCode==='ALL')
    ? EU_HUBS : EU_HUBS.filter(h => fromCode.split(',').includes(h.code));
  const dests   = (!toCode   || toCode==='ALL')
    ? AS_AIRPORTS : AS_AIRPORTS.filter(a => toCode.split(',').includes(a.code));

  const all = [];
  for (const org of origins) {
    for (const dst of dests) {
      try {
        console.log('[FSX] Scanning', org.code, '->', dst.code);
        const results = await scrapeRoute({ from: org.code, to: dst.code, depart, ret, cabin });
        results.forEach(r => { r.from = org.name; r.to = dst.name; });
        all.push(...results);
        await sleep(2000);
      } catch(e) {
        console.error('[FSX] Failed', org.code, '->', dst.code, ':', e.message.slice(0,60));
      }
    }
  }

  all.sort((a,b) => a.numPrice - b.numPrice);
  const seen = {};
  all.forEach(r => { const k = r.fromCode+'-'+r.toCode; if (!seen[k]) { r.best=true; seen[k]=true; } });
  res.json({ ok: true, count: all.length, results: all.slice(0,30) });
});

app.listen(PORT, () => console.log('[FSX] Server v3 on port', PORT));
