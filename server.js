/**
 * FSX Flight Scout v17
 * Based on v14's PROVEN date grid approach (it works).
 * Fix: after landing on flight results page, extract ALL distinct flight cards
 * (each with its own airline, dep time, arr time, duration, price)
 * instead of reusing flightDetails[0] for all results.
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
      await sleep(2000); return;
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

async function switchCabin(page, cabin) {
  if (/economy/i.test(cabin)) return true;
  try {
    const switched = await page.evaluate(async (targetCabin) => {
      const combos = [...document.querySelectorAll('[role="combobox"]')];
      const cabinCombo = combos.find(el => /economy|business|first|premium/i.test(el.innerText || ''));
      if (!cabinCombo) return { ok: false };
      cabinCombo.click();
      await new Promise(r => setTimeout(r, 700));
      const opts = [...document.querySelectorAll('li[role="option"]')];
      const target = opts.find(el => new RegExp('^\\s*' + targetCabin + '\\s*$', 'i').test(el.innerText || ''));
      if (!target) return { ok: false };
      target.click();
      return { ok: true };
    }, cabin);
    await sleep(400);
    return switched.ok === true;
  } catch { return false; }
}

function isoToDisp(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
}

// ── Date grid parser (proven from v14) ────────────────────────────────────
function parseDateGrid(text, depart, ret) {
  const depDate = new Date(depart + 'T12:00:00');
  const retDate = new Date(ret + 'T12:00:00');
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  let currentYear = depDate.getFullYear(), currentMonth = -1;
  const datePrices = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let m = 0; m < 12; m++) {
      if (line.startsWith(monthNames[m])) {
        currentMonth = m;
        const y = line.match(/(202\d)/);
        if (y) currentYear = parseInt(y[1]);
        break;
      }
    }
    const dm = line.match(/^(\d{1,2})$/);
    if (dm && currentMonth >= 0) {
      const day = parseInt(dm[1]);
      const next = lines[i + 1] || '';
      const pm = next.match(/^€([\d,]+)$/);
      if (pm) {
        const price = parseInt(pm[1].replace(/,/g, ''));
        const date = new Date(currentYear, currentMonth, day);
        if (date >= depDate && date <= retDate && price > 0 && price < 60000) {
          datePrices.push({
            date, price, day, month: currentMonth, year: currentYear,
            iso: date.toISOString().slice(0, 10)
          });
        }
        i++;
      }
    }
  }
  datePrices.sort((a, b) => a.price - b.price);
  return datePrices;
}

// ── Click cheapest date on the grid (proven from v14) ─────────────────────
async function clickCheapestDate(page, datePrices) {
  if (!datePrices.length) return null;
  const best = datePrices[0];
  console.log('[FSX] Clicking cheapest date:', best.iso, '€' + best.price);
  try {
    const clicked = await page.evaluate((targetIso, targetPrice) => {
      const byIso = document.querySelector('[data-iso="' + targetIso + '"]');
      if (byIso) { byIso.click(); return { method: 'data-iso' }; }
      const allEls = [...document.querySelectorAll('*')];
      for (const el of allEls) {
        const t = (el.innerText || '').trim();
        if (t === '€' + targetPrice && el.children.length <= 2) {
          el.click(); return { method: 'price-text', text: t };
        }
      }
      for (const el of allEls) {
        if ((el.innerText || '').includes('€' + targetPrice) && el.tagName === 'TD') {
          el.click(); return { method: 'TD' };
        }
      }
      return null;
    }, best.iso, best.price);

    if (clicked) {
      console.log('[FSX] Clicked via:', clicked.method);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(3000);
      return best;
    }
  } catch(e) {
    console.log('[FSX] clickCheapestDate error:', e.message.slice(0, 50));
  }
  return null;
}

// ── NEW: Extract ALL distinct flight cards from results page ──────────────
// Reads raw page text and parses each flight block with its own details
function parseFlightResultsFromText(text) {
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
    'Saudia','Air India','IndiGo','flydubai','Air Arabia',
  ];

  for (let i = 0; i < lines.length - 3; i++) {
    const line = lines[i];

    // Anchor: time range pattern "10:15 AM – 7:30 AM" or "10:15 – 07:30"
    const timeMatch = line.match(
      /^(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*[–\-—]\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?$/i
    );
    if (!timeMatch) continue;

    const depTime = timeMatch[1].trim();
    const arrTime = timeMatch[2].trim() + (timeMatch[3] || '');

    // Search backwards up to 6 lines for airline
    let airline = '';
    for (let j = Math.max(0, i - 6); j < i; j++) {
      const l = lines[j];
      const known = knownAirlines.find(a => l.toLowerCase() === a.toLowerCase());
      if (known) { airline = known; break; }
      // Partial match
      const partial = knownAirlines.find(a => l.toLowerCase().includes(a.toLowerCase()));
      if (partial && !airline) { airline = partial; }
    }
    // Fallback: look for any non-keyword line near the time anchor
    if (!airline) {
      for (let j = Math.max(0, i - 4); j < i; j++) {
        const l = lines[j];
        if (
          l.length >= 3 && l.length <= 60 &&
          /[A-Za-z]{3}/.test(l) &&
          !/^\d|€|\$|nonstop|direct|stop|hr|min|\d:\d|\+\d|Economy|Business|First|Select|Book|More|Carbon|Wi-Fi|USB/i.test(l) &&
          !/\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/.test(l)
        ) {
          airline = l;
        }
      }
    }

    // Search forward up to 15 lines for duration, stops, price
    let dur = '', stops = 0, via = '', layoverDur = '', numPrice = 0;

    for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
      const l = lines[j];

      // Duration: "13 hr 25 min" or "13 hr"
      if (!dur) {
        const dm = l.match(/^(\d+)\s*hr(?:\s+(\d+)\s*min)?$/i);
        if (dm) { dur = dm[1] + 'h ' + (dm[2] || '0') + 'm'; continue; }
      }

      // Stops
      if (/^nonstop$/i.test(l)) { stops = 0; continue; }
      if (/^1 stop$/i.test(l)) { stops = 1; continue; }
      const sm = l.match(/^(\d+) stops?$/i);
      if (sm) { stops = parseInt(sm[1]); continue; }

      // Via airport
      if (!via) {
        const vm = l.match(/(?:stop|layover)[^A-Z]*([A-Z]{3})\b/);
        if (vm) via = vm[1];
      }

      // Layover duration
      if (!layoverDur) {
        const lm = l.match(/(\d+)\s*hr(?:\s+(\d+)\s*min)?\s+layover/i);
        if (lm) layoverDur = lm[1] + 'h ' + (lm[2] || '0') + 'm';
      }

      // Price — stop here when found
      if (!numPrice) {
        const pm = l.match(/^€\s*([\d,]+)$/);
        if (pm) {
          const n = parseInt(pm[1].replace(/,/g, ''));
          if (n >= 200 && n <= 60000) { numPrice = n; break; }
        }
      }
    }

    if (!numPrice || !dur) continue; // must have both price and duration to be valid

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

// ── Main scrape function ───────────────────────────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
  const page = await newPage();
  try {
    // Step 1: Go to Google Flights (no dates — shows date grid)
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    await handleConsent(page);
    if (page.url().includes('consent')) { await handleConsent(page); await sleep(1000); }

    const cabinOk = await switchCabin(page, cabin);

    // Step 2: Fill origin
    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click(); await sleep(300);
    await page.keyboard.press('Control+a');
    for (const ch of from) await page.keyboard.type(ch, { delay: 80 });
    await sleep(2000);
    await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(800);

    // Step 3: Fill destination
    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click(); await sleep(300);
    for (const ch of to) await page.keyboard.type(ch, { delay: 80 });
    await sleep(2000);
    await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(800);

    // Step 4: Search (no dates → shows date grid)
    await page.keyboard.press('Escape'); await sleep(300);
    try {
      const sb = page.getByRole('button', { name: /^(Search|Explore)$/i }).last();
      await sb.waitFor({ state: 'visible', timeout: 5000 });
      await sb.click();
    } catch { await page.keyboard.press('Enter'); }

    // Step 5: Wait for date grid prices
    try {
      await page.waitForFunction(
        () => (document.body.innerText.match(/€\d{3,5}/g) || []).length >= 5,
        { timeout: 30000, polling: 1500 }
      );
    } catch {}
    await sleep(1000);

    const gridUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText);
    const datePrices = parseDateGrid(pageText, depart, ret);
    console.log('[FSX]', from, '->', to, '| grid prices in range:', datePrices.length, '| cabin:', cabinOk ? cabin : 'Economy*');

    if (!datePrices.length) return [];

    // Step 6: Click cheapest date → lands on flight results page
    const bestDate = await clickCheapestDate(page, datePrices);
    const resultUrl = page.url();

    if (!bestDate || resultUrl === gridUrl) {
      console.log('[FSX] Could not navigate to results page');
      return [];
    }

    // Step 7: Scroll to load more results
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1500);

    // Step 8: Extract ALL flight cards from results page
    const resultsText = await page.evaluate(() => document.body.innerText);
    console.log('[FSX] Results page text length:', resultsText.length);

    let flights = parseFlightResultsFromText(resultsText);
    console.log('[FSX] Flights extracted from results page:', flights.length);

    // If text parsing got nothing, log page for debugging
    if (flights.length === 0) {
      console.log('[FSX] Debug — results page sample:\n', resultsText.slice(0, 2000));
    }

    // Step 9: Build results — use real flight cards if available,
    // otherwise fall back to top 5 grid prices with basic info
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    if (flights.length > 0) {
      // We have real per-flight data — return top 5 by price
      flights.sort((a, b) => a.numPrice - b.numPrice);
      const top = flights.slice(0, 5);

      const depDisp = isoToDisp(bestDate.iso);
      const retDate = new Date(bestDate.date.getTime() + stay * 86400000);
      const retIso = retDate.toISOString().slice(0, 10);
      const retDisp = isoToDisp(retIso);

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
        depDate:    bestDate.iso,
        retDate:    retIso,
        stayLabel:  stay + 'd',
        cabin:      cabinOk ? cabin : 'Economy*',
        real:       true,
        best:       idx === 0,
        buyUrl:     resultUrl,
      }));

    } else {
      // Fallback: top 5 grid prices, no flight details
      return datePrices.slice(0, 5).map((dp, idx) => {
        const depDisp = M[dp.month] + ' ' + dp.day + ' ' + dp.year;
        const retDate = new Date(dp.date.getTime() + stay * 86400000);
        const retStr = M[retDate.getMonth()] + ' ' + retDate.getDate() + ' ' + retDate.getFullYear();
        const retIso = retDate.toISOString().slice(0, 10);
        return {
          from, to, fromCode: from, toCode: to,
          airline: 'See Google Flights',
          dur: '', stops: 0, via: '', layoverDur: '',
          price: '€' + dp.price,
          numPrice: dp.price,
          dep: depDisp,
          ret: retStr,
          depDate: dp.iso,
          retDate: retIso,
          stayLabel: stay + 'd',
          cabin: cabinOk ? cabin : 'Economy*',
          real: true,
          best: idx === 0,
          buyUrl: resultUrl,
        };
      });
    }

  } finally {
    await page.context().close().catch(() => {});
  }
}

// ── Express routes ─────────────────────────────────────────────────────────
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

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '17.0' }));
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

app.listen(PORT, () => console.log('[FSX] Server v17 on port', PORT));
