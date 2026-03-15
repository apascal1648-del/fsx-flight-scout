/**
 * FSX Flight Scout v15
 * Complete rewrite of flight extraction:
 * - Navigates directly to Google Flights results page with specific dates
 * - Extracts EACH flight card with its own: airline, dep time, arr time, duration, stops, price
 * - Returns top 5 real flights with full details per result
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

// Format ISO date for display: "2026-05-01" → "May 1 2026"
function isoToDisp(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
}

// Add N days to ISO date string
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Extract flight cards from Google Flights results page.
 * Each card = one real flight with airline, dep time, arr time, duration, stops, price.
 */
async function extractFlights(page) {
  await sleep(3000); // let results load
  
  const flights = await page.evaluate(() => {
    const results = [];
    
    // Google Flights flight result items — try multiple selector strategies
    const candidates = [
      ...document.querySelectorAll('[role="listitem"]'),
      ...document.querySelectorAll('[data-ved]'),
    ].filter(el => {
      const txt = el.innerText || '';
      // Must have a time pattern AND a price AND duration
      return /\d{1,2}:\d{2}/.test(txt) && /€\s*[\d,]+/.test(txt) && /\d+\s*hr/.test(txt);
    });

    // Deduplicate by innerText length
    const seen = new Set();
    const cards = candidates.filter(el => {
      const key = (el.innerText || '').slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    cards.slice(0, 10).forEach(card => {
      try {
        const txt = card.innerText || '';
        const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

        // --- Price ---
        const priceMatch = txt.match(/€\s*([\d,]+)/);
        if (!priceMatch) return;
        const numPrice = parseInt(priceMatch[1].replace(/,/g, ''));
        if (numPrice < 200 || numPrice > 60000) return;
        const price = '€' + numPrice;

        // --- Times: dep and arr ---
        // Format: "10:30 AM" or "10:30" — grab first two occurrences
        const timeMatches = [...txt.matchAll(/\b(\d{1,2}:\d{2}(?:\s*[AP]M)?)/gi)].map(m => m[1]);
        const depTime = timeMatches[0] || '';
        const arrTime = timeMatches[1] || '';

        // --- Duration: "13 hr 25 min" or "13h 25m" ---
        const durMatch = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?/i) || txt.match(/(\d+)h\s*(\d+)?m/i);
        const dur = durMatch
          ? (durMatch[1] + 'h ' + (durMatch[2] || '0') + 'm')
          : '';

        // --- Stops ---
        let stops = 0, via = '';
        if (/nonstop|direct/i.test(txt)) {
          stops = 0;
        } else if (/1 stop/i.test(txt)) {
          stops = 1;
          const viaMatch = txt.match(/1 stop\s*\(([^)]+)\)/i)
            || txt.match(/\b([A-Z]{3})\b.*layover/i);
          if (viaMatch) via = viaMatch[1];
        } else {
          const stopsMatch = txt.match(/(\d+)\s+stops?/i);
          if (stopsMatch) stops = parseInt(stopsMatch[1]);
        }

        // --- Layover duration ---
        const layoverMatch = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?\s*layover/i);
        const layoverDur = layoverMatch
          ? (layoverMatch[1] + 'h ' + (layoverMatch[2] || '0') + 'm')
          : '';

        // --- Airline: find a line that looks like an airline name ---
        // Skip lines with digits, prices, times, keywords
        const skipPattern = /^\d|€|\$|%|nonstop|direct|stop|hr|min|\d:\d|\+\d|Operated|Separate|Carbon|emissions|Select|Book|View|More|Legroom|Average|Wi-Fi|In-seat|USB|Stream|Below|Above|Typical/i;
        const airportCodes = /\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/;
        
        const airline = lines.find(l =>
          l.length >= 4 &&
          l.length <= 60 &&
          /[A-Za-z]{3}/.test(l) &&
          !skipPattern.test(l) &&
          !airportCodes.test(l) &&
          !/^\d+$/.test(l)
        ) || '';

        if (!depTime && !dur) return; // skip if we got nothing useful

        results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur, price, numPrice });
      } catch {}
    });

    return results;
  });

  console.log('[FSX] Extracted', flights.length, 'flights from page');
  return flights;
}

/**
 * Main scrape function — goes directly to Google Flights results for a specific date,
 * extracts all visible flight cards with full details.
 */
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
  const page = await newPage();
  try {
    // Navigate to Google Flights with specific dates already filled
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    await handleConsent(page);

    // Switch cabin first
    const cabinOk = await switchCabin(page, cabin);

    // Fill origin
    const originInput = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await originInput.click(); await sleep(300);
    await page.keyboard.press('Control+a');
    for (const ch of from) await page.keyboard.type(ch, { delay: 80 });
    await sleep(2000);
    await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(800);

    // Fill destination
    const destInput = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await destInput.click(); await sleep(300);
    for (const ch of to) await page.keyboard.type(ch, { delay: 80 });
    await sleep(2000);
    await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(800);

    // Fill departure date
    try {
      // Click departure date field
      const dateFields = page.locator('input[placeholder*="Departure"],input[aria-label*="Departure date"]');
      const dateField = dateFields.first();
      if (await dateField.isVisible({ timeout: 3000 })) {
        await dateField.click(); await sleep(500);
        await page.keyboard.press('Control+a');
        // Format: MM/DD/YYYY
        const d = new Date(depart + 'T12:00:00');
        const depStr = (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();
        await page.keyboard.type(depStr, { delay: 80 });
        await page.keyboard.press('Enter'); await sleep(500);
      }
    } catch(e) { console.log('[FSX] Date fill error:', e.message.slice(0,50)); }

    // Fill return date
    try {
      const retFields = page.locator('input[placeholder*="Return"],input[aria-label*="Return date"]');
      const retField = retFields.first();
      if (await retField.isVisible({ timeout: 3000 })) {
        await retField.click(); await sleep(500);
        await page.keyboard.press('Control+a');
        const r = new Date(ret + 'T12:00:00');
        const retStr = (r.getMonth()+1) + '/' + r.getDate() + '/' + r.getFullYear();
        await page.keyboard.type(retStr, { delay: 80 });
        await page.keyboard.press('Enter'); await sleep(500);
      }
    } catch(e) { console.log('[FSX] Return date fill error:', e.message.slice(0,50)); }

    // Click search
    await page.keyboard.press('Escape'); await sleep(300);
    try {
      const searchBtn = page.getByRole('button', { name: /^Search$/i }).last();
      await searchBtn.waitFor({ state: 'visible', timeout: 5000 });
      await searchBtn.click();
    } catch {
      await page.keyboard.press('Enter');
    }

    // Wait for flight results (prices in list format, not date grid)
    try {
      await page.waitForFunction(
        () => (document.body.innerText.match(/€\s*[\d,]+/g) || []).length >= 3
           && /\d{1,2}:\d{2}/.test(document.body.innerText)
           && /\d+\s*hr/.test(document.body.innerText),
        { timeout: 35000, polling: 1500 }
      );
    } catch(e) { console.log('[FSX] waitForFunction timeout:', e.message.slice(0,40)); }

    await sleep(2000);
    const resultUrl = page.url();

    // Extract all flight cards
    let flights = await extractFlights(page);

    // If we got nothing, try scrolling to trigger lazy load and retry
    if (flights.length === 0) {
      await page.evaluate(() => window.scrollBy(0, 400));
      await sleep(2000);
      flights = await extractFlights(page);
    }

    console.log('[FSX]', from, '->', to, '|', depart, '| flights found:', flights.length, '| cabin:', cabinOk ? cabin : 'Economy*');

    if (flights.length === 0) {
      console.log('[FSX] No flights extracted, returning empty');
      return [];
    }

    // Sort by price, take top 5
    flights.sort((a, b) => a.numPrice - b.numPrice);
    const top = flights.slice(0, 5);

    // Use the ret param directly (already the correct return date from frontend)
    const retIso = ret;
    const depDisp = isoToDisp(depart);
    const retDisp = isoToDisp(retIso);
    const stayDays = Math.round((new Date(retIso+'T12:00:00') - new Date(depart+'T12:00:00')) / 86400000);

    return top.map((f, idx) => ({
      from, to, fromCode: from, toCode: to,
      airline:     f.airline || 'See Google Flights',
      dur:         f.dur,
      stops:       f.stops,
      via:         f.via,
      layoverDur:  f.layoverDur,
      price:       f.price,
      numPrice:    f.numPrice,
      dep:         depDisp + (f.depTime ? ' ' + f.depTime : ''),
      ret:         retDisp + (f.arrTime ? ' ' + f.arrTime : ''),
      depDate:     depart,
      retDate:     retIso,
      stayLabel:   stayDays + 'd',
      cabin:       cabinOk ? cabin : 'Economy*',
      real:        true,
      best:        idx === 0,
      buyUrl:      resultUrl,
    }));

  } finally {
    await page.context().close().catch(() => {});
  }
}

// ── Routes ────────────────────────────────────────────────────────────────
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

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '15.0' }));
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

app.listen(PORT, () => console.log('[FSX] Server v15 on port', PORT));
