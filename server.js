/**
 * FSX Flight Scout v8 - Active DOM wait for flight prices
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

function fmtDate(iso){const d=new Date(iso+'T12:00:00');const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear();}
function stayDays(dep,ret){return Math.round((new Date(ret+'T12:00:00')-new Date(dep+'T12:00:00'))/86400000)+'d';}

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
  console.log('[FSX] consent page...');
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
  console.log('[FSX] at:', page.url().slice(0,60));
}

async function waitForFlights(page) {
  console.log('[FSX] waiting for prices...');
  try {
    await page.waitForFunction(() => {
      const t = document.body.innerText;
      const prices = (t.match(/EUR\s*\d{3,5}|€\s*\d{3,5}/g)||[]).length;
      const times  = (t.match(/\d{1,2}:\d{2}/g)||[]).length;
      return prices >= 2 && times >= 4;
    }, {timeout:30000, polling:1500});
    console.log('[FSX] prices loaded!');
    return true;
  } catch(e) { console.log('[FSX] waitForFlights timeout'); return false; }
}

function extractFlights(text, from, to, depart, ret, cabin, url) {
  const results = [];
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    const block = lines.slice(Math.max(0,i-2),i+12).join(' ');
    const times = [...block.matchAll(/\b(\d{1,2}:\d{2})/g)].map(m=>m[1]);
    if(times.length<2) continue;
    const pm=block.match(/EUR\s*([\d,]+)/)||block.match(/€\s*([\d,]+)/);
    if(!pm) continue;
    const priceNum=parseInt(pm[1].replace(/,/g,''));
    if(priceNum<100||priceNum>60000) continue;
    if(results.find(r=>r.numPrice===priceNum)) continue;
    const dm=block.match(/(\d+)\s*hr\s*(\d+)?\s*min?/)||block.match(/(\d+)h\s*(\d+)?m?/);
    const dur=dm?dm[1]+'h'+(dm[2]?dm[2]+'m':''):'';
    let stops=0,via='';
    if(/nonstop|direct/i.test(block))stops=0;
    else if(/1 stop/i.test(block)){stops=1;const vm=block.match(/1 stop\s*\(([^)]+)\)/i);if(vm)via=vm[1];}
    else if(/(\d) stop/i.test(block))stops=parseInt(block.match(/(\d) stop/i)[1]);
    const airline=lines.slice(Math.max(0,i-2),i+8).find(l=>l.length>=3&&l.length<=50&&!/^\d|EUR|€|stop|nonstop|hr|min|\d:\d|\+\d|Select|Book/i.test(l)&&/[A-Za-z]{3}/.test(l))||'Unknown';
    results.push({airline,depTime:times[0],arrTime:times[1],dur,stops,via,priceNum,price:'EUR '+pm[1]});
    i+=6;
  }
  return results.slice(0,10).map(f=>({
    from,to,fromCode:from,toCode:to,airline:f.airline,
    dur:f.dur,stops:f.stops,via:f.via,price:f.price,numPrice:f.priceNum,
    dep:fmtDate(depart)+(f.depTime?' '+f.depTime:''),
    ret:fmtDate(ret)+(f.arrTime?' '+f.arrTime:''),
    depDate:depart,retDate:ret,stayLabel:stayDays(depart,ret),cabin,real:true,buyUrl:url,
  }));
}

async function doSearch(page, from, to, depart, ret, cabin) {
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if(!/economy/i.test(cabin)){
    try{const cb=page.locator('button').filter({hasText:/^Economy$/}).first();if(await cb.isVisible({timeout:2000})){await cb.click();await sleep(400);await page.locator('[role="option"],li').filter({hasText:new RegExp('^'+cabin+'$','i')}).first().click();await sleep(400);}}catch{}
  }
  const oi=page.locator('input[placeholder*="Where from"],input[aria-label*="Where from"]').first();
  await oi.click();await sleep(300);await page.keyboard.press('Control+a');
  for(const ch of from)await page.keyboard.type(ch,{delay:80});
  await sleep(2000);await page.keyboard.press('ArrowDown');await sleep(300);await page.keyboard.press('Enter');await sleep(800);
  const di=page.locator('input[placeholder*="Where to"],input[aria-label*="Where to"]').first();
  await di.click();await sleep(300);
  for(const ch of to)await page.keyboard.type(ch,{delay:80});
  await sleep(2000);await page.keyboard.press('ArrowDown');await sleep(300);await page.keyboard.press('Enter');await sleep(800);
  try{const inp=page.locator('[aria-label="Departure"],input[placeholder="Departure"]').first();if(await inp.isVisible({timeout:2000})){await inp.click();await sleep(300);await page.keyboard.press('Control+a');const d=new Date(depart+'T12:00:00');await page.keyboard.type(M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear(),{delay:50});await sleep(700);await page.keyboard.press('Tab');await sleep(300);}}catch{}
  try{const inp=page.locator('[aria-label="Return"],input[placeholder="Return"]').first();if(await inp.isVisible({timeout:2000})){await inp.click();await sleep(300);await page.keyboard.press('Control+a');const d=new Date(ret+'T12:00:00');await page.keyboard.type(M[d.getMonth()]+' '+d.getDate()+' '+d.getFullYear(),{delay:50});await sleep(700);}}catch{}
  try{const done=page.getByRole('button',{name:'Done'}).last();if(await done.isVisible({timeout:1500})){await done.click();await sleep(500);}}catch{}
  try{const sb=page.getByRole('button',{name:/^(Search|Explore)$/i}).last();await sb.waitFor({state:'visible',timeout:5000});await sb.click();}catch{await page.keyboard.press('Enter');}
  await page.waitForLoadState('networkidle',{timeout:35000}).catch(()=>{});
  await waitForFlights(page);
  await sleep(2000);
}

async function scrapeRoute({from,to,depart,ret,cabin='Business'}) {
  const page = await newPage();
  try {
    await goToFlights(page);
    await doSearch(page,from,to,depart,ret,cabin);
    const resultUrl=page.url();
    const pageText=await page.evaluate(()=>document.body.innerText);
    console.log('[FSX]',from,'->',to,'text:',pageText.length,'url:',resultUrl.slice(0,70));
    console.log('[FSX] snippet:', pageText.slice(0,300).replace(/\n/g,' '));
    const flights=extractFlights(pageText,from,to,depart,ret,cabin,resultUrl);
    console.log('[FSX] found',flights.length,'flights');
    return flights;
  } finally { await page.context().close().catch(()=>{}); }
}

// /peek — returns raw page text for debugging
app.get('/peek', async (req,res) => {
  const {from='ZRH',to='SIN',depart='2027-02-01',ret='2027-05-01',cabin='Business'} = req.query;
  const page = await newPage();
  try {
    await goToFlights(page);
    await doSearch(page,from,to,depart,ret,cabin);
    const url=page.url();
    const text=await page.evaluate(()=>document.body.innerText);
    res.json({url,textLength:text.length,text:text.slice(0,4000)});
  } catch(e){res.json({error:e.message});}
  finally{await page.context().close().catch(()=>{});}
});

const EU_HUBS=[{code:'ZRH',name:'Zurich'},{code:'FRA',name:'Frankfurt'},{code:'CDG',name:'Paris'},{code:'LHR',name:'London'},{code:'AMS',name:'Amsterdam'},{code:'VIE',name:'Vienna'},{code:'BCN',name:'Barcelona'},{code:'FCO',name:'Rome'}];
const AS_AIRPORTS=[{code:'NRT',name:'Tokyo'},{code:'ICN',name:'Seoul'},{code:'SIN',name:'Singapore'},{code:'BKK',name:'Bangkok'},{code:'HKG',name:'Hong Kong'},{code:'KUL',name:'Kuala Lumpur'},{code:'PVG',name:'Shanghai'},{code:'HAN',name:'Hanoi'},{code:'SGN',name:'Ho Chi Minh'},{code:'MNL',name:'Manila'},{code:'TPE',name:'Taipei'},{code:'CGK',name:'Jakarta'}];

app.get('/health',(req,res)=>res.json({status:'FSX scraper online',version:'8.0'}));
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
  for(const org of origins){for(const dst of dests){try{const r=await scrapeRoute({from:org.code,to:dst.code,depart,ret,cabin});r.forEach(x=>{x.from=org.name;x.to=dst.name;});all.push(...r);await sleep(2500);}catch(e){console.error('[FSX]',org.code,'->',dst.code,e.message.slice(0,50));}}}
  all.sort((a,b)=>a.numPrice-b.numPrice);
  const seen={};all.forEach(r=>{const k=r.fromCode+'-'+r.toCode;if(!seen[k]){r.best=true;seen[k]=true;}});
  res.json({ok:true,count:all.length,results:all.slice(0,30)});
});
app.listen(PORT,()=>console.log('[FSX] Server v8 on port',PORT));
