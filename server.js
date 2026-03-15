/**
 * FSX Flight Scout v18
 * Grid parsing works (v17b proved it).
 * This version fixes the results page parser:
 * - Much more flexible time pattern matching
 * - Logs the full results page text to Railway so we can see the exact format
 * - Always falls back to grid prices if parsing fails
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

async function clickCheapestDate(page, datePrices) {
  if (!datePrices.length) return null;
  const best = datePrices[0];
  console.log('[FSX] Clicking cheapest date:', best.iso, '€' + best.price);
  try {
    const clicked = await page.evaluate(({ targetIso, targetPrice }) => {
      const byIso = document.querySelector('[data-iso="' + targetIso + '"]');
      if (byIso) { byIso.click(); return { method: 'data-iso' }; }
      const allEls = [...document.querySelectorAll('*')];
      for (const el of allEls) {
        const t = (el.innerText || '').trim();
        if (t === '€' + targetPrice && el.children.length <= 2) {
          el.click(); return { method: 'price-text' };
        }
      }
      for (const el of allEls) {
        if ((el.innerText || '').includes('€' + targetPrice) && el.tagName === 'TD') {
          el.click(); return { method: 'TD' };
        }
      }
      return null;
    }, { targetIso: best.iso, targetPrice: best.price });

    if (clicked) {
      console.log('[FSX] Date clicked via:', clicked.method);
      await sleep(1500);

      // After selecting a date on the grid, we need to click Search to get flight results
      // The date click just selects the date — Search button triggers the actual lookup
      let searchClicked = false;
      try {
        // Try the Done/Search button that appears after date selection
        const doneBtn = page.locator('button').filter({ hasText: /^(Done|Search|Apply)$/i }).first();
        if (await doneBtn.isVisible({ timeout: 3000 })) {
          await doneBtn.click();
          console.log('[FSX] Clicked Done/Search after date selection');
          searchClicked = true;
        }
      } catch {}

      if (!searchClicked) {
        // Try the main Search button
        try {
          const sb = page.getByRole('button', { name: /^Search$/i }).last();
          if (await sb.isVisible({ timeout: 3000 })) {
            await sb.click();
            console.log('[FSX] Clicked main Search button');
            searchClicked = true;
          }
        } catch {}
      }

      if (!searchClicked) {
        // Press Enter as last resort
        await page.keyboard.press('Enter');
        console.log('[FSX] Pressed Enter to search');
      }

      // Wait for flight results to load
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(3000);
      return best;
    }
  } catch(e) { console.log('[FSX] clickCheapestDate error:', e.message.slice(0, 80)); }
  return null;
}

/**
 * Extract flights using DOM queries.
 * After clicking a date on the grid, Google shows results inline.
 * We look for any element containing time + price + duration patterns.
 */
async function extractFlightsFromDOM(page) {
  const flights = await page.evaluate(() => {
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

    // Find all elements that contain time + price — these are flight cards
    const allEls = [...document.querySelectorAll('*')];
    const cards = allEls.filter(el => {
      if (el.children.length > 25) return false; // too big = container
      if (el.children.length < 1) return false;  // too small = leaf
      const txt = el.innerText || '';
      if (txt.length < 40 || txt.length > 2000) return false;
      // Must have time AND price AND (duration OR nonstop)
      return /\d{1,2}:\d{2}/.test(txt)
          && /€[\s]?[\d,]+/.test(txt)
          && (/\d+\s*hr/i.test(txt) || /nonstop/i.test(txt));
    });

    // Sort by text length ascending — prefer smaller/more specific elements
    cards.sort((a, b) => (a.innerText||'').length - (b.innerText||'').length);

    // Deduplicate
    const seen = new Set();
    const unique = cards.filter(el => {
      // Use first 80 chars as key
      const key = (el.innerText || '').replace(/\s+/g,' ').slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.slice(0, 10).forEach(card => {
      try {
        const txt = (card.innerText || '').replace(/\u00a0/g, ' '); // normalize non-breaking spaces
        if (!txt) return;

        // Price
        const priceM = txt.match(/€\s*([\d,]+)/);
        if (!priceM) return;
        const numPrice = parseInt(priceM[1].replace(/,/g, ''));
        if (numPrice < 200 || numPrice > 60000) return;

        // Times — grab ALL time occurrences
        const allTimes = [...txt.matchAll(/(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?/gi)]
          .map(m => m[1].trim() + (m[2] || ''));
        const depTime = allTimes[0] || '';
        const arrTime = allTimes[1] || '';

        // Duration
        const durM = txt.match(/(\d+)\s*hr(?:s?)(?:[^\d]|$)(?:(\d+)\s*min)?/i);
        const dur = durM ? durM[1] + 'h ' + (durM[2] || '0') + 'm' : ((/nonstop/i.test(txt)) ? 'direct' : '');

        // Stops
        let stops = 0, via = '';
        if (/nonstop/i.test(txt)) stops = 0;
        else if (/1\s*stop/i.test(txt)) {
          stops = 1;
          const viaM = txt.match(/·\s*([A-Z]{3})\s*·/) || txt.match(/\b([A-Z]{3})\b.*?layover/s);
          if (viaM) via = viaM[1];
        } else {
          const sM = txt.match(/(\d+)\s*stops?/i);
          if (sM) stops = parseInt(sM[1]);
        }

        // Layover duration
        const layM = txt.match(/(\d+)\s*hr(?:s?)(?:\s+(\d+)\s*min)?\s+layover/i);
        const layoverDur = layM ? layM[1] + 'h ' + (layM[2] || '0') + 'm' : '';

        // Airline — search known list first
        let airline = '';
        for (const a of knownAirlines) {
          if (txt.toLowerCase().includes(a.toLowerCase())) { airline = a; break; }
        }

        if (!depTime) return;

        results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur,
          price: '€' + numPrice, numPrice });

      } catch(e) {}
    });

    return results;
  });

  // Deduplicate by depTime + price
  const seen = new Set();
  const unique = flights.filter(f => {
    const k = f.depTime + '-' + f.numPrice;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log('[FSX] DOM extraction found', unique.length, 'unique flights from', flights.length, 'candidates');
  return unique;
}

const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function gridFallback(datePrices, stay, cabinOk, cabin, from, to, resultUrl) {
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
      real: true, best: idx === 0, buyUrl: resultUrl,
    };
  });
}

async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
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

    const gridUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText);
    const datePrices = parseDateGrid(pageText, depart, ret);
    console.log('[FSX]', from, '->', to, '| grid prices:', datePrices.length, '| cabin:', cabinOk ? cabin : 'Economy*');

    if (!datePrices.length) {
      console.log('[FSX] No grid prices. Page snippet:', pageText.slice(0, 300).replace(/\n/g, '|'));
      return [];
    }

    const bestDate = await clickCheapestDate(page, datePrices);
    const resultUrl = page.url();
    console.log('[FSX] After click — URL changed:', resultUrl !== gridUrl, '| bestDate:', bestDate ? bestDate.iso : 'null');

    if (!bestDate) {
      console.log('[FSX] Click failed, returning grid fallback');
      return gridFallback(datePrices, stay, cabinOk, cabin, from, to, gridUrl);
    }

    // After clicking a date, Google shows results INLINE on the same page.
    // Wait for flight time patterns to appear (departure times like "10:30 AM")
    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          // Just look for multiple time patterns — enough to know flights are showing
          const times = (t.match(/\d{1,2}:\d{2}/g) || []);
          return times.length >= 6; // at least 3 flights × dep+arr times
        },
        { timeout: 20000, polling: 1000 }
      );
      console.log('[FSX] Flight times detected on page');
    } catch(e) {
      console.log('[FSX] waitForFunction timeout:', e.message.slice(0, 50));
    }

    // Give page time to fully render
    await sleep(3000);
    await page.evaluate(() => window.scrollBy(0, 400));
    await sleep(1000);

    const resultsText = await page.evaluate(() => document.body.innerText);
    // LOG THE FULL RESULTS PAGE TEXT for debugging
    console.log('[FSX] === RESULTS PAGE TEXT START ===');
    console.log(resultsText.slice(0, 3000));
    console.log('[FSX] === RESULTS PAGE TEXT END ===');

    // DOM-based extraction
    let flights = await extractFlightsFromDOM(page);
    console.log('[FSX] Flights extracted:', flights.length);

    if (flights.length > 0) {
      flights.sort((a, b) => a.numPrice - b.numPrice);
      const top = flights.slice(0, 5);
      const retDate = new Date(bestDate.date.getTime() + stay * 86400000);
      const retIso = retDate.toISOString().slice(0, 10);
      return top.map((f, idx) => ({
        from, to, fromCode: from, toCode: to,
        airline: f.airline || 'See Google Flights',
        dur: f.dur, stops: f.stops, via: f.via, layoverDur: f.layoverDur,
        price: f.price, numPrice: f.numPrice,
        dep: isoToDisp(bestDate.iso) + (f.depTime ? ' ' + f.depTime : ''),
        ret: isoToDisp(retIso) + (f.arrTime ? ' ' + f.arrTime : ''),
        depDate: bestDate.iso, retDate: retIso,
        stayLabel: stay + 'd', cabin: cabinOk ? cabin : 'Economy*',
        real: true, best: idx === 0, buyUrl: resultUrl,
      }));
    }

    // Fallback: grid prices
    console.log('[FSX] Results parsing failed, falling back to grid prices');
    return gridFallback(datePrices, stay, cabinOk, cabin, from, to, resultUrl);

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

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '18.0' }));
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

app.listen(PORT, () => console.log('[FSX] Server v18 on port', PORT));
