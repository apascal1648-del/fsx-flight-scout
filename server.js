/**
 * FSX Flight Scout v19
 * Clean approach:
 * Step 1: Use date grid (proven) to find cheapest date in window
 * Step 2: Open a FRESH page and search Google Flights directly with that date
 *         (fill origin, destination, dep date, return date, search)
 * Step 3: Extract flight cards from results
 * Step 4: Fall back to grid prices if extraction fails
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

// ── Step 1: Date grid (proven working) ───────────────────────────────────
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
          datePrices.push({ date, price, day, month: currentMonth, year: currentYear, iso: date.toISOString().slice(0, 10) });
        }
        i++;
      }
    }
  }
  datePrices.sort((a, b) => a.price - b.price);
  return datePrices;
}

// ── Step 2: Search with specific date and extract flights ─────────────────
async function searchAndExtract(from, to, depIso, retIso, cabin) {
  const page = await newPage();
  try {
    console.log('[FSX] Opening fresh search for', from, '->', to, depIso, '->', retIso);

    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    await handleConsent(page);
    await sleep(500);

    const cabinOk = await switchCabin(page, cabin);

    // Fill origin
    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click(); await sleep(400);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    for (const ch of from) await page.keyboard.type(ch, { delay: 100 });
    await sleep(2500);
    await page.keyboard.press('ArrowDown'); await sleep(400);
    await page.keyboard.press('Enter'); await sleep(1000);

    // Fill destination
    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click(); await sleep(400);
    for (const ch of to) await page.keyboard.type(ch, { delay: 100 });
    await sleep(2500);
    await page.keyboard.press('ArrowDown'); await sleep(400);
    await page.keyboard.press('Enter'); await sleep(1000);

    // Now fill DEPARTURE DATE
    // After selecting destination, focus usually moves to date field
    // Format date as "Apr 8 2026" which Google accepts
    const dep = new Date(depIso + 'T12:00:00');
    const retD = new Date(retIso + 'T12:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const depStr = months[dep.getMonth()] + ' ' + dep.getDate() + ' ' + dep.getFullYear();
    const retStr = months[retD.getMonth()] + ' ' + retD.getDate() + ' ' + retD.getFullYear();

    // Try to find and fill departure date input
    let dateFilled = false;
    try {
      // Click on departure date field
      const depDateInput = page.locator('input[placeholder*="Departure"], [aria-label*="Departure date"], [data-placeholder*="Departure"]').first();
      if (await depDateInput.isVisible({ timeout: 3000 })) {
        await depDateInput.click(); await sleep(500);
        await page.keyboard.press('Control+a');
        await page.keyboard.type(depStr, { delay: 80 });
        await sleep(500);
        await page.keyboard.press('Enter'); await sleep(500);
        dateFilled = true;
        console.log('[FSX] Dep date filled:', depStr);
      }
    } catch(e) { console.log('[FSX] Dep date fill attempt 1 failed:', e.message.slice(0,50)); }

    // If first attempt failed, try typing directly after destination enter
    if (!dateFilled) {
      try {
        await sleep(500);
        await page.keyboard.type(depStr, { delay: 80 });
        await sleep(500);
        await page.keyboard.press('Enter'); await sleep(500);
        dateFilled = true;
        console.log('[FSX] Dep date filled via keyboard:', depStr);
      } catch(e) { console.log('[FSX] Dep date fill attempt 2 failed:', e.message.slice(0,50)); }
    }

    // Fill return date
    try {
      const retDateInput = page.locator('input[placeholder*="Return"], [aria-label*="Return date"]').first();
      if (await retDateInput.isVisible({ timeout: 3000 })) {
        await retDateInput.click(); await sleep(500);
        await page.keyboard.press('Control+a');
        await page.keyboard.type(retStr, { delay: 80 });
        await sleep(500);
        await page.keyboard.press('Enter'); await sleep(500);
        console.log('[FSX] Ret date filled:', retStr);
      }
    } catch(e) { console.log('[FSX] Ret date fill failed:', e.message.slice(0,50)); }

    // Click Search button
    await page.keyboard.press('Escape'); await sleep(300);
    try {
      const sb = page.getByRole('button', { name: /^Search$/i }).last();
      await sb.waitFor({ state: 'visible', timeout: 5000 });
      await sb.click();
      console.log('[FSX] Clicked Search');
    } catch {
      await page.keyboard.press('Enter');
      console.log('[FSX] Pressed Enter to search');
    }

    // Wait for flight results — times and prices must appear
    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          const times = (t.match(/\d{1,2}:\d{2}/g) || []);
          return times.length >= 4 && /€\s*[\d,]+/.test(t);
        },
        { timeout: 30000, polling: 1500 }
      );
      console.log('[FSX] Flight results loaded');
    } catch(e) {
      console.log('[FSX] Timeout waiting for results:', e.message.slice(0, 50));
    }

    await sleep(2000);
    const resultUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText.replace(/\u00a0/g, ' '));

    // Log page text for debugging
    console.log('[FSX] Results page text (first 1500 chars):');
    console.log(pageText.slice(0, 1500));

    const flights = extractFlightsFromText(pageText);
    console.log('[FSX] Flights extracted:', flights.length);

    return { flights, resultUrl, cabinOk };
  } finally {
    await page.context().close().catch(() => {});
  }
}

// ── Extract flights from page text ───────────────────────────────────────
function extractFlightsFromText(text) {
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

    // Look for time range on one line: "10:15 AM – 7:30 AM" or "10:15 – 07:30"
    const timeMatch = line.match(
      /^(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*[–\-—]\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?$/i
    );
    // Or just a single time "10:15 AM"
    const singleTime = !timeMatch && line.match(/^(\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i);

    let depTime = '', arrTime = '';
    if (timeMatch) {
      depTime = timeMatch[1].trim();
      arrTime = timeMatch[2].trim() + (timeMatch[3] || '');
    } else if (singleTime) {
      // Find another time in next 3 lines
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const nm = lines[k].match(/^(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?$/i);
        if (nm) { depTime = singleTime[1]; arrTime = nm[1] + (nm[2] || ''); break; }
      }
    }
    if (!depTime) continue;

    // Search backwards for airline
    let airline = '';
    for (let j = Math.max(0, i - 6); j < i; j++) {
      const l = lines[j];
      const known = knownAirlines.find(a => l.toLowerCase().includes(a.toLowerCase()));
      if (known) { airline = known; break; }
    }
    if (!airline) {
      for (let j = Math.max(0, i - 4); j < i; j++) {
        const l = lines[j];
        if (l.length >= 3 && l.length <= 60 && /[A-Za-z]{3}/.test(l) &&
            !/^\d|€|\$|nonstop|direct|stop|hr|min|:\d|Economy|Business|First|Select|Book|More|Carbon/i.test(l) &&
            !/\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/.test(l))
          airline = l;
      }
    }

    // Search forward for duration, stops, price
    let dur = '', stops = 0, via = '', layoverDur = '', numPrice = 0;
    for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
      const l = lines[j];
      if (!dur) {
        const dm = l.match(/^(\d+)\s*hr(?:s?)(?:\s+(\d+)\s*min)?$/i);
        if (dm) { dur = dm[1] + 'h ' + (dm[2] || '0') + 'm'; continue; }
      }
      if (/^nonstop$/i.test(l)) { stops = 0; continue; }
      if (/^1\s*stop$/i.test(l)) { stops = 1; continue; }
      const sm = l.match(/^(\d+)\s*stops?$/i); if (sm) { stops = parseInt(sm[1]); continue; }
      if (!via) { const vm = l.match(/·\s*([A-Z]{3})\s*·/) || l.match(/(?:stop|layover)[^A-Z]*([A-Z]{3})\b/); if (vm) via = vm[1]; }
      if (!layoverDur) { const lm = l.match(/(\d+)\s*hr(?:s?)(?:\s+(\d+)\s*min)?\s+layover/i); if (lm) layoverDur = lm[1] + 'h ' + (lm[2] || '0') + 'm'; }
      if (!numPrice) {
        const pm = l.match(/^€\s*([\d,]+)$/);
        if (pm) { const n = parseInt(pm[1].replace(/,/g, '')); if (n >= 200 && n <= 60000) { numPrice = n; break; } }
      }
    }

    if (!numPrice) continue;
    results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur, price: '€' + numPrice, numPrice });
  }

  // Deduplicate
  const seen = new Set();
  return results.filter(r => { const k = r.depTime + '-' + r.numPrice; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Grid search (Step 1) ─────────────────────────────────────────────────
async function getGridPrices(from, to, cabin) {
  const page = await newPage();
  try {
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    await handleConsent(page);

    const cabinOk = await switchCabin(page, cabin);

    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click(); await sleep(300);
    await page.keyboard.press('Control+a');
    for (const ch of from) await page.keyboard.type(ch, { delay: 80 });
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);

    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click(); await sleep(300);
    for (const ch of to) await page.keyboard.type(ch, { delay: 80 });
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);

    await page.keyboard.press('Escape'); await sleep(300);
    try {
      const sb = page.getByRole('button', { name: /^(Search|Explore)$/i }).last();
      await sb.waitFor({ state: 'visible', timeout: 5000 });
      await sb.click();
    } catch { await page.keyboard.press('Enter'); }

    try {
      await page.waitForFunction(
        () => (document.body.innerText.match(/€\d{3,5}/g) || []).length >= 5,
        { timeout: 30000, polling: 1500 }
      );
    } catch(e) { console.log('[FSX] Grid wait timeout:', e.message.slice(0, 40)); }
    await sleep(1000);

    const pageText = await page.evaluate(() => document.body.innerText);
    return { pageText, cabinOk };
  } finally {
    await page.context().close().catch(() => {});
  }
}

const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildFallback(datePrices, stay, cabinOk, cabin, from, to, buyUrl) {
  return datePrices.slice(0, 5).map((dp, idx) => {
    const retDate = new Date(dp.date.getTime() + stay * 86400000);
    return {
      from, to, fromCode: from, toCode: to,
      airline: 'See Google Flights', dur: '', stops: 0, via: '', layoverDur: '',
      price: '€' + dp.price, numPrice: dp.price,
      dep: M[dp.month] + ' ' + dp.day + ' ' + dp.year,
      ret: M[retDate.getMonth()] + ' ' + retDate.getDate() + ' ' + retDate.getFullYear(),
      depDate: dp.iso, retDate: retDate.toISOString().slice(0, 10),
      stayLabel: stay + 'd', cabin: cabinOk ? cabin : 'Economy*',
      real: true, best: idx === 0, buyUrl,
    };
  });
}

// ── Main scrape ───────────────────────────────────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
  // Step 1: Get date grid to find cheapest dates in window
  console.log('[FSX] Step 1: Getting date grid for', from, '->', to);
  const { pageText, cabinOk } = await getGridPrices(from, to, cabin);
  const datePrices = parseDateGrid(pageText, depart, ret);
  console.log('[FSX] Grid prices found:', datePrices.length, '| cabin:', cabinOk ? cabin : 'Economy*');

  if (!datePrices.length) {
    console.log('[FSX] No grid prices found');
    return [];
  }

  // Step 2: For the cheapest date, do a fresh direct search with full dates
  const bestDate = datePrices[0];
  const retIso = new Date(bestDate.date.getTime() + stay * 86400000).toISOString().slice(0, 10);

  console.log('[FSX] Step 2: Direct search for cheapest date', bestDate.iso, '-> ret', retIso);
  const { flights, resultUrl } = await searchAndExtract(from, to, bestDate.iso, retIso, cabin);

  if (flights.length > 0) {
    // Got real flight details — return top 5 by price
    flights.sort((a, b) => a.numPrice - b.numPrice);
    const top = flights.slice(0, 5);
    const depDisp = isoToDisp(bestDate.iso);
    const retDisp = isoToDisp(retIso);
    const stayDays = Math.round((new Date(retIso + 'T12:00:00') - new Date(bestDate.iso + 'T12:00:00')) / 86400000);
    return top.map((f, idx) => ({
      from, to, fromCode: from, toCode: to,
      airline: f.airline || 'See Google Flights',
      dur: f.dur, stops: f.stops, via: f.via, layoverDur: f.layoverDur,
      price: f.price, numPrice: f.numPrice,
      dep: depDisp + (f.depTime ? ' ' + f.depTime : ''),
      ret: retDisp + (f.arrTime ? ' ' + f.arrTime : ''),
      depDate: bestDate.iso, retDate: retIso,
      stayLabel: stayDays + 'd', cabin: cabinOk ? cabin : 'Economy*',
      real: true, best: idx === 0, buyUrl: resultUrl,
    }));
  }

  // Step 3: Fallback — return top 5 grid prices without flight details
  console.log('[FSX] Falling back to grid prices');
  return buildFallback(datePrices, stay, cabinOk, cabin, from, to, resultUrl || '');
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

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '19.0' }));
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

app.listen(PORT, () => console.log('[FSX] Server v19 on port', PORT));
