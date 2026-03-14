/**
 * FSX Flight Scout v12
 * Fix: cabin button on Google Flights is the "1" (passengers) button
 * Clicking it opens a modal with both passengers + cabin class selectors
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

// Switch cabin class
// The Google Flights cabin button shows "1" (passenger count) — clicking it
// opens a dropdown/modal with cabin class options
async function switchCabin(page, cabin) {
  if (/economy/i.test(cabin)) return true;
  console.log('[FSX] Switching cabin to', cabin);
  try {
    // The passengers+cabin button has aria-label containing "passengers" or shows just the number
    // Try multiple selectors to find it
    let opened = false;

    // Strategy 1: aria-label containing "passenger" or "class"
    for (const sel of [
      '[aria-label*="passenger" i]',
      '[aria-label*="cabin" i]',
      '[aria-label*="class" i]',
      '[data-ved] button:has-text("1")',
    ]) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({timeout:800})) {
          await el.click(); await sleep(800); opened = true;
          console.log('[FSX] Opened via selector:', sel); break;
        }
      } catch {}
    }

    // Strategy 2: find button with exact text "1" (the passengers button)
    if (!opened) {
      const buttons = await page.locator('button').all();
      for (const btn of buttons) {
        const txt = (await btn.innerText().catch(()=>'')).trim();
        if (txt === '1') {
          await btn.click(); await sleep(800); opened = true;
          console.log('[FSX] Opened via "1" button'); break;
        }
      }
    }

    if (!opened) { console.log('[FSX] Could not open cabin dropdown'); return false; }

    // Now look for cabin class options in the opened dropdown/modal
    // Options could be radio buttons, list items, or buttons
    for (const sel of [
      '[role="radio"]',
      '[role="option"]',
      'li[data-value]',
      '.cabin-class-option',
    ]) {
      const opts = await page.locator(sel).all();
      for (const opt of opts) {
        const txt = await opt.innerText().catch(() => '');
        if (new RegExp(cabin, 'i').test(txt)) {
          await opt.click(); await sleep(500);
          console.log('[FSX] Cabin option clicked:', txt.trim());
          // Click Done to confirm
          try {
            const done = page.getByRole('button', {name:'Done'}).first();
            if (await done.isVisible({timeout:1500})) { await done.click(); await sleep(400); }
          } catch {}
          return true;
        }
      }
    }

    // Fallback: look for any element containing cabin name
    const allEls = await page.locator('*').all();
    for (const el of allEls.slice(0, 200)) {
      try {
        const txt = await el.innerText().catch(() => '');
        const tag = await el.evaluate(e => e.tagName).catch(() => '');
        if (new RegExp('^\\s*' + cabin + '\\s*$', 'i').test(txt) && ['LI','BUTTON','SPAN','DIV'].includes(tag)) {
          await el.click(); await sleep(500);
          console.log('[FSX] Cabin fallback clicked:', txt.trim(), tag);
          try { const done=page.getByRole('button',{name:'Done'}).first(); if(await done.isVisible({timeout:1500})){await done.click();await sleep(400);} } catch {}
          return true;
        }
      } catch {}
    }

    console.log('[FSX] cabin option not found after opening dropdown');
    // Close the dropdown
    await page.keyboard.press('Escape');
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
  const depDate = new Date(depart+'T12:00:00'), retDate = new Date(ret+'T12:00:00');
  const stayLabel = stayDays(depart, ret);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
        if(date>=depDate&&date<=retDate&&price>0&&price<60000) datePrices.push({date,price,day,month:currentMonth,year:currentYear});
        i++;
      }
    }
  }
  console.log('[FSX]',from,'->',to,'grid prices:',datePrices.length,'| cabinOk:',cabinSwitched);
  if(!datePrices.length) return [];
  datePrices.sort((a,b)=>a.price-b.price);
  const actualCabin = cabinSwitched ? cabin : 'Economy*';
  return datePrices.slice(0,5).map((dp,idx)=>{
    const depStr=M[dp.month]+' '+dp.day+' '+dp.year;
    const estRet=new Date(dp.date.getTime()+(retDate-depDate));
    return {from,to,fromCode:from,toCode:to,airline:'See Google Flights',dur:'',stops:0,via:'',
      price:'€'+dp.price,numPrice:dp.price,dep:depStr,
      ret:M[estRet.getMonth()]+' '+estRet.getDate()+' '+estRet.getFullYear(),
      depDate:dp.date.toISOString().slice(0,10),retDate:estRet.toISOString().slice(0,10),
      stayLabel,cabin:actualCabin,real:true,best:idx===0,buyUrl};
  });
}

async function scrapeRoute({ from, to, depart, ret, cabin='Business' }) {
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

    // Search
    await page.keyboard.press('Escape');await sleep(300);
    try{const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last();await sb.waitFor({state:'visible',timeout:5000});await sb.click();}catch{await page.keyboard.press('Enter');}

    // Wait for date grid
    try{await page.waitForFunction(()=>(document.body.innerText.match(/€\d{3,5}/g)||[]).length>=5,{timeout:30000,polling:1500});}catch{}
    await sleep(1000);

    const resultUrl=page.url();
    const pageText=await page.evaluate(()=>document.body.innerText);
    const flights=extractFromDateGrid(pageText,from,to,depart,ret,cabin,cabinOk,resultUrl);
    console.log('[FSX] Found',flights.length,'prices for',from,'->',to,'| cabinOk:',cabinOk);
    return flights;
  } finally { await page.context().close().catch(()=>{}); }
}

app.get('/peek', async (req,res) => {
  const {from='ZRH',to='SIN',depart='2027-02-01',ret='2027-05-01',cabin='Business'} = req.query;
  const page = await newPage();
  try {
    await goToFlights(page);
    // Log all interactive elements and their aria-labels
    const info = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button,[role=button]')];
      return btns.slice(0,30).map(b=>({tag:b.tagName,text:(b.innerText||'').slice(0,30),aria:(b.getAttribute('aria-label')||'').slice(0,40)}));
    });
    console.log('[FSX] Interactive elements:', JSON.stringify(info));
    const cabinOk = await switchCabin(page, cabin);
    const oi=page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
    await oi.click();await sleep(300);await page.keyboard.press('Control+a');
    for(const ch of from)await page.keyboard.type(ch,{delay:80});
    await sleep(2000);await page.keyboard.press('ArrowDown');await sleep(300);await page.keyboard.press('Enter');await sleep(800);
    const di=page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
    await di.click();await sleep(300);
    for(const ch of to)await page.keyboard.type(ch,{delay:80});
    await sleep(2000);await page.keyboard.press('ArrowDown');await sleep(300);await page.keyboard.press('Enter');await sleep(800);
    await page.keyboard.press('Escape');await sleep(300);
    try{const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last();await sb.waitFor({state:'visible',timeout:5000});await sb.click();}catch{await page.keyboard.press('Enter');}
    try{await page.waitForFunction(()=>(document.body.innerText.match(/€\d{3,5}/g)||[]).length>=5,{timeout:25000,polling:1500});}catch{}
    await sleep(1000);
    const url=page.url();
    const text=await page.evaluate(()=>document.body.innerText);
    const flights=extractFromDateGrid(text,from,to,depart,ret,cabin,cabinOk,url);
    res.json({url,cabinSwitched:cabinOk,interactiveElements:info,flightsFound:flights.length,flights:flights.slice(0,2)});
  } catch(e){res.json({error:e.message});}
  finally{await page.context().close().catch(()=>{});}
});

const EU_HUBS=[{code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},{code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},{code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'}];
const AS_AIRPORTS=[{code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},{code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},{code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},{code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'}];
app.get('/health',(req,res)=>res.json({status:'FSX scraper online',version:'12.0'}));
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
app.listen(PORT,()=>console.log('[FSX] Server v12 on port',PORT));
