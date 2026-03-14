/**
 * FSX Flight Scout v9
 * Strategy: extract cheapest price per departure date from Google Flights date grid
 * The date grid always appears and shows per-day prices — we harvest those directly.
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
  console.log('[FSX] consent...');
  try {
    const btn = page.locator('button').filter({hasText:/accept all/i}).first();
    if (await btn.isVisible({timeout:5000})) { await btn.click(); await page.waitForURL(/google\.com\/travel/,{timeout:15000}); await sleep(2000); return; }
  } catch {}
  try { for(const b of await page.locator('button').all()){const t=(await b.innerText().catch(()=>'')).toLowerCase();if(t.includes('accept')||t.includes('agree')||t.includes('reject')){await b.click();await sleep(2000);return;}}} catch {}
}

async function goToFlights(page) {
  await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR',{waitUntil:'domcontentloaded',timeout:30000});
  await sleep(2000);
  await handleConsent(page);
  if(page.url().includes('consent')){await handleConsent(page);await sleep(1000);}
}

// Extract prices from the date grid calendar text
// Format in text: "January 2027\nM\nT\n...\n1\n€580\n2\n€591\n..."
function extractFromDateGrid(text, from, to, depart, ret, cabin, buyUrl) {
  const results = [];
  const depDate = new Date(depart + 'T12:00:00');
  const retDate = new Date(ret + 'T12:00:00');
  const stayLabel = stayDays(depart, ret);

  // Find all €XXX patterns in the text, keeping track of nearby dates
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  // Find month+year headers and build a map of day->price
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  
  let currentYear = depDate.getFullYear();
  let currentMonth = -1;
  const datePrices = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect "Month Year" or "Month" header
    for (let m = 0; m < 12; m++) {
      if (line.startsWith(monthNames[m])) {
        currentMonth = m;
        const yearMatch = line.match(/(202\d)/);
        if (yearMatch) currentYear = parseInt(yearMatch[1]);
        break;
      }
    }
    
    // Detect day number followed by price on next line
    const dayMatch = line.match(/^(\d{1,2})$/);
    if (dayMatch && currentMonth >= 0) {
      const day = parseInt(dayMatch[1]);
      const nextLine = lines[i+1] || '';
      const priceMatch = nextLine.match(/^€([\d,]+)$/);
      if (priceMatch) {
        const price = parseInt(priceMatch[1].replace(/,/g,''));
        const date = new Date(currentYear, currentMonth, day);
        // Only include dates in our departure window
        if (date >= depDate && date <= retDate && price > 0 && price < 60000) {
          datePrices.push({ date, price, day, month: currentMonth, year: currentYear });
        }
        i++; // skip the price line
      }
    }
  }

  console.log('[FSX] date grid prices found:', datePrices.length);
  
  if (datePrices.length === 0) return [];

  // Sort by price, take the best few
  datePrices.sort((a, b) => a.price - b.price);
  const best = datePrices.slice(0, 5);

  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  
  return best.map((dp, idx) => {
    const depStr = M[dp.month] + ' ' + dp.day + ' ' + dp.year;
    // Estimate return date based on stay duration
    const estRet = new Date(dp.date.getTime() + (retDate - depDate));
    const retStr = M[estRet.getMonth()] + ' ' + estRet.getDate() + ' ' + estRet.getFullYear();
    const retIso = estRet.toISOString().slice(0,10);
    
    return {
      from, to, fromCode: from, toCode: to,
      airline: 'See Google Flights',
      dur: '', stops: 0, via: '',
      price: '€' + dp.price,
      numPrice: dp.price,
      dep: depStr,
      ret: retStr,
      depDate: dp.date.toISOString().slice(0,10),
      retDate: retIso,
      stayLabel,
      cabin,
      real: true,
      best: idx === 0,
      buyUrl,
    };
  });
}

async function scrapeRoute({ from, to, depart, ret, cabin='Business' }) {
  const page = await newPage();
  try {
    await goToFlights(page);

    // Switch cabin if needed
    if (!/economy/i.test(cabin)) {
      try {
        const cb = page.locator('button').filter({hasText:/^Economy$/}).first();
        if (await cb.isVisible({timeout:2000})) {
          await cb.click(); await sleep(400);
          await page.locator('[role="option"],li').filter({hasText:new RegExp('^'+cabin+'$','i')}).first().click();
          await sleep(400);
        }
      } catch {}
    }

    // Fill origin
    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click(); await sleep(300); await page.keyboard.press('Control+a');
    for(const ch of from) await page.keyboard.type(ch, {delay:80});
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);

    // Fill destination
    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click(); await sleep(300);
    for(const ch of to) await page.keyboard.type(ch, {delay:80});
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);

    // Press Escape to dismiss any autocomplete, then Enter or click Search
    await page.keyboard.press('Escape'); await sleep(300);
    try {
      const sb = page.getByRole('button', {name:/^(Search|Explore)$/i}).last();
      await sb.waitFor({state:'visible',timeout:5000}); await sb.click();
    } catch { await page.keyboard.press('Enter'); }

    // Wait for the date grid prices to appear (€XXX in text)
    console.log('[FSX] waiting for date grid...', from, '->', to);
    try {
      await page.waitForFunction(() => {
        const t = document.body.innerText;
        return (t.match(/€\d{3,5}/g)||[]).length >= 5;
      }, {timeout:30000, polling:1500});
      console.log('[FSX] date grid loaded');
    } catch(e) { console.log('[FSX] date grid timeout'); }
    
    await sleep(1000);
    const resultUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText);
    
    console.log('[FSX]', from, '->', to, 'text:', pageText.length, 'url:', resultUrl.slice(0,70));
    
    const flights = extractFromDateGrid(pageText, from, to, depart, ret, cabin, resultUrl);
    console.log('[FSX] found', flights.length, 'prices for', from, '->', to);
    return flights;
  } finally { await page.context().close().catch(()=>{}); }
}

// /peek for debugging
app.get('/peek', async (req,res) => {
  const {from='ZRH',to='SIN',depart='2027-02-01',ret='2027-05-01',cabin='Business'} = req.query;
  const page = await newPage();
  try {
    await goToFlights(page);
    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click(); await sleep(300); await page.keyboard.press('Control+a');
    for(const ch of from) await page.keyboard.type(ch, {delay:80});
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);
    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click(); await sleep(300);
    for(const ch of to) await page.keyboard.type(ch, {delay:80});
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);
    await page.keyboard.press('Escape'); await sleep(300);
    try { const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last();await sb.waitFor({state:'visible',timeout:5000});await sb.click(); } catch { await page.keyboard.press('Enter'); }
    try { await page.waitForFunction(()=>(document.body.innerText.match(/€\d{3,5}/g)||[]).length>=5,{timeout:25000,polling:1500}); } catch {}
    await sleep(1000);
    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText);
    const flights = extractFromDateGrid(text, from, to, depart, ret, cabin, url);
    res.json({url, textLength:text.length, flightsFound:flights.length, flights, textSample:text.slice(0,2000)});
  } catch(e){res.json({error:e.message});}
  finally { await page.context().close().catch(()=>{}); }
});

const EU_HUBS=[{code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},{code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},{code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'}];
const AS_AIRPORTS=[{code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},{code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},{code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},{code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'}];

app.get('/health',(req,res)=>res.json({status:'FSX scraper online',version:'9.0'}));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'FSX-standalone.html')));
app.get('/debug',(req,res)=>res.json({note:'Use /peek?from=ZRH&to=SIN'}));
app.get('/scrape',async(req,res)=>{
  const{from,to,depart,ret,cabin='Business'}=req.query;
  if(!from||!to||!depart||!ret)return res.status(400).json({error:'from,to,depart,ret required'});
  try{const results=await scrapeRoute({from,to,depart,ret,cabin});res.json({ok:true,results});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/scan',async(req,res)=>{
  const{fromCode,toCode,depart,ret,cabin='Business'}=req.query;
  if(!depart||!ret)return res.status(400).json({error:'depart and ret required'});
  const origins=(!fromCode||fromCode==='ALL')?EU_HUBS:EU_HUBS.filter(h=>fromCode.split(',').includes(h.code));
  const dests=(!toCode||toCode==='ALL')?AS_AIRPORTS:AS_AIRPORTS.filter(a=>toCode.split(',').includes(a.code));
  const all=[];
  for(const org of origins){for(const dst of dests){try{const r=await scrapeRoute({from:org.code,to:dst.code,depart,ret,cabin});r.forEach(x=>{x.from=org.name;x.to=dst.name;});all.push(...r);await sleep(2000);}catch(e){console.error('[FSX]',org.code,'->',dst.code,e.message.slice(0,50));}}}
  all.sort((a,b)=>a.numPrice-b.numPrice);
  const seen={};all.forEach(r=>{const k=r.fromCode+'-'+r.toCode;if(!seen[k]){r.best=true;seen[k]=true;}});
  res.json({ok:true,count:all.length,results:all.slice(0,50)});
});
app.listen(PORT,()=>console.log('[FSX] Server v9 on port',PORT));
