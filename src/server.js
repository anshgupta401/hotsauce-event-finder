const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchPage(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return cheerio.load(res.data);
}

function resolveUrl(base, href) {
  try { return new URL(href, base).href; } catch { return null; }
}

function isEventLink(href, text) {
  const url = href.toLowerCase();
  const txt = (text || '').toLowerCase();
  const urlPatterns = ['/event/', '/events/', '/festival/', '/market/', '/fair/', '/expo/', '/vendor/', '/calendar/', '/shows/', '/schedule/', 'eventbrite.com', '/tickets/', '/listing/'];
  const textPatterns = ['festival', 'market', 'fair', 'expo', 'event', 'show', 'tickets', 'bbq', 'beer', 'wine', 'food', 'taco', 'oyster', 'oktoberfest'];
  return urlPatterns.some(p => url.includes(p)) || textPatterns.some(p => txt.includes(p));
}

function extractEventDetails($, url, fullText) {
  // Name
  const eventName =
    $('h1.tribe-events-single-event-title').text().trim() ||
    $('h1.entry-title').text().trim() ||
    $('h1').first().text().trim() ||
    $('title').text().split('|')[0].trim() ||
    null;

  // Date + time
  let eventDate = null, eventTime = null;
  const schedText = $('.tribe-events-schedule, .tribe-event-schedule-details').text().replace(/\s+/g, ' ').trim();
  if (schedText) {
    const m = schedText.match(/^([\w\s,]+\d{4})\s*@\s*(.+)$/);
    if (m) { eventDate = m[1].trim(); eventTime = m[2].trim(); }
    else { eventDate = schedText; }
  }

  // Schema.org
  if (!eventDate) {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const schema = Array.isArray(data) ? data[0] : data;
        if (schema.startDate) {
          const d = new Date(schema.startDate);
          if (!isNaN(d)) {
            eventDate = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            eventTime = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          }
        }
      } catch {}
    });
  }

  // Text fallback
  if (!eventDate) {
    const dm = fullText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/);
    if (dm) eventDate = dm[0];
  }
  if (!eventTime) {
    const tm = fullText.match(/\b(\d{1,2}:\d{2}\s*[aApP][mM])\s*[-–]\s*(\d{1,2}:\d{2}\s*[aApP][mM])\b/);
    if (tm) eventTime = tm[0];
  }

  // Location
  let location = null;
  const venueName = $('.tribe-venue, .venue-name').first().text().trim();
  const streetAddr = $('.tribe-street-address, [itemprop="streetAddress"]').text().trim();
  const city = $('.tribe-city, [itemprop="addressLocality"]').text().trim();
  const state = $('.tribe-stateprovince, [itemprop="addressRegion"]').text().trim();
  const zip = $('.tribe-zip, [itemprop="postalCode"]').text().trim();
  if (venueName) {
    const parts = [venueName];
    if (streetAddr) parts.push(streetAddr);
    const cityLine = [city, state, zip].filter(Boolean).join(' ');
    if (cityLine) parts.push(cityLine);
    location = parts.join(', ');
  }
  if (!location) {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const schema = JSON.parse($(el).html());
        const s = Array.isArray(schema) ? schema[0] : schema;
        if (s.location) {
          const loc = s.location;
          const parts = [loc.name, loc.address?.streetAddress, loc.address?.addressLocality, loc.address?.addressRegion].filter(Boolean);
          if (parts.length) location = parts.join(', ');
        }
      } catch {}
    });
  }
  if (!location) {
    const am = fullText.match(/\d+\s+[\w\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)[,\s]+[\w\s]+,\s*[A-Z]{2}\s*\d{5}/i);
    if (am) location = am[0].trim();
  }

  // Prices
  const ticketCost = $('.tribe-events-cost, .tribe-cost').first().text().trim() || null;
  let schemaPrice = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const schema = JSON.parse($(el).html());
      const s = Array.isArray(schema) ? schema[0] : schema;
      if (s.offers) {
        const offers = Array.isArray(s.offers) ? s.offers : [s.offers];
        const prices = offers.map(o => o.price).filter(Boolean);
        if (prices.length) schemaPrice = '$' + prices.join(' – $');
      }
    } catch {}
  });
  let textPrice = null;
  if (!ticketCost && !schemaPrice) {
    const pm = fullText.match(/\$\s*\d+(?:\.\d{2})?(?:\s*[-–]\s*\$\s*\d+(?:\.\d{2})?)?/);
    if (pm) textPrice = pm[0];
  }
  const finalCost = ticketCost || schemaPrice || textPrice;

  // Booth fee
  let boothFee = null;
  const bm = fullText.match(/booth\s*(?:fee|cost|price|space)[:\s]+\$?([\d,]+(?:\.\d{2})?)/i);
  if (bm) boothFee = '$' + bm[1];
  const vm = fullText.match(/vendor\s*(?:fee|cost|price)[:\s]+\$?([\d,]+(?:\.\d{2})?)/i);
  if (!boothFee && vm) boothFee = '$' + vm[1];

  // Contact
  const orgEmail = $('a[href^="mailto:"]').first().attr('href')?.replace('mailto:', '').trim() || null;
  const orgPhone = $('.tribe-organizer-tel').first().text().trim() || null;
  let textPhone = null;
  if (!orgPhone) {
    const phm = fullText.match(/\b(\+?1?\s*[-.]?\s*\(?\d{3}\)?\s*[-.]?\s*\d{3}\s*[-.]?\s*\d{4})\b/);
    if (phm) textPhone = phm[1];
  }
  const contact = orgEmail || orgPhone || textPhone || null;

  // Event type
  let eventType = $('a[href*="/events/category/"], a[href*="/category/"]').first().text().trim() || null;
  if (!eventType) {
    if (/beer|bourbon|bbq|barbecue/i.test(fullText)) eventType = 'Beer, Bourbon & BBQ';
    else if (/wine.*food|food.*wine/i.test(fullText)) eventType = 'Wine & Food Festival';
    else if (/taco/i.test(fullText)) eventType = "Tacos N' Taps";
    else if (/oktoberfest/i.test(fullText)) eventType = 'Oktoberfest';
    else if (/oyster/i.test(fullText)) eventType = 'Oyster Festival';
    else if (/farmer.*market|farmers.*market/i.test(fullText)) eventType = 'Farmers Market';
    else if (/food.*truck/i.test(fullText)) eventType = 'Food Truck Event';
    else if (/festival/i.test(fullText)) eventType = 'Festival';
    else if (/craft.*fair|arts.*craft/i.test(fullText)) eventType = 'Craft Fair';
  }

  // Attendance
  let expectedAttendance = null;
  const am2 = fullText.match(/(\d[\d,]+)\s*\+?\s*(guests|attendees|visitors|people|expected)/i);
  if (am2) expectedAttendance = `${am2[1]} ${am2[2]}`;

  // Health permit
  const healthPermit = /health permit|food permit|food handler|temporary food establishment/i.test(fullText)
    ? 'Likely required' : 'Check with organizer';

  // Deadline
  let deadline = null;
  const dlm = fullText.match(/(?:deadline|apply by|applications?\s+(?:due|close)[sd]?)[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s*\d{4})/i);
  if (dlm) deadline = dlm[1];

  // Requirements
  const requirements = [];
  if (/bring your own tent|responsible for.*tent|your own tent/i.test(fullText)) requirements.push('Bring your own tent & weights');
  if (/electricity.*not included|electricity.*not provided|no electricity/i.test(fullText)) requirements.push('Electricity not included');
  if (/tables.*not provided|no tables provided/i.test(fullText)) requirements.push('Tables not provided');
  if (/booth accessory form/i.test(fullText)) requirements.push('Booth accessory form required');
  if (/50%.*deposit|deposit.*50%/i.test(fullText)) requirements.push('50% deposit required on acceptance');
  if (/proof of insurance|certificate of insurance/i.test(fullText)) requirements.push('Proof of insurance required');
  if (/food.*license|temporary food/i.test(fullText)) requirements.push('Food service license required');
  if (/wi-?fi.*not|no wi-?fi/i.test(fullText)) requirements.push('No WiFi provided');
  if (/outdoor/i.test(fullText)) requirements.push('Outdoor event');

  // Notes
  const hasVendorInfo = /exhibitor|vendor application|sponsor|apply.*vendor|vendor.*apply/i.test(fullText);
  let notes = null;
  if (hasVendorInfo) {
    notes = 'Accepts vendors/exhibitors. ';
    if (orgEmail) notes += `Contact ${orgEmail} to apply.`;
    else notes += 'Check the website for vendor application details.';
  }

  // Description
  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    null;

  return {
    event_name: eventName,
    event_date: eventDate,
    event_time: eventTime,
    location,
    ticket_price: finalCost,
    booth_fee: boothFee,
    application_deadline: deadline,
    health_permit_required: healthPermit,
    expected_attendance: expectedAttendance,
    event_type: eventType,
    organizer_contact: contact,
    additional_requirements: requirements,
    notes,
    description: description ? description.slice(0, 250) : null,
    website: url,
  };
}

// ── Crawl a whole site, find all events ───────────────────────────────────────
app.post('/api/crawl', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!url.startsWith('http')) url = 'https://' + url;

  const baseDomain = new URL(url).hostname;

  try {
    console.log(`\nCrawling: ${url}`);
    const $ = await fetchPage(url);
    const fullText = $('body').text().replace(/\s+/g, ' ');

    // Collect all internal links
    const links = new Map();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      const resolved = resolveUrl(url, href);
      if (resolved && resolved.includes(baseDomain) && !resolved.includes('#') && !resolved.match(/\.(pdf|jpg|png|gif|zip|doc)$/i)) {
        links.set(resolved, text);
      }
    });

    // Find event links
    const eventLinks = [];
    for (const [href, text] of links) {
      if (isEventLink(href, text)) eventLinks.push({ href, text });
    }

    const uniqueEventLinks = [...new Map(eventLinks.map(l => [l.href, l])).values()].slice(0, 20);
    console.log(`Found ${uniqueEventLinks.length} event links`);

    // If the landing page itself is an event
    const pageIsEvent = !!fullText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/) && $('h1').length > 0;

    if (uniqueEventLinks.length === 0 && pageIsEvent) {
      const detail = extractEventDetails($, url, fullText);
      return res.json({ mode: 'single', events: [detail] });
    }

    if (uniqueEventLinks.length === 0) {
      return res.json({ mode: 'no_events', events: [], message: 'No event pages found on this site. Try a direct event URL like drinkeatrelax.com/event/...' });
    }

    // Scrape each event page
    const events = [];
    for (const link of uniqueEventLinks) {
      try {
        console.log(`Scraping: ${link.href}`);
        const $e = await fetchPage(link.href);
        const et = $e('body').text().replace(/\s+/g, ' ');
        const detail = extractEventDetails($e, link.href, et);
        if (detail.event_name || detail.event_date) events.push(detail);
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.log(`Skipped ${link.href}: ${err.message}`);
      }
    }

    return res.json({ mode: 'multi', events, total_found: uniqueEventLinks.length });

  } catch (err) {
    console.error('Crawl error:', err.message);
    if (err.response?.status === 403) return res.status(502).json({ error: 'This website blocked our request.' });
    if (err.code === 'ENOTFOUND') return res.status(502).json({ error: 'Could not reach that website. Check the URL.' });
    return res.status(502).json({ error: 'Error: ' + err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n🌶  Hot Sauce Event Finder running!`);
  console.log(`   Open in browser: http://localhost:${PORT}\n`);
});
