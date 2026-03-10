/**
 * FSX · Flight Scout — Scraper Server
 * Scrapes Google Flights using Playwright (no API keys needed)
 * Deploy free on Railway: railway.app
 */

const express  = require('express');
const cors     = require('cors');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Browser singleton (reused across requests) ──────────────────────────────
let browser = null;
let launching = false;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) {
    // wait up to 15s for concurrent launch
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (browser && browser.isConnected()) return browser;
    }
  }
  launching = true;
  console.log('[FSX] Launching browser…');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,800',
    ],
  });
  launching = false;
  console.log('[FSX] Browser ready');
  return browser;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtDate(isoStr) {
  const d = new Date(isoStr + 'T12:00:00');
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${mons[d.getMonth()]} ${d.getFullYear()}`;
}

function stayDays(dep, ret) {
  const a = new Date(dep + 'T12:00:00');
  const b = new Date(ret + 'T12:00:00');
  const d = Math.round((b - a) / 86400000);
  const w = Math.round(d / 7);
  return w > 0 ? `${w} wks (${d}d)` : `${d}d`;
}

// ── Core: scrape one route/date ──────────────────────────────────────────────
async function scrapeRoute({ from, to, depart, ret, cabin }) {
  const cabinMap = { Economy: 1, Business: 3, First: 4 };
  const travelClass = cabinMap[cabin] || 3;

  // Build Google Flights URL with parameters
  // We load the search results page directly via the tfs URL parameter
  const b   = await getBrowser();
  const page = await b.newPage();

  // Stealth: mask automation signals
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });

  try {
    // ── 1. Load Google Flights homepage ──────────────────────────────────────
    const url = `https://www.google.com/travel/flights?hl=en&curr=EUR`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // ── 2. Accept cookies if present ─────────────────────────────────────────
    try {
      const acceptBtn = page.locator('button').filter({ hasText: /Accept all|I agree|Agree/i }).first();
      if (await acceptBtn.isVisible({ timeout: 3000 })) {
        await acceptBtn.click();
        await sleep(1000);
      }
    } catch {}

    // ── 3. Set cabin class ───────────────────────────────────────────────────
    // Click the cabin class dropdown (shows "Economy" by default)
    try {
      const cabinDropdown = page.locator('[data-value="1"], .cabin-class-selector, [aria-label*="cabin"], [aria-label*="class"]').first();
      // Try clicking the dropdown button that shows current class
      await page.locator('button').filter({ hasText: /Economy|Business|First/i }).first().click({ timeout: 5000 });
      await sleep(500);
      // Select desired class
      await page.locator('li, [role="option"]').filter({ hasText: new RegExp(cabin, 'i') }).first().click({ timeout: 3000 });
      await sleep(500);
    } catch (e) {
      console.log('[FSX] Cabin class set failed (continuing):', e.message.slice(0, 60));
    }

    // ── 4. Fill origin ───────────────────────────────────────────────────────
    const originInput = page.locator('input[placeholder*="Where from"], input[aria-label*="Where from"], input[aria-label*="From"]').first();
    await originInput.click({ timeout: 10000 });
    await originInput.selectAll?.() || await originInput.triple_click?.();
    await page.keyboard.press('Control+A');
    await originInput.fill('');
    await sleep(300);
    await originInput.type(from, { delay: 80 });
    await sleep(1500);

    // Select first suggestion
    try {
      await page.locator('[role="option"], [role="listitem"], .zsRT0d').first().click({ timeout: 4000 });
    } catch {
      await page.keyboard.press('Enter');
    }
    await sleep(700);

    // ── 5. Fill destination ──────────────────────────────────────────────────
    const destInput = page.locator('input[placeholder*="Where to"], input[aria-label*="Where to"], input[aria-label*="Destination"]').first();
    await destInput.click({ timeout: 10000 });
    await destInput.fill('');
    await sleep(300);
    await destInput.type(to, { delay: 80 });
    await sleep(1500);
    try {
      await page.locator('[role="option"], [role="listitem"], .zsRT0d').first().click({ timeout: 4000 });
    } catch {
      await page.keyboard.press('Enter');
    }
    await sleep(700);

    // ── 6. Set departure date ────────────────────────────────────────────────
    // Click first date button
    try {
      const dateBtn = page.locator('input[placeholder*="Departure"], [data-placeholder*="Depart"], .TP4Lpb').first();
      await dateBtn.click({ timeout: 5000 });
      await sleep(800);

      // Navigate to correct month and click date
      const depDate  = new Date(depart + 'T12:00:00');
      const retDate  = new Date(ret    + 'T12:00:00');

      // Type departure date directly if input accepts it
      const dateInputs = page.locator('input[type="text"][placeholder*="mm"]');
      const count = await dateInputs.count();
      if (count >= 2) {
        await dateInputs.nth(0).fill(depart);
        await dateInputs.nth(1).fill(ret);
      } else {
        // Use calendar click approach
        await clickCalendarDate(page, depDate);
        await sleep(500);
        await clickCalendarDate(page, retDate);
      }
      await sleep(500);

      // Click "Done" button if present
      try {
        await page.locator('button').filter({ hasText: /Done|OK|Confirm/i }).first().click({ timeout: 3000 });
      } catch {}
    } catch (e) {
      console.log('[FSX] Date set failed:', e.message.slice(0, 80));
    }

    // ── 7. Click Search ──────────────────────────────────────────────────────
    await sleep(600);
    try {
      const searchBtn = page.locator('button[aria-label*="Search"], button').filter({ hasText: /^Search$/ }).first();
      await searchBtn.click({ timeout: 8000 });
    } catch {
      // Try pressing Enter as fallback
      await page.keyboard.press('Enter');
    }

    // ── 8. Wait for results ──────────────────────────────────────────────────
    console.log(`[FSX] Waiting for results: ${from}→${to} ${depart}`);
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await sleep(3000);

    // ── 9. Parse results ─────────────────────────────────────────────────────
    const flights = await page.evaluate((params) => {
      const results = [];

      // Google Flights result cards use various class patterns
      // Try multiple selector strategies
      const cardSelectors = [
        '.pIav2d',           // flight result card
        '[role="listitem"]', // generic list items
        '.yR1fYc',           // another common pattern
        '.Rk10dc',
        '.QSDmAb',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 1) { cards = Array.from(found); break; }
      }

      cards.slice(0, 8).forEach(card => {
        try {
          const txt = card.innerText || '';
          if (!txt || txt.length < 20) return;

          const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);

          // Extract price — look for EUR / € amount
          let price = null;
          const priceMatch = txt.match(/(?:EUR\s*|€\s*)([\d,]+)/i) || txt.match(/([\d,]+)\s*(?:EUR|€)/i);
          if (priceMatch) price = 'EUR ' + priceMatch[1].replace(',', '');

          // Extract airline — first meaningful line that looks like an airline name
          let airline = lines[0] || '';

          // Extract times — HH:MM patterns
          const times = [...txt.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => m[1]);
          const depTime = times[0] || '';
          const arrTime = times[1] || '';

          // Extract duration — "Xhr Ymin" or "X hr Y min"
          const durMatch = txt.match(/(\d+)\s*hr\s*(\d+)?\s*min?/) ||
                           txt.match(/(\d+)h\s*(\d+)?m?/);
          const dur = durMatch ? `${durMatch[1]}h${durMatch[2]?durMatch[2]+'m':''}` : '';

          // Extract stops
          let stops = 0;
          let via = '';
          if (/nonstop|direct/i.test(txt)) stops = 0;
          else if (/1 stop/i.test(txt)) {
            stops = 1;
            const viaM = txt.match(/1 stop\s*\(([^)]+)\)/i);
            if (viaM) via = viaM[1];
          } else if (/(\d+) stops?/i.test(txt)) {
            stops = parseInt(txt.match(/(\d+) stops?/i)[1]);
          }

          if (price && airline && depTime) {
            results.push({ airline, depTime, arrTime, dur, stops, via, price, raw: lines.slice(0,6).join(' | ') });
          }
        } catch {}
      });

      return results;
    }, { from, to, depart, ret });

    console.log(`[FSX] Got ${flights.length} results for ${from}→${to}`);

    return flights.map(f => ({
      from: params?.fromName || from,
      to:   params?.toName   || to,
      fromCode: from,
      toCode:   to,
      airline:  f.airline,
      depTime:  f.depTime,
      arrTime:  f.arrTime,
      dur:      f.dur,
      stops:    f.stops,
      via:      f.via,
      price:    f.price,
      numPrice: parseFloat((f.price || '0').replace(/[^0-9.]/g, '')) || 0,
      dep:      `${fmtDate(depart)} ${f.depTime}`,
      ret:      `${fmtDate(ret)} ${f.arrTime}`,
      stayLabel: stayDays(depart, ret),
      depart, ret, cabin,
      lounge: ['Business','First'].includes(cabin),
      flat:   ['Business','First'].includes(cabin),
      real:   true,
      buyUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(`flights from ${from} to ${to} ${depart} return ${ret}`)}`,
    }));

  } finally {
    await page.close().catch(() => {});
  }
}

// ── Calendar helper: click a specific date in Google Flights calendar ────────
async function clickCalendarDate(page, date) {
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const targetMonth = monthNames[date.getMonth()];
  const targetYear  = date.getFullYear();
  const targetDay   = date.getDate();

  // Navigate forward until we see the right month
  for (let attempt = 0; attempt < 12; attempt++) {
    const calText = await page.locator('.bOzv6, [role="dialog"], .VfPpkd-WsjYwc').textContent().catch(() => '');
    if (calText.includes(targetMonth) && calText.includes(String(targetYear))) break;
    await page.locator('button[aria-label*="Next month"], button[aria-label*="next"]').first().click().catch(() => {});
    await sleep(400);
  }

  // Click the day
  try {
    await page.locator(`[aria-label*="${targetMonth} ${targetDay}"], [data-day="${targetDay}"]`).first().click({ timeout: 3000 });
  } catch {
    // Fallback: find cell by text
    await page.locator(`.VfPpkd-RLmnJb, [role="gridcell"]`).filter({ hasText: new RegExp(`^${targetDay}$`) }).first().click({ timeout: 3000 });
  }
}

// ── Route list (same as FCF) ──────────────────────────────────────────────────
const EU_HUBS = [
  { code:'ZRH', name:'Zurich'    },
  { code:'FRA', name:'Frankfurt' },
  { code:'CDG', name:'Paris'     },
  { code:'LHR', name:'London'    },
  { code:'AMS', name:'Amsterdam' },
  { code:'VIE', name:'Vienna'    },
  { code:'BCN', name:'Barcelona' },
  { code:'FCO', name:'Rome'      },
];

const AS_AIRPORTS = [
  { code:'NRT', name:'Tokyo'          },
  { code:'ICN', name:'Seoul'          },
  { code:'SIN', name:'Singapore'      },
  { code:'BKK', name:'Bangkok'        },
  { code:'HKG', name:'Hong Kong'      },
  { code:'KUL', name:'Kuala Lumpur'   },
  { code:'PVG', name:'Shanghai'       },
  { code:'HAN', name:'Hanoi'          },
  { code:'SGN', name:'Ho Chi Minh'    },
  { code:'MNL', name:'Manila'         },
  { code:'TPE', name:'Taipei'         },
  { code:'CGK', name:'Jakarta'        },
];

// ── Endpoint: single route scrape ─────────────────────────────────────────────
app.get('/scrape', async (req, res) => {
  const { from, to, depart, ret, cabin='Business', fromName, toName } = req.query;
  if (!from || !to || !depart || !ret) {
    return res.status(400).json({ error: 'from, to, depart, ret required' });
  }
  try {
    const results = await scrapeRoute({ from, to, depart, ret, cabin,
      params: { fromName, toName } });
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[FSX] scrape error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Endpoint: batch scan (all EU hubs → all Asian dest) ───────────────────────
app.get('/scan', async (req, res) => {
  const {
    fromCode,  // specific EU hub, or 'ALL'
    toCode,    // specific Asian dest, or 'ALL'
    depart,
    ret,
    cabin = 'Business',
  } = req.query;

  if (!depart || !ret) return res.status(400).json({ error: 'depart and ret required' });

  const origins = fromCode === 'ALL' || !fromCode
    ? EU_HUBS : EU_HUBS.filter(h => h.code === fromCode);
  const dests   = toCode === 'ALL' || !toCode
    ? AS_AIRPORTS : AS_AIRPORTS.filter(a => a.code === toCode);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');

  const all = [];

  for (const org of origins) {
    for (const dst of dests) {
      try {
        console.log(`[FSX] Scanning ${org.code}→${dst.code}`);
        const results = await scrapeRoute({
          from: org.code, to: dst.code,
          depart, ret, cabin,
          params: { fromName: org.name, toName: dst.name },
        });
        results.forEach(r => {
          r.from = org.name;
          r.to   = dst.name;
          all.push(r);
        });
        // Small pause between requests
        await sleep(2000);
      } catch (e) {
        console.error(`[FSX] Failed ${org.code}→${dst.code}:`, e.message.slice(0, 60));
      }
    }
  }

  // Sort by price
  all.sort((a, b) => a.numPrice - b.numPrice);
  all.slice(0, 20).forEach((r, i) => { r.best = i === 0; });

  res.json({ ok: true, count: all.length, results: all.slice(0, 20) });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'FSX scraper online', version: '1.0' }));

app.listen(PORT, () => console.log(`[FSX] Server running on port ${PORT}`));
