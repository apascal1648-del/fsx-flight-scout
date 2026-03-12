/**
 * FSX · Flight Scout — Scraper Server v4
 * Added /debug endpoint + better stealth + longer waits
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

let browser = null, launching = false;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) {
    for (let i = 0; i < 30; i++) { await sleep(500); if (browser?.isConnected()) return browser; }
  }
  launching = true;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  launching = false;
  return browser;
}

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
}
function stayDays(dep, ret) {
  return Math.round((new Date(ret+'T12:00:00') - new Date(dep+'T12:00:00')) / 86400000) + 'd';
}
function cabinCode(c) { return /economy/i.test(c) ? 1 : /first/i.test(c) ? 3 : 2; }

async function newStealthPage() {
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
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    const orig = window.navigator.permissions.query;
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : orig(p);
  });
  return ctx.newPage();
}

// ── DEBUG endpoint: returns HTML of what the browser sees on Google Flights ──
app.get('/debug', async (req, res) => {
  const page = await newStealthPage();
  try {
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(4000);
    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    res.json({ url: page.url(), textSnippet: text, htmlLength: html.length });
  } catch(e) {
    res.json({ error: e.message });
  } finally { await page.context().close().catch(()=>{}); }
});

// ── SCRAPE single route ──────────────────────────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business' }) {
  const page = await newStealthPage();
  try {
    // Build direct URL with query params (new format)
    const cc = cabinCode(cabin);
    // Try the direct results URL format
    const url = 'https://www.google.com/travel/flights/search?hl=en&curr=EUR&tfs=CBwQAhoeEgoyMDI3LTAyLTAxagcIARIDWlJIcgcIARIDU0lOGh4SCjIwMjctMDYtMDFqBwgBEgNTSU5yBwgBEgNaUkgYAiIECAEQAg==';
    
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(3000);

    // Accept cookies
    for (const txt of ['Accept all','Reject all','I agree','Tout accepter']) {
      try {
        const btn = page.getByRole('button', { name: txt, exact: true });
        if (await btn.isVisible({ timeout: 800 })) { await btn.click(); await sleep(1500); break; }
      } catch {}
    }

    // Switch to Business if needed
    if (!/economy/i.test(cabin)) {
      try {
        const cabBtn = page.locator('[data-value="1"], button:has-text("Economy")').first();
        if (await cabBtn.isVisible({ timeout: 2000 })) {
          await cabBtn.click(); await sleep(500);
          const opt = page.locator('[role="option"], li').filter({ hasText: cabin }).first();
          if (await opt.isVisible({ timeout: 1500 })) { await opt.click(); await sleep(500); }
        }
      } catch {}
    }

    // Fill origin with human-like delay
    await page.mouse.move(300 + Math.random()*50, 300 + Math.random()*30);
    await sleep(300);
    const originInput = page.locator('input[placeholder*="Where from"], input[aria-label*="Where from"]').first();
    await originInput.click({ delay: 50 });
    await sleep(500);
    await page.keyboard.press('Control+a');
    await sleep(100);
    for (const ch of from) { await page.keyboard.type(ch, { delay: 80 + Math.random()*60 }); }
    await sleep(2000);
    // Wait for dropdown and pick first option
    await page.keyboard.press('ArrowDown');
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(1000);

    // Fill destination
    const destInput = page.locator('input[placeholder*="Where to"], input[aria-label*="Where to"]').first();
    await destInput.click({ delay: 50 });
    await sleep(500);
    for (const ch of to) { await page.keyboard.type(ch, { delay: 80 + Math.random()*60 }); }
    await sleep(2000);
    await page.keyboard.press('ArrowDown');
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(1000);

    // Fill depart date
    try {
      const depInput = page.locator('[aria-label="Departure"], input[placeholder="Departure"]').first();
      if (await depInput.isVisible({ timeout: 2000 })) {
        await depInput.click({ delay: 50 }); await sleep(400);
        await page.keyboard.press('Control+a');
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const d = new Date(depart+'T12:00:00');
        await page.keyboard.type(M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear(), { delay: 50 });
        await sleep(800); await page.keyboard.press('Tab'); await sleep(400);
      }
    } catch {}

    // Fill return date
    try {
      const retInput = page.locator('[aria-label="Return"], input[placeholder="Return"]').first();
      if (await retInput.isVisible({ timeout: 2000 })) {
        await retInput.click({ delay: 50 }); await sleep(400);
        await page.keyboard.press('Control+a');
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const d = new Date(ret+'T12:00:00');
        await page.keyboard.type(M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear(), { delay: 50 });
        await sleep(800);
      }
    } catch {}

    // Done button
    try {
      const done = page.getByRole('button', { name: 'Done' }).last();
      if (await done.isVisible({ timeout: 2000 })) { await done.click(); await sleep(600); }
    } catch {}

    // Search
    try {
      const sb = page.getByRole('button', { name: /^(Search|Explore)$/i }).last();
      await sb.waitFor({ state: 'visible', timeout: 5000 });
      await sb.click({ delay: 80 });
    } catch { await page.keyboard.press('Enter'); }

    await page.waitForLoadState('networkidle', { timeout: 35000 }).catch(() => {});
    await sleep(5000);

    const resultUrl = page.url();
    console.log('[FSX] ' + from + '->' + to + ' @ ' + resultUrl.slice(0,80));

    const flights = await page.evaluate(() => {
      const results = [];
      const selectors = ['[role="listitem"]','li[data-id]','li[jsname]','.pIav2d','.Rk10dc'];
      let cards = [];
      for (const sel of selectors) {
        const found = [...document.querySelectorAll(sel)].filter(el => {
          const t = el.innerText || '';
          return (t.match(/\d{1,2}:\d{2}/g)||[]).length >= 2 &&
                 /EUR|€|\$/.test(t) && t.length > 50 && t.length < 1500;
        });
        if (found.length > 0) { cards = found.slice(0,12); break; }
      }
      if (cards.length === 0) {
        cards = [...document.querySelectorAll('div,li')].filter(el => {
          const t = el.innerText || '';
          return (t.match(/\d{1,2}:\d{2}/g)||[]).length >= 2 &&
                 /EUR\s*[\d,]+|[\d,]+\s*EUR|€/.test(t) &&
                 t.length > 50 && t.length < 800;
        }).slice(0,12);
      }
      cards.forEach(card => {
        try {
          const txt = (card.innerText||'').trim();
          if (txt.length < 40) return;
          const lines = txt.split('\n').map(l=>l.trim()).filter(Boolean);
          const pm = txt.match(/EUR\s*([\d,]+)/) || txt.match(/([\d,]+)\s*EUR/) || txt.match(/€\s*([\d,]+)/);
          if (!pm) return;
          const priceNum = parseInt(pm[1].replace(/,/g,''));
          if (priceNum < 100 || priceNum > 60000) return;
          const times = [...txt.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m=>m[1]);
          const dm = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?/)||txt.match(/(\d+)h\s*(\d+)?m?/);
          const dur = dm ? dm[1]+'h'+(dm[2]?dm[2]+'m':'') : '';
          let stops=0, via='';
          if (/nonstop|direct/i.test(txt)) stops=0;
          else if (/1 stop/i.test(txt)) { stops=1; const vm=txt.match(/1 stop\s*\(([^)]+)\)/i); if(vm) via=vm[1]; }
          else if (/(\d) stop/i.test(txt)) stops=parseInt(txt.match(/(\d) stop/i)[1]);
          const airline = lines.find(l=>l.length>=2&&l.length<=45&&!/^\d|EUR|€|stop|nonstop|hr |min|AM|PM|\d:\d|\+\d/.test(l))||'Unknown';
          results.push({airline,depTime:times[0]||'',arrTime:times[1]||'',dur,stops,via,priceNum,price:'EUR '+pm[1]});
        } catch {}
      });
      return results;
    });

    console.log('[FSX] found ' + flights.length + ' flights');
    return flights.map(f => ({
      from, to, fromCode:from, toCode:to,
      airline:f.airline, dur:f.dur, stops:f.stops, via:f.via,
      price:f.price, numPrice:f.priceNum,
      dep: fmtDate(depart)+(f.depTime?' '+f.depTime:''),
      ret: fmtDate(ret)+(f.arrTime?' '+f.arrTime:''),
      depDate:depart, retDate:ret, stayLabel:stayDays(depart,ret),
      cabin, real:true, buyUrl:resultUrl,
    }));
  } finally { await page.context().close().catch(()=>{}); }
}

const EU_HUBS = [
  {code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},
  {code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},
  {code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'},
];
const AS_AIRPORTS = [
  {code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},
  {code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},
  {code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},
  {code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'},
];

app.get('/health', (req,res) => res.json({status:'FSX scraper online',version:'4.0'}));
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'FSX-standalone.html')));

app.get('/scrape', async (req,res) => {
  const {from,to,depart,ret,cabin='Business'} = req.query;
  if (!from||!to||!depart||!ret) return res.status(400).json({error:'from,to,depart,ret required'});
  try {
    const results = await scrapeRoute({from,to,depart,ret,cabin});
    res.json({ok:true,results});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

app.get('/scan', async (req,res) => {
  const {fromCode,toCode,depart,ret,cabin='Business'} = req.query;
  if (!depart||!ret) return res.status(400).json({error:'depart and ret required'});
  const origins = (!fromCode||fromCode==='ALL') ? EU_HUBS : EU_HUBS.filter(h=>fromCode.split(',').includes(h.code));
  const dests   = (!toCode||toCode==='ALL') ? AS_AIRPORTS : AS_AIRPORTS.filter(a=>toCode.split(',').includes(a.code));
  const all = [];
  for (const org of origins) {
    for (const dst of dests) {
      try {
        const results = await scrapeRoute({from:org.code,to:dst.code,depart,ret,cabin});
        results.forEach(r=>{r.from=org.name;r.to=dst.name;});
        all.push(...results);
        await sleep(2000);
      } catch(e) { console.error('[FSX] failed',org.code,'->',dst.code,e.message.slice(0,60)); }
    }
  }
  all.sort((a,b)=>a.numPrice-b.numPrice);
  const seen={};
  all.forEach(r=>{const k=r.fromCode+'-'+r.toCode;if(!seen[k]){r.best=true;seen[k]=true;}});
  res.json({ok:true,count:all.length,results:all.slice(0,30)});
});

app.listen(PORT, () => console.log('[FSX] Server v4 on port', PORT));
