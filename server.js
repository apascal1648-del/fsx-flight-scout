/**
 * FSX Flight Scout v21
 * Skyscanner scraping with:
 * - Mobile user agent (less likely to be blocked)
 * - Proper timeout handling to avoid Railway 502s
 * - Better consent handling
 * - Detailed logging to diagnose issues
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
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-blink-features=AutomationControlled',
             '--disable-web-security','--window-size=390,844']
    });
  } finally { launching = false; }
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const ctx = await b.newContext({
    // Use mobile user agent — less bot detection
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
  });
  return ctx.newPage();
}

function isoToSky(iso) {
  const d = new Date(iso + 'T12:00:00');
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

function isoToDisp(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
}

function cabinParam(cabin) {
  if (/business/i.test(cabin)) return 'business';
  if (/first/i.test(cabin)) return 'first';
  return 'economy';
}

function buildUrl(from, to, depIso, retIso, cabin) {
  const depSky = isoToSky(depIso);
  const retSky = isoToSky(retIso);
  return `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${depSky}/${retSky}/?adults=1&cabinclass=${cabinParam(cabin)}&rtn=1&currency=EUR&locale=en-GB`;
}

async function handleConsent(page) {
  try {
    // Skyscanner cookie banner
    const selectors = [
      '[data-testid="cookie-banner-accept-btn"]',
      '#acceptCookieButton',
      'button[id*="accept"]',
      'button[data-testid*="accept"]',
    ];
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log('[FSX] Cookie consent accepted via:', sel);
          await sleep(800);
          return;
        }
      } catch {}
    }
    // Text-based fallback
    const btns = await page.locator('button').all();
    for (const btn of btns) {
      const txt = (await btn.innerText().catch(() => '')).toLowerCase();
      if (txt.includes('accept all') || txt.includes('accept cookie')) {
        await btn.click(); await sleep(800); return;
      }
    }
  } catch(e) { console.log('[FSX] Consent handler error:', e.message.slice(0,50)); }
}

function parseFlights(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];

  const knownAirlines = [
    'Qatar Airways','Emirates','Etihad Airways','Etihad','Turkish Airlines',
    'Singapore Airlines','Cathay Pacific','Lufthansa','Swiss','SWISS',
    'Air France','KLM','British Airways','Finnair','Thai Airways',
    'ANA','All Nippon Airways','JAL','Japan Airlines','Korean Air',
    'Malaysia Airlines','Vietnam Airlines','EVA Air','China Airlines',
    'Asiana Airlines','Air China','China Southern','China Eastern',
    'Garuda Indonesia','Garuda','Philippine Airlines','Oman Air','Gulf Air',
    'Saudia','Air India','IndiGo','flydubai','Air Arabia','Multiple airlines',
  ];

  for (let i = 0; i < lines.length - 2; i++) {
    const line = lines[i];

    // Time range: "10:25 - 06:45+1" or "10:25 – 06:45"
    const tm = line.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(\+\d)?$/);
    if (!tm) continue;

    const depTime = tm[1];
    const arrTime = tm[2] + (tm[3] || '');

    // Airline — search backwards
    let airline = '';
    for (let j = Math.max(0, i - 5); j < i; j++) {
      const l = lines[j];
      const known = knownAirlines.find(a => l.toLowerCase().includes(a.toLowerCase()));
      if (known) { airline = known; break; }
      if (l.length >= 3 && l.length <= 60 && /[A-Za-z]{3}/.test(l) &&
          !/^\d|€|£|stop|direct|hr|min|:\d|Economy|Business|First|cabin|price|Sort|Filter|From|Search|Select/i.test(l) &&
          !/\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/.test(l))
        airline = l;
    }

    // Forward: stops, duration, price
    let stops = 0, via = '', dur = '', layoverDur = '', numPrice = 0;
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const l = lines[j];

      if (/^direct$/i.test(l)) { stops = 0; continue; }
      const sm = l.match(/^(\d+)\s*stops?(?:\s*[·•]\s*([A-Z]{3}))?/i);
      if (sm) { stops = parseInt(sm[1]); if (sm[2]) via = sm[2]; continue; }

      if (!dur) {
        const dm = l.match(/^(\d+)h\s*(\d+)?m?$/) || l.match(/^(\d+)\s*hr(?:s?)(?:\s+(\d+)\s*min)?$/i);
        if (dm) { dur = dm[1] + 'h ' + (dm[2] || '0') + 'm'; continue; }
      }

      if (!layoverDur) {
        const lm = l.match(/(\d+)h\s*(\d+)?m?\s+layover/i);
        if (lm) layoverDur = lm[1] + 'h ' + (lm[2] || '0') + 'm';
      }

      if (!numPrice) {
        const pm = l.match(/^€\s*([\d,]+)$/) || l.match(/^([\d,.]+)\s*€$/);
        if (pm) {
          const n = parseInt(pm[1].replace(/[,\.]/g, ''));
          if (n >= 100 && n <= 60000) { numPrice = n; break; }
        }
      }
    }

    if (!numPrice) continue;
    results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur,
      price: '€' + numPrice, numPrice });
  }

  const seen = new Set();
  return results.filter(r => {
    const k = r.depTime + '-' + r.numPrice;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
  const page = await newPage();
  const depDate = new Date(depart + 'T12:00:00');
  const retDate = new Date(depDate.getTime() + stay * 86400000);
  const retIso = retDate.toISOString().slice(0, 10);

  try {
    const url = buildUrl(from, to, depart, retIso, cabin);
    console.log('[FSX] Loading:', url);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(2000);
    await handleConsent(page);
    await sleep(1000);

    const currentUrl = page.url();
    const pageTitle = await page.title();
    console.log('[FSX] Page title:', pageTitle);
    console.log('[FSX] Current URL:', currentUrl.slice(0, 100));

    // Wait for prices to appear
    try {
      await page.waitForFunction(
        () => (document.body.innerText.match(/€[\d,]+/g) || []).length >= 2,
        { timeout: 25000, polling: 2000 }
      );
      console.log('[FSX] Prices found on page');
    } catch(e) {
      console.log('[FSX] No prices found in time:', e.message.slice(0, 50));
    }

    await sleep(1500);
    const text = await page.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '));
    console.log('[FSX] Page text length:', text.length);
    console.log('[FSX] Page text sample:\n' + text.slice(0, 1500));

    const flights = parseFlights(text);
    console.log('[FSX]', from, '->', to, '| flights:', flights.length);

    if (flights.length === 0) return [];

    flights.sort((a, b) => a.numPrice - b.numPrice);
    const top = flights.slice(0, 5);
    const stayDays = Math.round((retDate - depDate) / 86400000);

    return top.map((f, idx) => ({
      from, to, fromCode: from, toCode: to,
      airline: f.airline || 'See Skyscanner',
      dur: f.dur, stops: f.stops, via: f.via, layoverDur: f.layoverDur,
      price: f.price, numPrice: f.numPrice,
      dep: isoToDisp(depart) + (f.depTime ? ' ' + f.depTime : ''),
      ret: isoToDisp(retIso) + (f.arrTime ? ' ' + f.arrTime : ''),
      depDate: depart, retDate: retIso,
      stayLabel: stayDays + 'd', cabin,
      real: true, best: idx === 0, buyUrl: currentUrl,
    }));

  } catch(e) {
    console.log('[FSX] scrapeRoute error:', e.message);
    return [];
  } finally {
    await page.context().close().catch(() => {});
  }
}

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

app.get('/health', (req, res) => res.json({ status: 'FSX online - Skyscanner v21' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'FSX-standalone.html')));

app.get('/scrape', async (req, res) => {
  const { from, to, depart, ret, cabin = 'Business', stay = '90' } = req.query;
  if (!from || !to || !depart || !ret)
    return res.status(400).json({ error: 'from, to, depart, ret required' });
  try {
    const results = await scrapeRoute({ from, to, depart, ret, cabin, stay: parseInt(stay) });
    res.json({ ok: true, results });
  } catch(e) {
    console.log('[FSX] /scrape error:', e.message);
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

app.listen(PORT, () => console.log('[FSX] Server v21 (Skyscanner) on port', PORT));
