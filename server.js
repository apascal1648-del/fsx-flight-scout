/**
 * FSX Flight Scout v20
 * Switched from Google Flights to Skyscanner.
 * - Direct URL: skyscanner.net/transport/flights/ZRH/KUL/260401/260701/
 * - No date grid, no form filling — goes straight to results
 * - Extracts each flight card: airline, dep time, arr time, duration, stops, price
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
let browser = null, launching = false;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) { for(let i=0;i<30;i++){await sleep(500);if(browser?.isConnected())return browser;} }
  launching = true;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled','--window-size=1366,768']
  });
  launching = false;
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/Zurich',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    window.chrome = { runtime:{}, loadTimes:()=>{}, csi:()=>{}, app:{} };
  });
  return ctx.newPage();
}

// Convert ISO date "2026-04-01" → Skyscanner format "260401"
function isoToSky(iso) {
  const d = new Date(iso + 'T12:00:00');
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

// Format ISO date for display: "2026-04-01" → "Apr 1 2026"
function isoToDisp(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
}

// Cabin class mapping for Skyscanner
function cabinParam(cabin) {
  if (/business/i.test(cabin)) return 'business';
  if (/first/i.test(cabin)) return 'first';
  return 'economy';
}

/**
 * Build Skyscanner search URL.
 * Example: https://www.skyscanner.net/transport/flights/zrh/kul/260401/260701/?adults=1&cabinclass=business&rtn=1&currency=EUR&locale=en-GB
 */
function buildSkyscannerUrl(from, to, depIso, retIso, cabin) {
  const depSky = isoToSky(depIso);
  const retSky = isoToSky(retIso);
  const cabinClass = cabinParam(cabin);
  return `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${depSky}/${retSky}/?adults=1&cabinclass=${cabinClass}&rtn=1&currency=EUR&locale=en-GB`;
}

/**
 * Handle cookie consent on Skyscanner
 */
async function handleSkyscannerConsent(page) {
  try {
    // Accept cookies button
    const acceptBtn = page.locator('button[id*="accept"], button[data-testid*="accept-btn"]').first();
    if (await acceptBtn.isVisible({ timeout: 4000 })) {
      await acceptBtn.click();
      console.log('[FSX] Skyscanner consent accepted');
      await sleep(1000);
      return;
    }
  } catch {}
  try {
    // Generic accept button
    const btns = await page.locator('button').all();
    for (const btn of btns) {
      const txt = (await btn.innerText().catch(() => '')).toLowerCase();
      if (txt.includes('accept') || txt.includes('agree') || txt.includes('ok')) {
        await btn.click();
        await sleep(1000);
        return;
      }
    }
  } catch {}
}

/**
 * Extract flights from Skyscanner results page text.
 * Skyscanner text format is typically:
 *
 * Swiss
 * 10:25 - 06:45+1
 * 1 stop · ZRH
 * 19h 20m
 * €2,049
 *
 * or for direct:
 * Malaysia Airlines
 * 11:30 - 06:00+1
 * Direct
 * 13h 30m
 * €1,980
 */
function parseSkyscannerFlights(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];

  const knownAirlines = [
    'Qatar Airways','Emirates','Etihad Airways','Etihad','Turkish Airlines',
    'Singapore Airlines','Cathay Pacific','Lufthansa','Swiss','SWISS',
    'Air France','KLM','British Airways','Finnair','Thai Airways',
    'ANA','All Nippon Airways','JAL','Japan Airlines','Korean Air',
    'Malaysia Airlines','Vietnam Airlines','EVA Air','China Airlines',
    'Asiana Airlines','Asiana','Air China','China Southern','China Eastern',
    'Garuda Indonesia','Garuda','Philippine Airlines','Oman Air','Gulf Air',
    'Saudia','Air India','IndiGo','flydubai','Air Arabia','Multiple airlines',
  ];

  for (let i = 0; i < lines.length - 2; i++) {
    const line = lines[i];

    // Anchor: time range "10:25 - 06:45+1" or "10:25 – 06:45"
    const timeMatch = line.match(
      /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(\+\d)?$/
    );
    if (!timeMatch) continue;

    const depTime = timeMatch[1];
    const arrTime = timeMatch[2] + (timeMatch[3] || '');

    // Search backwards up to 4 lines for airline
    let airline = '';
    for (let j = Math.max(0, i - 4); j < i; j++) {
      const l = lines[j];
      const known = knownAirlines.find(a => l.toLowerCase().includes(a.toLowerCase()));
      if (known) { airline = known; break; }
      // Fallback heuristic
      if (
        l.length >= 3 && l.length <= 60 &&
        /[A-Za-z]{3}/.test(l) &&
        !/^\d|€|£|\$|stop|direct|hr|min|:\d|Economy|Business|First|cabin|price|cheapest|sort|filter|from/i.test(l) &&
        !/\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/.test(l)
      ) airline = l;
    }

    // Search forward up to 8 lines for stops, duration, price
    let stops = 0, via = '', dur = '', layoverDur = '', numPrice = 0;

    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const l = lines[j];

      // Stops: "Direct", "1 stop", "2 stops", "1 stop · DXB"
      if (/^direct$/i.test(l)) { stops = 0; continue; }
      const stopM = l.match(/^(\d+)\s*stops?(?:\s*·\s*([A-Z]{3}))?/i);
      if (stopM) {
        stops = parseInt(stopM[1]);
        if (stopM[2]) via = stopM[2];
        continue;
      }

      // Duration: "19h 20m" or "13h 30m"
      if (!dur) {
        const durM = l.match(/^(\d+)h\s*(\d+)?m?$/i) || l.match(/^(\d+)\s*hr(?:s?)(?:\s+(\d+)\s*min)?$/i);
        if (durM) { dur = durM[1] + 'h ' + (durM[2] || '0') + 'm'; continue; }
      }

      // Layover
      if (!layoverDur) {
        const layM = l.match(/(\d+)h\s*(\d+)?m?\s+layover/i);
        if (layM) layoverDur = layM[1] + 'h ' + (layM[2] || '0') + 'm';
      }

      // Price: "€2,049" or "€ 2049" or "2,049 €"
      if (!numPrice) {
        const priceM = l.match(/^€\s*([\d,]+)$/) || l.match(/^([\d,]+)\s*€$/);
        if (priceM) {
          const n = parseInt(priceM[1].replace(/,/g, ''));
          if (n >= 100 && n <= 60000) { numPrice = n; break; }
        }
      }
    }

    if (!numPrice || !dur) continue; // must have price and duration

    results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur,
      price: '€' + numPrice, numPrice });
  }

  // Deduplicate by depTime + price
  const seen = new Set();
  return results.filter(r => {
    const k = r.depTime + '-' + r.numPrice;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Main scrape function — Skyscanner direct URL
 */
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
  const page = await newPage();
  try {
    // Compute return date from depart + stay
    const depDate = new Date(depart + 'T12:00:00');
    const retDate = new Date(depDate.getTime() + stay * 86400000);
    const retIso = retDate.toISOString().slice(0, 10);

    const url = buildSkyscannerUrl(from, to, depart, retIso, cabin);
    console.log('[FSX] Skyscanner URL:', url);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(2000);
    await handleSkyscannerConsent(page);
    await sleep(1000);

    // Wait for flight results — prices and times must appear
    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return (t.match(/€[\d,]+/g) || []).length >= 3
              && (t.match(/\d{1,2}:\d{2}/g) || []).length >= 4;
        },
        { timeout: 30000, polling: 2000 }
      );
      console.log('[FSX] Skyscanner results loaded');
    } catch(e) {
      console.log('[FSX] Wait timeout:', e.message.slice(0, 50));
    }

    await sleep(2000);
    // Scroll to load more results
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1000);

    const resultUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '));

    console.log('[FSX] Page text length:', pageText.length);
    console.log('[FSX] Sample text:\n' + pageText.slice(0, 1000));

    let flights = parseSkyscannerFlights(pageText);
    console.log('[FSX]', from, '->', to, '| flights found:', flights.length);

    if (flights.length === 0) {
      console.log('[FSX] Full page text:\n' + pageText.slice(0, 3000));
      return [];
    }

    flights.sort((a, b) => a.numPrice - b.numPrice);
    const top = flights.slice(0, 5);

    const depDisp = isoToDisp(depart);
    const retDisp = isoToDisp(retIso);
    const stayDays = Math.round((retDate - depDate) / 86400000);

    return top.map((f, idx) => ({
      from, to, fromCode: from, toCode: to,
      airline:    f.airline || 'See Skyscanner',
      dur:        f.dur,
      stops:      f.stops,
      via:        f.via,
      layoverDur: f.layoverDur,
      price:      f.price,
      numPrice:   f.numPrice,
      dep:        depDisp + (f.depTime ? ' ' + f.depTime : ''),
      ret:        retDisp + (f.arrTime ? ' ' + f.arrTime : ''),
      depDate:    depart,
      retDate:    retIso,
      stayLabel:  stayDays + 'd',
      cabin,
      real:       true,
      best:       idx === 0,
      buyUrl:     resultUrl,
    }));

  } finally {
    await page.context().close().catch(() => {});
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────
const EU_HUBS = [
  {code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},
  {code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},
  {code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'}
];
const AS_AIRPORTS = [
  {code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},
  {code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},
  {code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},
  {code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'}
];

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online — Skyscanner', version: '20.0' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'FSX-standalone.html')));

app.get('/scrape', async (req, res) => {
  const { from, to, depart, ret, cabin = 'Business', stay = '90' } = req.query;
  if (!from || !to || !depart || !ret)
    return res.status(400).json({ error: 'from, to, depart, ret required' });
  try {
    const results = await scrapeRoute({ from, to, depart, ret, cabin, stay: parseInt(stay) });
    res.json({ ok: true, results });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/scan', async (req, res) => {
  const { fromCode, toCode, depart, ret, cabin = 'Business', stay = '90' } = req.query;
  if (!depart || !ret) return res.status(400).json({ error: 'depart and ret required' });
  const origins = (!fromCode || fromCode === 'ALL')
    ? EU_HUBS : EU_HUBS.filter(h => fromCode.split(',').includes(h.code));
  const dests = (!toCode || toCode === 'ALL')
    ? AS_AIRPORTS : AS_AIRPORTS.filter(a => toCode.split(',').includes(a.code));
  const all = [];
  for (const o of origins) {
    for (const d of dests) {
      try {
        const r = await scrapeRoute({ from: o.code, to: d.code, depart, ret, cabin, stay: parseInt(stay) });
        r.forEach(x => { x.from = o.name; x.to = d.name; });
        all.push(...r);
        await sleep(2000);
      } catch(e) { console.error('[FSX]', o.code, '->', d.code, e.message.slice(0, 50)); }
    }
  }
  all.sort((a, b) => a.numPrice - b.numPrice);
  const seen = {};
  all.forEach(r => { const k = r.fromCode + '-' + r.toCode; if (!seen[k]) { r.best = true; seen[k] = true; } });
  res.json({ ok: true, count: all.length, results: all.slice(0, 50) });
});

app.listen(PORT, () => console.log('[FSX] Server v20 (Skyscanner) on port', PORT));
