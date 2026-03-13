/**
 * FSX · Flight Scout — Scraper Server v5
 * Intercepts Google Flights internal JSON API responses instead of DOM parsing
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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled','--window-size=1366,768'],
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

async function newPage() {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Europe/Zurich',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    geolocation: { latitude: 47.37, longitude: 8.54 },  // Zurich
    permissions: ['geolocation'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });
  return ctx.newPage();
}

// ── Parse flights from Google's internal JSON response ──────────────────
function parseGoogleFlightsJson(raw) {
  const results = [];
  try {
    // Google wraps with )]}' prefix
    const clean = raw.replace(/^[^[{]*/, '');
    const data = JSON.parse(clean);
    // Recursively find arrays that look like flight data
    function hunt(obj, depth) {
      if (depth > 15 || !obj) return;
      if (Array.isArray(obj)) {
        obj.forEach(item => hunt(item, depth + 1));
      } else if (typeof obj === 'object') {
        // Look for objects with price + airline-like structure
        const str = JSON.stringify(obj);
        if (str.length > 200 && str.length < 5000) {
          // Check for flight characteristics: price numbers, airport codes, times
          const hasPrice = /[0-9]{3,5}/.test(str);
          const hasAirport = /[A-Z]{3}/.test(str);
          if (hasPrice && hasAirport) {
            // Try to extract price
            const priceMatch = str.match(/"([0-9]{3,5})"/);
            if (priceMatch) {
              results.push({ raw: str.slice(0, 200) });
            }
          }
        }
        Object.values(obj).forEach(v => hunt(v, depth + 1));
      }
    }
    hunt(data, 0);
  } catch(e) {}
  return results;
}

// ── Core scraper with response interception ──────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin = 'Business' }) {
  const page = await newPage();
  const capturedFlights = [];
  const apiResponses = [];

  // Intercept all responses from Google Flights APIs
  page.on('response', async (response) => {
    const url = response.url();
    // Google Flights data comes from these endpoints
    if ((url.includes('travel/flights') || url.includes('GetShoppingResults') ||
         url.includes('FlightSearch') || url.includes('batchexecute') ||
         url.includes('_/FlightsFrontendUi')) && 
        response.status() === 200) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text')) {
          const text = await response.text();
          if (text.length > 500) {
            apiResponses.push({ url: url.slice(0, 100), len: text.length, snippet: text.slice(0, 300) });
            // Try to extract flight data
            const flights = extractFlightsFromResponse(text, from, to, depart, ret, cabin);
            capturedFlights.push(...flights);
          }
        }
      } catch(e) {}
    }
  });

  try {
    const cc = cabinCode(cabin);
    // Load with geolocation set to Zurich to get EUR prices
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR&gl=CH', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2000);

    // Accept cookies
    for (const txt of ['Accept all','Reject all','I agree','Tout accepter','Alle akzeptieren']) {
      try {
        const btn = page.getByRole('button', { name: txt, exact: true });
        if (await btn.isVisible({ timeout: 800 })) { await btn.click(); await sleep(1500); break; }
      } catch {}
    }

    // Fill origin
    const originInput = page.locator('input[placeholder*="Where from"], input[aria-label*="Where from"]').first();
    await originInput.click({ delay: 50 }); await sleep(400);
    await page.keyboard.press('Control+a');
    for (const ch of from) await page.keyboard.type(ch, { delay: 80 + Math.random()*40 });
    await sleep(2000);
    await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(1000);

    // Fill destination
    const destInput = page.locator('input[placeholder*="Where to"], input[aria-label*="Where to"]').first();
    await destInput.click({ delay: 50 }); await sleep(400);
    for (const ch of to) await page.keyboard.type(ch, { delay: 80 + Math.random()*40 });
    await sleep(2000);
    await page.keyboard.press('ArrowDown'); await sleep(300);
    await page.keyboard.press('Enter'); await sleep(1000);

    // Switch to Business if needed
    if (!/economy/i.test(cabin)) {
      try {
        const cabBtn = page.locator('button').filter({ hasText: /^Economy$/ }).first();
        if (await cabBtn.isVisible({ timeout: 2000 })) {
          await cabBtn.click(); await sleep(400);
          await page.locator('[role="option"], li').filter({ hasText: new RegExp(cabin, 'i') }).first().click();
          await sleep(400);
        }
      } catch {}
    }

    // Fill depart date
    try {
      const depInput = page.locator('[aria-label="Departure"], input[placeholder="Departure"]').first();
      if (await depInput.isVisible({ timeout: 2000 })) {
        await depInput.click(); await sleep(300);
        await page.keyboard.press('Control+a');
        const d = new Date(depart+'T12:00:00');
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        await page.keyboard.type(M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear(), { delay: 50 });
        await sleep(700); await page.keyboard.press('Tab'); await sleep(300);
      }
    } catch {}

    // Fill return date
    try {
      const retInput = page.locator('[aria-label="Return"], input[placeholder="Return"]').first();
      if (await retInput.isVisible({ timeout: 2000 })) {
        await retInput.click(); await sleep(300);
        await page.keyboard.press('Control+a');
        const d = new Date(ret+'T12:00:00');
        const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        await page.keyboard.type(M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear(), { delay: 50 });
        await sleep(700);
      }
    } catch {}

    // Done
    try {
      const done = page.getByRole('button', { name: 'Done' }).last();
      if (await done.isVisible({ timeout: 1500 })) { await done.click(); await sleep(500); }
    } catch {}

    // Search
    try {
      const sb = page.getByRole('button', { name: /^(Search|Explore)$/i }).last();
      await sb.waitFor({ state: 'visible', timeout: 5000 });
      await sb.click({ delay: 80 });
    } catch { await page.keyboard.press('Enter'); }

    // Wait for API responses to come in
    await page.waitForLoadState('networkidle', { timeout: 35000 }).catch(() => {});
    await sleep(5000);

    const resultUrl = page.url();
    console.log('[FSX] ' + from + '->' + to + ' url=' + resultUrl.slice(0,80));
    console.log('[FSX] API responses captured:', apiResponses.length);
    apiResponses.slice(0,3).forEach(r => console.log(' -', r.url, r.len + 'b'));

    // If API interception got flights, use those
    if (capturedFlights.length > 0) {
      console.log('[FSX] Got ' + capturedFlights.length + ' from API interception');
      return capturedFlights;
    }

    // Fallback: DOM scraping
    const domFlights = await page.evaluate(() => {
      const results = [];
      let cards = [];
      const selectors = ['[role="listitem"]','li[data-id]','li[jsname]','.pIav2d'];
      for (const sel of selectors) {
        const found = [...document.querySelectorAll(sel)].filter(el => {
          const t = el.innerText || '';
          return (t.match(/\d{1,2}:\d{2}/g)||[]).length >= 2 &&
                 /[0-9]{3,5}/.test(t) && t.length > 50 && t.length < 1500;
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
          const pm = txt.match(/EUR\s*([\d,]+)/)||txt.match(/([\d,]+)\s*EUR/)||txt.match(/€\s*([\d,]+)/);
          if (!pm) return;
          const priceNum = parseInt(pm[1].replace(/,/g,''));
          if (priceNum < 100 || priceNum > 60000) return;
          const times = [...txt.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m=>m[1]);
          const dm = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?/)||txt.match(/(\d+)h\s*(\d+)?m?/);
          const dur = dm ? dm[1]+'h'+(dm[2]?dm[2]+'m':'') : '';
          let stops=0, via='';
          if (/nonstop|direct/i.test(txt)) stops=0;
          else if (/1 stop/i.test(txt)){stops=1;const vm=txt.match(/1 stop\s*\(([^)]+)\)/i);if(vm)via=vm[1];}
          else if (/(\d) stop/i.test(txt)) stops=parseInt(txt.match(/(\d) stop/i)[1]);
          const airline=lines.find(l=>l.length>=2&&l.length<=45&&!/^\d|EUR|€|stop|nonstop|hr |min|AM|PM|\d:\d|\+\d/.test(l))||'Unknown';
          results.push({airline,depTime:times[0]||'',arrTime:times[1]||'',dur,stops,via,priceNum,price:'EUR '+pm[1]});
        } catch {}
      });
      return results;
    });

    console.log('[FSX] DOM fallback found ' + domFlights.length + ' flights');
    return domFlights.map(f => ({
      from, to, fromCode:from, toCode:to, airline:f.airline,
      dur:f.dur, stops:f.stops, via:f.via, price:f.price, numPrice:f.priceNum,
      dep:fmtDate(depart)+(f.depTime?' '+f.depTime:''),
      ret:fmtDate(ret)+(f.arrTime?' '+f.arrTime:''),
      depDate:depart, retDate:ret, stayLabel:stayDays(depart,ret),
      cabin, real:true, buyUrl:resultUrl,
    }));

  } finally { await page.context().close().catch(()=>{}); }
}

// ── Extract structured flights from Google's JSON response ───────────────
function extractFlightsFromResponse(raw, from, to, depart, ret, cabin) {
  const results = [];
  try {
    const clean = typeof raw === 'string' ? raw.replace(/^[)\]}'\s]+/, '') : raw;
    // Google Flights JSON has nested arrays - hunt for flight-shaped data
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    
    // Pattern: price numbers near airport codes
    const priceMatches = [...text.matchAll(/"(\d{3,5})"/g)];
    const airportMatches = [...text.matchAll(/"([A-Z]{3})"/g)].map(m=>m[1]).filter(c=>
      ['ZRH','FRA','CDG','LHR','AMS','VIE','BCN','FCO','NRT','ICN','SIN','BKK','HKG','KUL','PVG','HAN','SGN','MNL','TPE','CGK'].includes(c)
    );
    
    if (priceMatches.length > 0 && airportMatches.length > 0) {
      console.log('[FSX] JSON has', priceMatches.length, 'prices,', airportMatches.length, 'airports');
      // Try proper parse
      try {
        const data = JSON.parse(clean);
        const str = JSON.stringify(data);
        // look for price arrays near departure codes
        const chunks = str.split('"'+from+'"');
        chunks.forEach(chunk => {
          const pm = chunk.match(/"(\d{3,5})"/);
          if (pm && parseInt(pm[1]) > 200 && parseInt(pm[1]) < 20000) {
            results.push({
              from, to, fromCode:from, toCode:to,
              airline:'See Google Flights', dur:'', stops:0, via:'',
              price:'EUR '+pm[1], numPrice:parseInt(pm[1]),
              dep:fmtDate(depart), ret:fmtDate(ret),
              depDate:depart, retDate:ret, stayLabel:stayDays(depart,ret),
              cabin, real:true,
              buyUrl:'https://www.google.com/travel/flights?hl=en&curr=EUR',
            });
          }
        });
      } catch {}
    }
  } catch(e) { console.error('[FSX] JSON parse error:', e.message.slice(0,60)); }
  return results.slice(0,5);
}

// ── Debug endpoint ───────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const page = await newPage();
  const responses = [];
  page.on('response', async (r) => {
    const url = r.url();
    if (url.includes('travel') || url.includes('batch') || url.includes('Flight')) {
      try {
        const text = await r.text();
        if (text.length > 200) responses.push({ url: url.slice(0,100), len: text.length, snippet: text.slice(0,200) });
      } catch {}
    }
  });
  try {
    await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR&gl=CH', {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await sleep(3000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0,2000));
    const url = page.url();
    res.json({ url, bodySnippet: bodyText.slice(0,500), apiCalls: responses.slice(0,10) });
  } catch(e) { res.json({ error: e.message }); }
  finally { await page.context().close().catch(()=>{}); }
});

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

app.get('/health', (req,res) => res.json({status:'FSX scraper online',version:'5.0'}));
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
      } catch(e) { console.error('[FSX] failed',org.code,'->',dst.code,':',e.message.slice(0,60)); }
    }
  }
  all.sort((a,b)=>a.numPrice-b.numPrice);
  const seen={};
  all.forEach(r=>{const k=r.fromCode+'-'+r.toCode;if(!seen[k]){r.best=true;seen[k]=true;}});
  res.json({ok:true,count:all.length,results:all.slice(0,30)});
});

app.listen(PORT, () => console.log('[FSX] Server v5 on port', PORT));
