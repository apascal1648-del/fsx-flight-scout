/**
 * FSX Flight Scout v22
 * Root fix: fill departure date INTO the form before searching.
 * This makes Google open the date grid centered on the target month.
 * Works for any month - near or far.
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

function buildGoogleFlightsUrl(from, to, depIso, retIso, cabin) {
  const e = /business/i.test(cabin) ? 2 : /first/i.test(cabin) ? 3 : 1;
  return `https://www.google.com/travel/flights?hl=en#flt=${from}.${to}.${depIso}*${to}.${from}.${retIso};c:EUR;e:${e};s:0*1;sd:1;t:f`;
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
          datePrices.push({ date, price, day, month: currentMonth, year: currentYear,
            iso: date.toISOString().slice(0, 10) });
        }
        i++;
      }
    }
  }
  datePrices.sort((a, b) => a.price - b.price);
  return datePrices;
}

// Type text into a field char by char with delay
async function typeIntoField(page, locator, text) {
  await locator.click(); await sleep(300);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await sleep(100);
  for (const ch of text) await page.keyboard.type(ch, { delay: 80 });
  await sleep(300);
}

async function scrapeRoute({ from, to, depart, ret, cabin = 'Business', stay = 90 }) {
  const page = await newPage();
  try {
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(2000);
    await handleConsent(page);
    if (page.url().includes('consent')) { await handleConsent(page); await sleep(1000); }

    const cabinOk = await switchCabin(page, cabin);

    // Fill origin
    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await typeIntoField(page, oi, from);
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(800);

    // Fill destination
    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await typeIntoField(page, di, to);
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(800);

    // KEY FIX: fill departure date BEFORE searching
    // This makes Google show the date grid centered on the correct month
    const depD = new Date(depart + 'T12:00:00');
    const depFormatted = (depD.getMonth()+1) + '/' + depD.getDate() + '/' + depD.getFullYear();

    // Try to find and fill departure date field
    let dateFilled = false;
    const dateSelectors = [
      'input[placeholder*="Departure"]',
      'input[aria-label*="Departure date"]',
      'input[aria-label*="departure"]',
      'input[placeholder*="departure"]',
    ];
    for (const sel of dateSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await typeIntoField(page, el, depFormatted);
          await page.keyboard.press('Escape'); await sleep(300);
          dateFilled = true;
          console.log('[FSX] Departure date filled via:', sel, '->', depFormatted);
          break;
        }
      } catch {}
    }

    if (!dateFilled) {
      // Fallback: just type the date after destination — focus may be on date field
      console.log('[FSX] Date field not found by selector, typing after destination');
      await sleep(500);
      await page.keyboard.type(depFormatted, { delay: 80 });
      await page.keyboard.press('Escape'); await sleep(300);
    }

    // Click Search
    try {
      const sb = page.getByRole('button', { name: /^(Search|Explore)$/i }).last();
      await sb.waitFor({ state: 'visible', timeout: 5000 });
      await sb.click();
    } catch { await page.keyboard.press('Enter'); }

    // Wait for date grid with prices
    try {
      await page.waitForFunction(
        () => (document.body.innerText.match(/€\d{3,5}/g) || []).length >= 5,
        { timeout: 30000, polling: 1500 }
      );
    } catch(e) { console.log('[FSX] Grid wait timeout:', e.message.slice(0, 40)); }
    await sleep(1000);

    let pageText = await page.evaluate(() => document.body.innerText);
    let datePrices = parseDateGrid(pageText, depart, ret);
    console.log('[FSX]', from, '->', to, '| grid prices found:', datePrices.length, '| target month:', depart.slice(0,7));

    // If still no prices, try scrolling the date grid forward using JavaScript
    if (datePrices.length === 0) {
      console.log('[FSX] No prices in target range, trying JS calendar navigation');
      const targetMonth = depD.getMonth(); // 0-indexed
      const targetYear = depD.getFullYear();

      // Use JS to find and click forward arrow buttons until we reach the target month
      let navigated = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        // Check if target month is now visible in page text
        const monthNames = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
        const currentText = await page.evaluate(() => document.body.innerText);
        if (currentText.includes(monthNames[targetMonth] + ' ' + targetYear) ||
            currentText.includes(monthNames[targetMonth] + '\n' + targetYear)) {
          console.log('[FSX] Target month now visible after', attempt, 'navigations');
          navigated = true;
          break;
        }

        // Click any "next" arrow button visible on page
        const clicked = await page.evaluate(() => {
          // Try aria-label
          const byLabel = [...document.querySelectorAll('button[aria-label]')]
            .find(b => /next|forward|›|>/i.test(b.getAttribute('aria-label') || ''));
          if (byLabel) { byLabel.click(); return 'aria-label'; }

          // Try by button text content
          const byText = [...document.querySelectorAll('button')]
            .find(b => {
              const t = (b.innerText || '').trim();
              return t === '›' || t === '>' || t === '»' || t === '▶';
            });
          if (byText) { byText.click(); return 'text'; }

          // Try SVG arrow buttons (Google often uses these)
          const svgBtns = [...document.querySelectorAll('button')]
            .filter(b => b.querySelector('svg') && b.getBoundingClientRect().x > window.innerWidth / 2);
          // Take the rightmost button in the calendar area (likely "next")
          const rightmost = svgBtns.sort((a,b) =>
            b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0];
          if (rightmost) { rightmost.click(); return 'svg-rightmost'; }

          return null;
        });

        if (!clicked) { console.log('[FSX] No next button found on attempt', attempt); break; }
        console.log('[FSX] Clicked next via:', clicked);
        await sleep(600);
      }

      if (navigated || true) {
        pageText = await page.evaluate(() => document.body.innerText);
        datePrices = parseDateGrid(pageText, depart, ret);
        console.log('[FSX] After navigation:', datePrices.length, 'prices found');
      }
    }

    if (!datePrices.length) {
      console.log('[FSX] No prices found. Page sample:', 
        (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n/g,'|'));
      return [];
    }

    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return datePrices.slice(0, 5).map((dp, idx) => {
      const retDate = new Date(dp.date.getTime() + stay * 86400000);
      const retIso = retDate.toISOString().slice(0, 10);
      const depStr = M[dp.month] + ' ' + dp.day + ' ' + dp.year;
      const retStr = M[retDate.getMonth()] + ' ' + retDate.getDate() + ' ' + retDate.getFullYear();
      const buyUrl = buildGoogleFlightsUrl(from, to, dp.iso, retIso, cabinOk ? cabin : 'Economy');
      return {
        from, to, fromCode: from, toCode: to,
        airline: '', dur: '', stops: 0, via: '', layoverDur: '',
        price: '€' + dp.price, numPrice: dp.price,
        dep: depStr, ret: retStr,
        depDate: dp.iso, retDate: retIso,
        stayLabel: stay + 'd',
        cabin: cabinOk ? cabin : 'Economy*',
        real: true, best: idx === 0, buyUrl,
      };
    });

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

app.get('/health', (req, res) => res.json({ status: 'FSX scraper online', version: '22.0' }));
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

app.listen(PORT, () => console.log('[FSX] Server v22 on port', PORT));
