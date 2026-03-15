/**
 * FSX Flight Scout v16
 * Key fixes vs v15:
 * 1. Direct URL navigation — no form filling, goes straight to flight results
 * 2. Text-based parsing — reads raw page text, much more resilient to DOM changes
 * 3. Each of the top 5 results has its own real airline, times, duration
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
    locale: 'en-US',
    timezoneId: 'Europe/Zurich',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    window.chrome = { runtime:{}, loadTimes:()=>{}, csi:()=>{}, app:{} };
  });
  return ctx.newPage();
}

async function handleConsent(page) {
  if (!page.url().includes('consent.google.com')) return;
  try {
    const btn = page.locator('button').filter({ hasText: /accept all/i }).first();
    if (await btn.isVisible({ timeout: 5000 })) {
      await btn.click();
      await page.waitForURL(/google\.com\/travel/, { timeout: 15000 });
      await sleep(2000);
      return;
    }
  } catch {}
  try {
    for (const b of await page.locator('button').all()) {
      const t = (await b.innerText().catch(() => '')).toLowerCase();
      if (t.includes('accept') || t.includes('agree') || t.includes('reject')) {
        await b.click(); await sleep(2000); return;
      }
    }
  } catch {}
}

// Format ISO date for display: "2026-05-01" -> "May 1 2026"
function isoToDisp(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
}

// Build direct Google Flights URL with all params pre-filled
// e:1=economy, e:2=business, e:3=first
function buildFlightUrl(from, to, depart, ret, cabin) {
  const e = /business/i.test(cabin) ? 2 : /first/i.test(cabin) ? 3 : 1;
  return `https://www.google.com/travel/flights?hl=en&curr=EUR#flt=${from}.${to}.${depart}*${to}.${from}.${ret};c:EUR;e:${e};sd:1;t:f`;
}

/**
 * Parse flight data from page text.
 * Google Flights results text typically looks like:
 *
 * Qatar Airways
 * 10:15 AM - 7:30 AM+1
 * Nonstop
 * 13 hr 15 min
 * ZRH - KUL
 * EUR1,850
 *
 * We scan line by line looking for the time range pattern as anchor,
 * then collect airline (before), duration/stops/price (after).
 */
function parseFlightsFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];

  // Known airline names to help with detection
  const knownAirlines = [
    'Qatar Airways','Emirates','Etihad','Turkish Airlines','Singapore Airlines',
    'Cathay Pacific','Lufthansa','Swiss','SWISS','Air France','KLM',
    'British Airways','Finnair','Thai Airways','ANA','JAL','Korean Air',
    'Malaysia Airlines','Vietnam Airlines','EVA Air','China Airlines','Asiana',
    'Air China','China Southern','China Eastern','Garuda','Philippine Airlines',
    'Oman Air','Gulf Air','Saudia','Air India','IndiGo','flydubai','Air Arabia',
  ];

  for (let i = 0; i < lines.length - 4; i++) {
    const line = lines[i];

    // Anchor: look for a departure - arrival time pattern
    // Matches: "10:15 AM - 7:30 AM+1" or "10:15 - 07:30" or "10:15 AM - 7:30+1"
    const timeMatch = line.match(
      /^(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*[–\-—]\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?$/i
    );
    if (!timeMatch) continue;

    const depTime = timeMatch[1].trim();
    const arrTime = timeMatch[2].trim() + (timeMatch[3] ? timeMatch[3] : '');

    // Search backwards up to 5 lines for airline name
    let airline = '';
    for (let j = Math.max(0, i - 5); j < i; j++) {
      const l = lines[j];
      // Check known airlines first
      const known = knownAirlines.find(a => l.toLowerCase().includes(a.toLowerCase()));
      if (known) { airline = known; break; }
      // Fallback: a line that looks like an airline name
      if (
        l.length >= 3 && l.length <= 60 &&
        /[A-Za-z]{3}/.test(l) &&
        !/^\d|€|\$|nonstop|direct|stop|hr|min|\d:\d|\+\d|Economy|Business|First|Class|Select|Book|More/i.test(l) &&
        !/\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/.test(l)
      ) {
        airline = l;
      }
    }

    // Search forward up to 12 lines for duration, stops, price
    let dur = '', stops = 0, via = '', layoverDur = '', numPrice = 0;

    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const l = lines[j];

      // Duration: "13 hr 25 min" or "13 hr"
      if (!dur) {
        const dm = l.match(/^(\d+)\s*hr(?:\s*(\d+)\s*min)?$/i);
        if (dm) { dur = dm[1] + 'h ' + (dm[2] || '0') + 'm'; continue; }
      }

      // Stops
      if (/^nonstop$/i.test(l)) { stops = 0; continue; }
      if (/^1 stop$/i.test(l)) { stops = 1; continue; }
      const stopsMatch = l.match(/^(\d+) stops?$/i);
      if (stopsMatch) { stops = parseInt(stopsMatch[1]); continue; }

      // Via airport from stop info like "1 stop · DXB"
      const viaMatch = l.match(/(?:stop|layover)[^\w]*([A-Z]{3})\b/i);
      if (viaMatch && !via) via = viaMatch[1];

      // Layover duration
      if (!layoverDur) {
        const lm = l.match(/(\d+)\s*hr(?:\s*(\d+)\s*min)?\s*layover/i);
        if (lm) layoverDur = lm[1] + 'h ' + (lm[2] || '0') + 'm';
      }

      // Price: "€1,850" or "€ 1850"
      if (!numPrice) {
        const pm = l.match(/^€\s*([\d,]+)$/);
        if (pm) {
          const n = parseInt(pm[1].replace(/,/g, ''));
          if (n >= 200 && n <= 60000) {
            numPrice = n;
            break; // price found — this flight block is complete
          }
        }
      }
    }

    if (!numPrice) continue; // no price = not a real flight card

    results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur, price: '€' + numPrice, numPrice });
  }

  // Deduplicate by depTime + price
  const seen = new Set();
  return results.filter(r => {
    const key = r.depTime + '-' + r.numPrice;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scrapeRoute({ from, to, depart, ret, cabin = 'Business' }) {
  const page = await newPage();
  try {
    const url = buildFlightUrl(from, to, depart, ret, cabin);
    console.log('[FSX] Navigating to:', url);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(2000);
    await handleConsent(page);
    await sleep(1000);

    // Wait for flight results — need times AND prices AND durations on page
    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return (t.match(/€\s*[\d,]+/g) || []).length >= 2
              && /\d{1,2}:\d{2}/.test(t)
              && /\d+\s*hr/.test(t);
        },
        { timeout: 35000, polling: 1500 }
      );
    } catch(e) {
      console.log('[FSX] waitForFunction timeout, trying anyway:', e.message.slice(0, 40));
    }

    await sleep(2000);

    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1500);

    const resultUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText);

    console.log('[FSX] Page text length:', pageText.length);
    console.log('[FSX] Sample:', pageText.slice(0, 400).replace(/\n/g, ' | '));

    let flights = parseFlightsFromText(pageText);
    console.log('[FSX]', from, '->', to, '| depart:', depart, '| flights found:', flights.length);

    if (flights.length === 0) {
      console.log('[FSX] Full page text for debug:\n', pageText.slice(0, 2000));
      return [];
    }

    // Sort by price, take top 5
    flights.sort((a, b) => a.numPrice - b.numPrice);
    const top = flights.slice(0, 5);

    const depDisp = isoToDisp(depart);
    const retDisp = isoToDisp(ret);
    const stayDays = Math.round((new Date(ret + 'T12:00:00') - new Date(depart + 'T12:00:00')) / 86400000);

    return top.map((f, idx) => ({
      from, to, fromCode: from, toCode: to,
      airline:    f.airline || 'See Google Flights',
      dur:        f.dur,
      stops:      f.stops,
      via:        f.via,
      layoverDur: f.layoverDur,
      price:      f.price,
      numPrice:   f.numPrice,
      dep:        depDisp + (f.depTime ? ' ' + f.depTime : ''),
      ret:        retDisp + (f.arrTime ? ' ' + f.arrTime : ''),
      depDate:    depart,
      retDate:    ret,
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

// ── Routes ─────────────────────────────────────────────────────────────────
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

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '16.0' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'FSX-standalone.html')));

app.get('/scrape', async (req, res) => {
  const { from, to, depart, ret, cabin = 'Business' } = req.query;
  if (!from || !to || !depart || !ret)
    return res.status(400).json({ error: 'from, to, depart, ret required' });
  try {
    const results = await scrapeRoute({ from, to, depart, ret, cabin });
    res.json({ ok: true, results });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/scan', async (req, res) => {
  const { fromCode, toCode, depart, ret, cabin = 'Business' } = req.query;
  if (!depart || !ret) return res.status(400).json({ error: 'depart and ret required' });
  const origins = (!fromCode || fromCode === 'ALL')
    ? EU_HUBS : EU_HUBS.filter(h => fromCode.split(',').includes(h.code));
  const dests = (!toCode || toCode === 'ALL')
    ? AS_AIRPORTS : AS_AIRPORTS.filter(a => toCode.split(',').includes(a.code));
  const all = [];
  for (const o of origins) {
    for (const d of dests) {
      try {
        const r = await scrapeRoute({ from: o.code, to: d.code, depart, ret, cabin });
        r.forEach(x => { x.from = o.name; x.to = d.name; });
        all.push(...r);
        await sleep(2000);
      } catch(e) {
        console.error('[FSX]', o.code, '->', d.code, e.message.slice(0, 50));
      }
    }
  }
  all.sort((a, b) => a.numPrice - b.numPrice);
  const seen = {};
  all.forEach(r => {
    const k = r.fromCode + '-' + r.toCode;
    if (!seen[k]) { r.best = true; seen[k] = true; }
  });
  res.json({ ok: true, count: all.length, results: all.slice(0, 50) });
});

app.listen(PORT, () => console.log('[FSX] Server v16 on port', PORT));
