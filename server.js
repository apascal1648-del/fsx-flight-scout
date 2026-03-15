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
      console.log('[FSX] Clicked via:', clicked.method);
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(3000);
      return best;
    }
  } catch(e) { console.log('[FSX] clickCheapestDate error:', e.message.slice(0, 50)); }
  return null;
}

/**
 * Parse flight results from page text.
 * Logs the raw text to Railway so we can debug the format.
 * Uses a very flexible approach — scan for any two time-like tokens separated by a dash/arrow.
 */
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

  // Time pattern: "10:15 AM", "10:15", "10:15 PM"
  const timeRe = /\d{1,2}:\d{2}(?:\s*[AP]M)?/i;

  for (let i = 0; i < lines.length - 3; i++) {
    const line = lines[i];

    // Strategy 1: "10:15 AM – 7:30 AM+1" on one line
    const oneLine = line.match(
      /^(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*[–\-—]\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?$/i
    );

    // Strategy 2: a line that is just a time "10:15 AM" followed by another time nearby
    const justTime = line.match(/^(\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i);

    let depTime = '', arrTime = '';

    if (oneLine) {
      depTime = oneLine[1].trim();
      arrTime = oneLine[2].trim() + (oneLine[3] || '');
    } else if (justTime) {
      // Look at next few lines for another time
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const next = lines[k];
        const nextTime = next.match(/^(\d{1,2}:\d{2}(?:\s*[AP]M)?)(\+\d)?$/i);
        if (nextTime) {
          depTime = justTime[1].trim();
          arrTime = nextTime[1].trim() + (nextTime[2] || '');
          break;
        }
      }
    }

    if (!depTime) continue;

    // Search backwards up to 6 lines for airline
    let airline = '';
    for (let j = Math.max(0, i - 6); j < i; j++) {
      const l = lines[j];
      const known = knownAirlines.find(a => l.toLowerCase() === a.toLowerCase());
      if (known) { airline = known; break; }
      const partial = knownAirlines.find(a => l.toLowerCase().includes(a.toLowerCase()));
      if (partial && !airline) airline = partial;
    }
    if (!airline) {
      for (let j = Math.max(0, i - 4); j < i; j++) {
        const l = lines[j];
        if (
          l.length >= 3 && l.length <= 60 && /[A-Za-z]{3}/.test(l) &&
          !/^\d|€|\$|nonstop|direct|stop|hr|min|:\d{2}|\+\d|Economy|Business|First|Select|Book|More|Carbon|Wi-Fi|USB|Flight|Depart/i.test(l) &&
          !/\b(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)\b/.test(l)
        ) airline = l;
      }
    }

    // Search forward up to 15 lines for duration, stops, price
    let dur = '', stops = 0, via = '', layoverDur = '', numPrice = 0;
    for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
      const l = lines[j];

      // Duration variants: "13 hr 25 min", "13 hr", "13h 25m"
      if (!dur) {
        const dm = l.match(/^(\d+)\s*hr(?:s?\.?)(?:\s+(\d+)\s*min)?$/i)
                || l.match(/^(\d+)h(?:\s*(\d+)m)?$/i);
        if (dm) { dur = dm[1] + 'h ' + (dm[2] || '0') + 'm'; continue; }
      }

      if (/^nonstop$/i.test(l)) { stops = 0; continue; }
      if (/^1 stop$/i.test(l)) { stops = 1; continue; }
      const sm = l.match(/^(\d+) stops?$/i); if (sm) { stops = parseInt(sm[1]); continue; }

      if (!via) {
        const vm = l.match(/(?:stop|layover)[^A-Z]*([A-Z]{3})\b/);
        if (vm) via = vm[1];
        // Also try "· DXB ·" format
        const vm2 = l.match(/·\s*([A-Z]{3})\s*·/);
        if (vm2) via = vm2[1];
      }

      if (!layoverDur) {
        const lm = l.match(/(\d+)\s*hr(?:s?\.?)(?:\s+(\d+)\s*min)?\s+layover/i);
        if (lm) layoverDur = lm[1] + 'h ' + (lm[2] || '0') + 'm';
      }

      if (!numPrice) {
        const pm = l.match(/^€\s*([\d,]+)$/) || l.match(/^([\d,]+)\s*€$/);
        if (pm) {
          const n = parseInt(pm[1].replace(/,/g, ''));
          if (n >= 200 && n <= 60000) { numPrice = n; break; }
        }
      }
    }

    if (!numPrice) continue;

    results.push({ airline, depTime, arrTime, dur, stops, via, layoverDur, price: '€' + numPrice, numPrice });
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

    if (!bestDate || resultUrl === gridUrl) {
      console.log('[FSX] Could not navigate to results, returning grid fallback');
      return gridFallback(datePrices, stay, cabinOk, cabin, from, to, gridUrl);
    }

    // Wait a bit more for results to load fully
    await sleep(2000);
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1500);

    const resultsText = await page.evaluate(() => document.body.innerText);

    // LOG THE FULL RESULTS PAGE TEXT for debugging
    console.log('[FSX] === RESULTS PAGE TEXT START ===');
    console.log(resultsText.slice(0, 3000));
    console.log('[FSX] === RESULTS PAGE TEXT END ===');

    let flights = parseFlightResultsFromText(resultsText);
    console.log('[FSX] Flights parsed from results page:', flights.length);

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
