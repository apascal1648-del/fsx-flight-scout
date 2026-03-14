/**
 * FSX Flight Scout v11
 * Fix: cabin button on Google Flights says "1 · Economy" not just "Economy"
 * Solution: use aria-label or find button containing "Economy" text (not exact match)
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

// Switch cabin - Google Flights button contains "Economy" as part of "1 · Economy"
async function switchCabin(page, cabin) {
  if (/economy/i.test(cabin)) return true;
  console.log('[FSX] Trying to switch cabin to', cabin);
  try {
    // Find button that CONTAINS "Economy" (not exact match - it's "1 · Economy")
    const buttons = await page.locator('button').all();
    let cabinBtn = null;
    for (const btn of buttons) {
      const txt = await btn.innerText().catch(() => '');
      if (/economy/i.test(txt)) { cabinBtn = btn; break; }
    }
    if (!cabinBtn) {
      console.log('[FSX] cabin button not found');
      return false;
    }
    const btnTxt = await cabinBtn.innerText().catch(() => '');
    console.log('[FSX] Found cabin button:', btnTxt.slice(0,30));
    await cabinBtn.click();
    await sleep(800);

    // Now find the option for the desired cabin class in the dropdown
    const options = await page.locator('[role="option"], [role="radio"], li').all();
    for (const opt of options) {
      const txt = await opt.innerText().catch(() => '');
      if (new RegExp('^\s*' + cabin + '\s*$', 'i').test(txt)) {
        await opt.click();
        await sleep(500);
        console.log('[FSX] Cabin option clicked:', txt.trim());
        // Verify
        const newBtn = await page.locator('button').all();
        for (const b of newBtn) {
          const t = await b.innerText().catch(() => '');
          if (new RegExp(cabin, 'i').test(t)) {
            console.log('[FSX] Cabin confirmed:', t.slice(0,30));
            return true;
          }
        }
        return true; // clicked, assume ok
      }
    }
    console.log('[FSX] cabin option not found in dropdown');
    return false;
  } catch(e) {
    console.log('[FSX] switchCabin error:', e.message.slice(0,60));
    return false;
  }
}

async function goToFlights(page) {
  await page.goto('https://www.google.com/travel/flights?hl=en&curr=EUR',{waitUntil:'domcontentloaded',timeout:30000});
  await sleep(2000);
  await handleConsent(page);
  if(page.url().includes('consent')){await handleConsent(page);await sleep(1000);}
}

function extractFromDateGrid(text, from, to, depart, ret, cabin, cabinSwitched, buyUrl) {
  const results = [];
  const depDate = new Date(depart + 'T12:00:00');
  const retDate = new Date(ret + 'T12:00:00');
  const stayLabel = stayDays(depart, ret);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let currentYear = depDate.getFullYear(), currentMonth = -1;
  const datePrices = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let m = 0; m < 12; m++) {
      if (line.startsWith(monthNames[m])) { currentMonth = m; const y=line.match(/(202\d)/); if(y) currentYear=parseInt(y[1]); break; }
    }
    const dm = line.match(/^(\d{1,2})$/);
    if (dm && currentMonth >= 0) {
      const day = parseInt(dm[1]);
      const next = lines[i+1]||'';
      const pm = next.match(/^€([\d,]+)$/);
      if (pm) {
        const price = parseInt(pm[1].replace(/,/g,''));
        const date = new Date(currentYear, currentMonth, day);
        if (date >= depDate && date <= retDate && price > 0 && price < 60000) datePrices.push({date,price,day,month:currentMonth,year:currentYear});
        i++;
      }
    }
  }
  console.log('[FSX]', from, '->', to, 'grid prices:', datePrices.length, '| cabinOk:', cabinSwitched);
  if (datePrices.length === 0) return [];
  datePrices.sort((a,b)=>a.price-b.price);
  const actualCabin = cabinSwitched ? cabin : 'Economy*';
  return datePrices.slice(0,5).map((dp,idx)=>{
    const depStr = M[dp.month]+' '+dp.day+' '+dp.year;
    const estRet = new Date(dp.date.getTime()+(retDate-depDate));
    return {
      from, to, fromCode:from, toCode:to, airline:'See Google Flights',
      dur:'', stops:0, via:'', price:'€'+dp.price, numPrice:dp.price,
      dep:depStr, ret:M[estRet.getMonth()]+' '+estRet.getDate()+' '+estRet.getFullYear(),
      depDate:dp.date.toISOString().slice(0,10), retDate:estRet.toISOString().slice(0,10),
      stayLabel, cabin:actualCabin, real:true, best:idx===0, buyUrl,
    };
  });
}

async function scrapeRoute({ from, to, depart, ret, cabin='Business' }) {
  const page = await newPage();
  try {
    await goToFlights(page);

    // Switch cabin FIRST on homepage
    const cabinOk = await switchCabin(page, cabin);

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

    // Search
    await page.keyboard.press('Escape'); await sleep(300);
    try { const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last(); await sb.waitFor({state:'visible',timeout:5000}); await sb.click(); } catch { await page.keyboard.press('Enter'); }

    // Wait for date grid
    try { await page.waitForFunction(()=>(document.body.innerText.match(/€\d{3,5}/g)||[]).length>=5,{timeout:30000,polling:1500}); } catch {}
    await sleep(1000);

    const resultUrl = page.url();
    const pageText = await page.evaluate(()=>document.body.innerText);
    const flights = extractFromDateGrid(pageText, from, to, depart, ret, cabin, cabinOk, resultUrl);
    console.log('[FSX] Found', flights.length, 'prices for', from, '->', to, '| cabin ok:', cabinOk);
    return flights;
  } finally { await page.context().close().catch(()=>{}); }
}

// /peek — also logs what cabin button text looks like before clicking
app.get('/peek', async (req,res) => {
  const {from='ZRH',to='SIN',depart='2027-02-01',ret='2027-05-01',cabin='Business'} = req.query;
  const page = await newPage();
  try {
    await goToFlights(page);
    // Log all button texts to understand the UI
    const btns = await page.locator('button').all();
    const btnTexts = [];
    for (const b of btns) { const t=await b.innerText().catch(()=>''); if(t.trim()) btnTexts.push(t.trim().slice(0,40)); }
    console.log('[FSX] Buttons on page:', btnTexts.slice(0,20).join(' | '));
    const cabinOk = await switchCabin(page, cabin);
    const oi = page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click(); await sleep(300); await page.keyboard.press('Control+a');
    for(const ch of from) await page.keyboard.type(ch, {delay:80});
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);
    const di = page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click(); await sleep(300);
    for(const ch of to) await page.keyboard.type(ch, {delay:80});
    await sleep(2000); await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); await sleep(800);
    await page.keyboard.press('Escape'); await sleep(300);
    try { const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last(); await sb.waitFor({state:'visible',timeout:5000}); await sb.click(); } catch { await page.keyboard.press('Enter'); }
    try { await page.waitForFunction(()=>(document.body.innerText.match(/€\d{3,5}/g)||[]).length>=5,{timeout:25000,polling:1500}); } catch {}
    await sleep(1000);
    const url = page.url();
    const text = await page.evaluate(()=>document.body.innerText);
    const flights = extractFromDateGrid(text, from, to, depart, ret, cabin, cabinOk, url);
    res.json({url, cabinSwitched:cabinOk, buttonTexts:btnTexts.slice(0,15), flightsFound:flights.length, flights});
  } catch(e){res.json({error:e.message});}
  finally { await page.context().close().catch(()=>{}); }
});

const EU_HUBS=[{code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},{code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},{code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'}];
const AS_AIRPORTS=[{code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},{code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},{code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},{code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'}];
app.get('/health',(req,res)=>res.json({status:'FSX scraper online',version:'11.0'}));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'FSX-standalone.html')));
app.get('/debug',(req,res)=>res.json({note:'Use /peek?from=ZRH&to=SIN&cabin=Business'}));
app.get('/scrape',async(req,res)=>{
  const{from,to,depart,ret,cabin='Business'}=req.query;
  if(!from||!to||!depart||!ret)return res.status(400).json({error:'from,to,depart,ret required'});
  try{const r=await scrapeRoute({from,to,depart,ret,cabin});res.json({ok:true,results:r});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/scan',async(req,res)=>{
  const{fromCode,toCode,depart,ret,cabin='Business'}=req.query;
  if(!depart||!ret)return res.status(400).json({error:'depart and ret required'});
  const origins=(!fromCode||fromCode==='ALL')?EU_HUBS:EU_HUBS.filter(h=>fromCode.split(',').includes(h.code));
  const dests=(!toCode||toCode==='ALL')?AS_AIRPORTS:AS_AIRPORTS.filter(a=>toCode.split(',').includes(a.code));
  const all=[];
  for(const o of origins){for(const d of dests){try{const r=await scrapeRoute({from:o.code,to:d.code,depart,ret,cabin});r.forEach(x=>{x.from=o.name;x.to=d.name;});all.push(...r);await sleep(2000);}catch(e){console.error('[FSX]',o.code,'->',d.code,e.message.slice(0,50));}}}
  all.sort((a,b)=>a.numPrice-b.numPrice);
  const seen={};all.forEach(r=>{const k=r.fromCode+'-'+r.toCode;if(!seen[k]){r.best=true;seen[k]=true;}});
  res.json({ok:true,count:all.length,results:all.slice(0,50)});
});
app.listen(PORT,()=>console.log('[FSX] Server v11 on port',PORT));
