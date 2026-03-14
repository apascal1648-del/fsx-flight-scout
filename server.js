/**
 * FSX Flight Scout v14
 * Fixes:
 * 1. Date range: depart/ret passed correctly from frontend
 * 2. After date grid, clicks cheapest date to get airline/duration/stops from results page
 * 3. Returns full flight details
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
  browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--window-size=1366,768'] });
  launching = false;
  return browser;
}

function stayDays(dep, ret) {
  return Math.round((new Date(ret+'T12:00:00') - new Date(dep+'T12:00:00')) / 86400000) + 'd';
}
function isoToDisp(iso) {
  const d = new Date(iso+'T12:00:00');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear();
}

async function newPage() {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale:'en-US', timezoneId:'Europe/Amsterdam', viewport:{width:1366,height:768},
    extraHTTPHeaders:{'Accept-Language':'en-US,en;q=0.9'},
  });
  await ctx.addInitScript(()=>{
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
    window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
  });
  return ctx.newPage();
}

async function handleConsent(page) {
  if (!page.url().includes('consent.google.com')) return;
  try {
    const btn = page.locator('button').filter({hasText:/accept all/i}).first();
    if (await btn.isVisible({timeout:5000})) { await btn.click(); await page.waitForURL(/google\.com\/travel/,{timeout:15000}); await sleep(2000); return; }
  } catch {}
  try { for(const b of await page.locator('button').all()){const t=(await b.innerText().catch(()=>'')).toLowerCase();if(t.includes('accept')||t.includes('agree')||t.includes('reject')){await b.click();await sleep(2000);return;}}} catch {}
}

async function switchCabin(page, cabin) {
  if (/economy/i.test(cabin)) return true;
  try {
    const switched = await page.evaluate(async (targetCabin) => {
      const combos = [...document.querySelectorAll('[role="combobox"]')];
      const cabinCombo = combos.find(el => /economy|business|first|premium/i.test(el.innerText||''));
      if (!cabinCombo) return {ok:false, reason:'no cabin combobox'};
      cabinCombo.click();
      await new Promise(r => setTimeout(r, 700));
      const opts = [...document.querySelectorAll('li[role="option"]')];
      const target = opts.find(el => new RegExp('^\\s*'+targetCabin+'\\s*$','i').test(el.innerText||''));
      if (!target) return {ok:false, available:opts.map(o=>o.innerText.trim())};
      target.click();
      return {ok:true};
    }, cabin);
    await sleep(400);
    return switched.ok === true;
  } catch(e) { return false; }
}

async function goToFlights(page) {
  await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR',{waitUntil:'domcontentloaded',timeout:30000});
  await sleep(2000);
  await handleConsent(page);
  if(page.url().includes('consent')){await handleConsent(page);await sleep(1000);}
}

// Extract prices from date grid + find best dates
function parseDateGrid(text, depart, ret) {
  const depDate = new Date(depart+'T12:00:00'), retDate = new Date(ret+'T12:00:00');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  let currentYear = depDate.getFullYear(), currentMonth = -1;
  const datePrices = [];
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  for (let i=0;i<lines.length;i++) {
    const line = lines[i];
    for (let m=0;m<12;m++) { if(line.startsWith(monthNames[m])){currentMonth=m;const y=line.match(/(202\d)/);if(y)currentYear=parseInt(y[1]);break;} }
    const dm = line.match(/^(\d{1,2})$/);
    if (dm && currentMonth>=0) {
      const day=parseInt(dm[1]), next=lines[i+1]||'', pm=next.match(/^€([\d,]+)$/);
      if (pm) {
        const price=parseInt(pm[1].replace(/,/g,''));
        const date=new Date(currentYear,currentMonth,day);
        if(date>=depDate&&date<=retDate&&price>0&&price<60000) datePrices.push({date,price,day,month:currentMonth,year:currentYear,iso:date.toISOString().slice(0,10)});
        i++;
      }
    }
  }
  datePrices.sort((a,b)=>a.price-b.price);
  return datePrices;
}

// After searching with date grid, click the cheapest date to see flight details
async function clickCheapestDate(page, datePrices) {
  if (!datePrices.length) return null;
  const best = datePrices[0];
  console.log('[FSX] Clicking cheapest date:', best.iso, '€'+best.price);
  try {
    // Find and click the price cell for this date in the calendar
    const clicked = await page.evaluate((targetIso, targetPrice) => {
      // Try data-iso attribute first
      const byIso = document.querySelector('[data-iso="'+targetIso+'"]');
      if (byIso) { byIso.click(); return {method:'data-iso'}; }
      // Find price text matching our target price in calendar context
      const allEls = [...document.querySelectorAll('*')];
      for (const el of allEls) {
        const t = (el.innerText||'').trim();
        if (t === '€'+targetPrice && el.children.length <= 2) {
          el.click(); return {method:'price-text', text:t};
        }
      }
      // Try clicking any cell with that price
      const priceText = '€'+targetPrice;
      for (const el of allEls) {
        if ((el.innerText||'').includes(priceText) && el.tagName === 'TD') {
          el.click(); return {method:'TD', text:el.innerText.slice(0,30)};
        }
      }
      return null;
    }, best.iso, best.price);
    
    if (clicked) {
      console.log('[FSX] Clicked via:', clicked.method);
      await page.waitForLoadState('networkidle', {timeout:20000}).catch(()=>{});
      await sleep(3000);
      return best;
    }
  } catch(e) { console.log('[FSX] clickCheapestDate error:', e.message.slice(0,50)); }
  return null;
}

// Extract flight details (airline, duration, stops) from results page
async function extractFlightDetails(page) {
  try {
    const details = await page.evaluate(() => {
      const results = [];
      // Flight list items have times, duration, airline
      const cards = [...document.querySelectorAll('[role="listitem"]')].filter(el => {
        const t = el.innerText || '';
        return t.length > 60 && /\d+:\d+/.test(t) && /hr|min/.test(t);
      });
      cards.slice(0, 8).forEach(card => {
        try {
          const txt = card.innerText || '';
          const lines = txt.split('\n').map(l=>l.trim()).filter(Boolean);
          // Price
          const pm = txt.match(/€([\d,]+)/);
          if (!pm) return;
          const price = parseInt(pm[1].replace(/,/g,''));
          if (price < 200 || price > 60000) return;
          // Times: e.g. "10:30 AM" or "10:30"
          const times = [...txt.matchAll(/\b(\d{1,2}:\d{2}(?:\s*[AP]M)?)/gi)].map(m=>m[1]);
          // Duration: e.g. "13 hr 25 min" or "13h 25m"
          const dm = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?|(\d+)h\s*(\d+)?m/);
          const dur = dm ? (dm[1]||dm[3])+'h '+(dm[2]||dm[4]||'0')+'m' : '';
          // Stops
          let stops = 0, via = '';
          if (/nonstop|direct/i.test(txt)) stops = 0;
          else if (/1 stop/i.test(txt)) {
            stops = 1;
            const vm = txt.match(/1 stop\s*\(([^)]+)\)/i) || txt.match(/layover[^\n]*([A-Z]{3})/);
            if (vm) via = vm[1];
          } else {
            const sm = txt.match(/(\d+)\s+stops?/i);
            if (sm) stops = parseInt(sm[1]);
          }
          // Layover duration e.g. "2 hr 30 min layover"
          const layoverMatch = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?\s*layover/i);
          const layoverDur = layoverMatch ? (layoverMatch[1]+'h '+(layoverMatch[2]||'0')+'m') : '';
          // Airline - find line that looks like airline name
          const airline = lines.find(l =>
            l.length >= 3 && l.length <= 50 &&
            !/^\d|€|\$|stop|nonstop|direct|hr|min|AM|PM|\d:\d|\+\d|Operated|Separate|Carbon|More|Select|Book|View/i.test(l) &&
            /[A-Za-z]{3}/.test(l) &&
            !/(ZRH|FRA|CDG|LHR|AMS|VIE|BCN|FCO|NRT|ICN|SIN|BKK|HKG|KUL|PVG|HAN|SGN|MNL|TPE|CGK)/.test(l)
          ) || 'See Google Flights';
          results.push({airline, depTime:times[0]||'', arrTime:times[1]||'', dur, stops, via, layoverDur, price});
        } catch {}
      });
      return results;
    });
    console.log('[FSX] Flight details extracted:', details.length, 'flights');
    return details;
  } catch(e) {
    console.log('[FSX] extractFlightDetails error:', e.message.slice(0,50));
    return [];
  }
}

async function scrapeRoute({ from, to, depart, ret, cabin='Business', stay=90 }) {
  const page = await newPage();
  try {
    await goToFlights(page);
    const cabinOk = await switchCabin(page, cabin);

    // Fill origin
    const oi=page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click();await sleep(300);await page.keyboard.press('Control+a');
    for(const ch of from)await page.keyboard.type(ch,{delay:80});
    await sleep(2000);await page.keyboard.press('ArrowDown');await sleep(300);await page.keyboard.press('Enter');await sleep(800);

    // Fill destination
    const di=page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click();await sleep(300);
    for(const ch of to)await page.keyboard.type(ch,{delay:80});
    await sleep(2000);await page.keyboard.press('ArrowDown');await sleep(300);await page.keyboard.press('Enter');await sleep(800);

    // Search (no dates → shows date grid)
    await page.keyboard.press('Escape');await sleep(300);
    try{const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last();await sb.waitFor({state:'visible',timeout:5000});await sb.click();}catch{await page.keyboard.press('Enter');}

    // Wait for date grid prices
    try{await page.waitForFunction(()=>(document.body.innerText.match(/€\d{3,5}/g)||[]).length>=5,{timeout:30000,polling:1500});}catch{}
    await sleep(1000);

    const gridUrl = page.url();
    const pageText = await page.evaluate(()=>document.body.innerText);
    const datePrices = parseDateGrid(pageText, depart, ret);
    console.log('[FSX]',from,'->',to,'grid prices in range:',datePrices.length,'| cabinOk:',cabinOk);
    if (!datePrices.length) return [];

    // Click cheapest date to get to flight results
    const bestDate = await clickCheapestDate(page, datePrices);
    const resultUrl = page.url();
    
    // Extract flight details from results page
    let flightDetails = [];
    if (bestDate && resultUrl !== gridUrl) {
      flightDetails = await extractFlightDetails(page);
    }

    const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const stayMs = stay * 86400000;

    // Build results: top 5 prices from grid, enriched with details from best date
    return datePrices.slice(0,5).map((dp, idx) => {
      const depStr = M[dp.month]+' '+dp.day+' '+dp.year;
      const retDate = new Date(dp.date.getTime() + stayMs);
      const retStr = M[retDate.getMonth()]+' '+retDate.getDate()+' '+retDate.getFullYear();
      const retIso = retDate.toISOString().slice(0,10);
      // Use flight details from best date for all (same route, similar flights)
      const detail = flightDetails[0] || null;
      return {
        from, to, fromCode:from, toCode:to,
        airline: detail?.airline || 'See Google Flights',
        dur: detail?.dur || '',
        stops: detail?.stops ?? 0,
        via: detail?.via || '',
        layoverDur: detail?.layoverDur || '',
        price: '€'+dp.price,
        numPrice: dp.price,
        dep: depStr + (detail?.depTime ? ' '+detail.depTime : ''),
        ret: retStr + (detail?.arrTime ? ' '+detail.arrTime : ''),
        depDate: dp.iso,
        retDate: retIso,
        stayLabel: stay+'d',
        cabin: cabinOk ? cabin : 'Economy*',
        real: true,
        best: idx === 0,
        buyUrl: resultUrl !== gridUrl ? resultUrl : gridUrl,
      };
    });
  } finally { await page.context().close().catch(()=>{}); }
}

const EU_HUBS=[{code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},{code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},{code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'}];
const AS_AIRPORTS=[{code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},{code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},{code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},{code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'}];
app.get('/health',(req,res)=>res.json({status:'FSX scraper online',version:'14.0'}));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'FSX-standalone.html')));
app.get('/scrape',async(req,res)=>{
  const{from,to,depart,ret,cabin='Business',stay='90'}=req.query;
  if(!from||!to||!depart||!ret)return res.status(400).json({error:'from,to,depart,ret required'});
  try{const r=await scrapeRoute({from,to,depart,ret,cabin,stay:parseInt(stay)});res.json({ok:true,results:r});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/scan',async(req,res)=>{
  const{fromCode,toCode,depart,ret,cabin='Business',stay='90'}=req.query;
  if(!depart||!ret)return res.status(400).json({error:'depart and ret required'});
  const origins=(!fromCode||fromCode==='ALL')?EU_HUBS:EU_HUBS.filter(h=>fromCode.split(',').includes(h.code));
  const dests=(!toCode||toCode==='ALL')?AS_AIRPORTS:AS_AIRPORTS.filter(a=>toCode.split(',').includes(a.code));
  const all=[];
  for(const o of origins){for(const d of dests){try{const r=await scrapeRoute({from:o.code,to:d.code,depart,ret,cabin,stay:parseInt(stay)});r.forEach(x=>{x.from=o.name;x.to=d.name;});all.push(...r);await sleep(2000);}catch(e){console.error('[FSX]',o.code,'->',d.code,e.message.slice(0,50));}}}
  all.sort((a,b)=>a.numPrice-b.numPrice);
  const seen={};all.forEach(r=>{const k=r.fromCode+'-'+r.toCode;if(!seen[k]){r.best=true;seen[k]=true;}});
  res.json({ok:true,count:all.length,results:all.slice(0,50)});
});
app.listen(PORT,()=>console.log('[FSX] Server v14 on port',PORT));
