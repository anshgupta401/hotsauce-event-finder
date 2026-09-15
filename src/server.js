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
};

// ── Helper: does this link actually look like an event page? ────────────────
// Matching "event" anywhere in a URL is too loose — sites like eventeny.com
// have "event" baked into their own domain, so nav links (Sign in, Blog,
// Help Center) all contain the substring "event" without being event pages
// at all. We require an actual "/event/" or "/events/" PATH segment, and
// filter out obvious navigation/marketing link text.
const NAV_TEXT_BLOCKLIST = /^(sign in|log ?in|sign ?up|log ?out|blog|help( center)?|pricing|about( us)?|contact( us)?|terms|privacy|faq|sitemap|compare|case stud(y|ies)|home|resources?|features?|solutions?|product|company)$/i;

function looksLikeEventLink(href, linkText) {
  let pathname;
  try { pathname = new URL(href, 'https://x').pathname; } catch (e) { return false; }
  const hasEventPath = /\/events?\//i.test(pathname) || /\/events?\/vendor\//i.test(pathname);
  if (!hasEventPath) return false;
  if (linkText && NAV_TEXT_BLOCKLIST.test(linkText.trim())) return false;
  return true;
}

// ── Shared helper: fetch a page and return { $, fullText, html } ────────────
async function fetchPage(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(resp.data);
  const fullText = $('body').text().replace(/\s+/g, ' ').trim();
  return { $, fullText };
}

// ── Shared helper: pull every JSON-LD Event object out of a loaded page ─────
function extractJsonLdEvents($) {
  const events = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      candidates.forEach(item => {
        if (item && item['@type'] === 'Event') events.push(item);
      });
    } catch (e) {
      // skip invalid JSON blocks
    }
  });
  return events;
}

// ── Shared helper: full detail extraction for ONE event page ────────────────
// This is the core scraper logic, used both when the person scans a single
// event URL directly, and when we're crawling a listing page and visiting
// each event's own page to fill in richer details.
function extractEventDetails($, fullText, url, jsonLdEvent) {
  // ── Event name ──
  const eventName =
    (jsonLdEvent && jsonLdEvent.name) ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    null;

  // ── Event description ──
  const description =
    $('meta[property="og:description"]').attr('content') ||
    (jsonLdEvent && jsonLdEvent.description) ||
    $('meta[name="description"]').attr('content') ||
    null;

  // ── Date, time, cost ──
  let eventDate = null;
  let eventTime = null;
  let cost = null;
  let eventCategoryFromDetails = null;

  const detailsMatch = fullText.match(
    /Details\s*Date:\s*(.+?)\s*Time:\s*(.+?)\s*Cost:\s*(.+?)\s*Event Category:\s*(.+?)(?=\s*Organizer|\s*Venue|$)/
  );
  if (detailsMatch) {
    eventDate = detailsMatch[1].trim();
    eventTime = detailsMatch[2].trim();
    cost = detailsMatch[3].trim();
    eventCategoryFromDetails = detailsMatch[4].trim();
  }

  if (!eventDate && jsonLdEvent && jsonLdEvent.startDate) {
    const start = new Date(jsonLdEvent.startDate);
    if (!isNaN(start)) {
      eventDate = start.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      eventTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  }

  if (!cost && jsonLdEvent && Array.isArray(jsonLdEvent.offers) && jsonLdEvent.offers.length) {
    const prices = jsonLdEvent.offers.map(o => parseFloat(o.price)).filter(p => !isNaN(p));
    if (prices.length) {
      const min = Math.min(...prices).toFixed(2);
      const max = Math.max(...prices).toFixed(2);
      cost = min === max ? `$${min}` : `$${min} – $${max}`;
    }
  }

  if (!eventDate) {
    const genericDate = fullText.match(/(?:Date|When)[:\s]+([A-Z][a-z]+\.?\s+\d{1,2},?\s*\d{4})/);
    if (genericDate) eventDate = genericDate[1].trim();
  }
  if (!eventTime) {
    const genericTime = fullText.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
    if (genericTime) eventTime = genericTime[1].trim();
  }
  if (!cost) {
    const genericCost = fullText.match(/(?:Cost|Price|Tickets?)[:\s]+(\$[\d,.]+(?:\s*[-–]\s*\$[\d,.]+)?|Free)/i);
    if (genericCost) {
      cost = genericCost[1].trim();
    } else {
      const anyPrice = fullText.match(/\$[\d,]+\.\d{2}(?:\s*[-–]\s*\$[\d,]+\.\d{2})?/);
      if (anyPrice) cost = anyPrice[0];
    }
  }

  // ── Duration ──
  let duration = null;
  if (jsonLdEvent && jsonLdEvent.startDate && jsonLdEvent.endDate) {
    const start = new Date(jsonLdEvent.startDate);
    const end = new Date(jsonLdEvent.endDate);
    if (!isNaN(start) && !isNaN(end) && end > start) {
      const totalHours = (end - start) / (1000 * 60 * 60);
      const days = Math.floor(totalHours / 24);
      const hours = Math.round((totalHours % 24) * 10) / 10;
      if (days > 0) {
        duration = `${days} day${days !== 1 ? 's' : ''}${hours > 0 ? `, ${hours} hr` : ''}`;
      } else {
        duration = `${hours} hour${hours !== 1 ? 's' : ''}`;
      }
    }
  }

  // ── Venue / location ──
  let location = null;
  const venueMatch = fullText.match(/Venue\s*(.+?)\s*\+\s*Google Map/);
  if (venueMatch) {
    location = venueMatch[1].trim();
  } else if (jsonLdEvent && jsonLdEvent.location) {
    const loc = jsonLdEvent.location;
    const addr = loc.address || {};
    const parts = [
      loc.name,
      addr.streetAddress,
      [addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(' '),
      addr.addressCountry,
    ].filter(Boolean);
    location = parts.join(', ');
  } else {
    const genericLoc = fullText.match(/(?:Location|Address|Venue)[:\s]+([^.]{5,90}?)(?=\s{2,}|\.\s|$)/i);
    if (genericLoc) location = genericLoc[1].trim();
  }

  // ── Organizer / contact ──
  let contact = null;
  const emailMatch = fullText.match(/Email\s+([\w.+-]+@[\w.-]+\.\w{2,})/i);
  if (emailMatch) {
    contact = emailMatch[1];
  } else if (jsonLdEvent && jsonLdEvent.organizer && jsonLdEvent.organizer.email) {
    contact = jsonLdEvent.organizer.email;
  } else {
    const anyEmail = fullText.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    contact = anyEmail ? anyEmail[0] : null;
  }

  // ── Category ──
  const catLink =
    eventCategoryFromDetails ||
    (jsonLdEvent && (jsonLdEvent.category || (Array.isArray(jsonLdEvent.keywords) ? jsonLdEvent.keywords[0] : jsonLdEvent.keywords))) ||
    $('a[href*="/category/"]').first().text().trim() ||
    $('a[href*="/events/category/"]').first().text().trim() ||
    null;

  // ── Health permit mention ──
  const healthPermit = /health permit|food permit|food handler/i.test(fullText)
    ? 'Likely required'
    : 'Check with organizer';

  // ── Application deadline ──
  const deadlineMatch = fullText.match(/deadline[:\s]+([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i);
  const applicationDeadline = deadlineMatch ? deadlineMatch[1] : null;

  // ── Additional requirements ──
  const requirements = [];
  if (/bring your own tent|responsible for.*tent/i.test(fullText)) requirements.push('Bring your own tent & weights');
  if (/electricity.*not included|electricity.*not provided/i.test(fullText)) requirements.push('Electricity not included (rent separately)');
  if (/tables.*not provided|food concession.*not.*table/i.test(fullText)) requirements.push('Tables not provided for food vendors');
  if (/booth accessory form/i.test(fullText)) requirements.push('Booth accessory form required for rentals');
  if (/50%.*deposit/i.test(fullText)) requirements.push('50% deposit required upon acceptance');
  if (/insurance/i.test(fullText)) requirements.push('Proof of insurance may be required');

  // ── Notes ──
  const hasVendorInfo = /exhibitor|vendor application|sponsor/i.test(fullText);
  const notes = hasVendorInfo
    ? `This event accepts vendors/exhibitors.${contact ? ` Contact ${contact} to apply.` : ' Check the site for a vendor/exhibitor application page.'} Booth assignments are typically given upon arrival.`
    : null;

  let sourceSite = null;
  try { sourceSite = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}

  // ── Booth/vendor cost note ──
  // If the JSON-LD's own offers block looks like it represents booth/vendor
  // tiers (named options rather than a single ticket price), we already
  // have a real number in `cost` above — no separate booth cost object is
  // needed. Otherwise, tell the person where to look instead of guessing.
  const offersLookLikeVendorTiers =
    jsonLdEvent && Array.isArray(jsonLdEvent.offers) && jsonLdEvent.offers.some(o => o && o.name);

  const vendorInfoNote = offersLookLikeVendorTiers
    ? `This site lists vendor/booth pricing directly: ${cost || 'see the source page for tiered pricing'}.`
    : (sourceSite && sourceSite.includes('drinkeatrelax'))
      ? 'Booth/table pricing is not listed on this page. Check der411.com for the current vendor application PDF, or contact ' + (contact || 'the organizer') + '.'
      : `Booth/table pricing usually isn't listed on the event page itself. Look for an "Exhibitor," "Vendor," or "Sponsor" link on ${sourceSite || 'this site'}, or contact ${contact || 'the organizer'} directly.`;

  return {
    event_name: eventName,
    event_description: description,
    event_date: eventDate,
    event_time: eventTime,
    event_duration: duration,
    location,
    ticket_price: cost,
    application_deadline: applicationDeadline,
    health_permit_required: healthPermit,
    event_type: catLink,
    organizer_contact: contact,
    additional_requirements: requirements,
    notes,
    website: url,
    source_site: sourceSite,
    vendor_info_note: vendorInfoNote,
  };
}

// ── Unified crawl endpoint ────────────────────────────────────────────────
// One input, works for both a single event page AND a listing page full of
// events. It figures out which one it's looking at automatically:
//   - One JSON-LD Event on the page, few other event links  -> single event
//   - Multiple JSON-LD Event blocks on the page              -> listing
//   - No JSON-LD, but several links to other event pages     -> listing
//     (crawls each linked page for full details)
//   - No JSON-LD, no listing links, but plain-text event
//     details found on the page itself                       -> single event
//   - None of the above                                       -> no events found
app.post('/api/crawl', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const MAX_LIST_ITEMS = 12; // cap how many individual pages we visit per crawl
  const MAX_LIST_PAGES = 4;  // cap how many listing pages we paginate through

  try {
    const { $, fullText } = await fetchPage(url);
    const jsonLdEvents = extractJsonLdEvents($);

    const eventLinks = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text();
      if (!href) return;
      let absolute = href;
      try { absolute = new URL(href, url).toString(); } catch (e) { return; }
      if (absolute === url) return;
      if (!looksLikeEventLink(absolute, text)) return;
      if (!eventLinks.includes(absolute)) eventLinks.push(absolute);
    });

    // ── Case 1: exactly one JSON-LD event and this doesn't look like a
    // listing page -> treat this page itself as a single event.
    if (jsonLdEvents.length === 1 && eventLinks.length <= 2) {
      const details = extractEventDetails($, fullText, url, jsonLdEvents[0]);
      return res.json({ mode: 'single', events: [details], total_found: 1 });
    }

    // ── Case 2: multiple JSON-LD events on one page -> this IS a listing.
    // Visit each event's own page (best-effort link match by position) to
    // get the full rich detail set, not just the lightweight teaser data.
    if (jsonLdEvents.length > 1) {
      const toVisit = jsonLdEvents.slice(0, MAX_LIST_ITEMS);
      const results = [];

      for (let i = 0; i < toVisit.length; i++) {
        const item = toVisit[i];
        let eventUrl = item.url || eventLinks[i] || null;
        if (eventUrl) {
          try { eventUrl = new URL(eventUrl, url).toString(); } catch (e) { eventUrl = null; }
        }

        if (eventUrl) {
          try {
            const page = await fetchPage(eventUrl);
            const pageJsonLd = extractJsonLdEvents(page.$);
            const matchingEvent = pageJsonLd.find(e => e.name === item.name) || pageJsonLd[0] || item;
            results.push(extractEventDetails(page.$, page.fullText, eventUrl, matchingEvent));
          } catch (e) {
            // that individual page failed to load — fall back to the
            // lightweight teaser data instead of dropping the event entirely
            results.push(extractEventDetails($, fullText, eventUrl || url, item));
          }
        } else {
          results.push(extractEventDetails($, fullText, url, item));
        }

        await new Promise(r => setTimeout(r, 200)); // be polite to the server
      }

      return res.json({ mode: 'list', events: results, total_found: jsonLdEvents.length });
    }

    // ── Case 3: no JSON-LD here, but this page links out to several event
    // pages -> crawl those pages directly (and follow simple pagination).
    if (eventLinks.length >= 2) {
      const visited = new Set();
      const results = [];
      let linksToTry = eventLinks.slice(0, MAX_LIST_ITEMS);
      let currentListUrl = url;

      for (let page = 0; page < MAX_LIST_PAGES && results.length < MAX_LIST_ITEMS; page++) {
        for (const link of linksToTry) {
          if (results.length >= MAX_LIST_ITEMS || visited.has(link)) continue;
          visited.add(link);
          try {
            const eventPage = await fetchPage(link);
            const pageJsonLd = extractJsonLdEvents(eventPage.$);
            const details = extractEventDetails(eventPage.$, eventPage.fullText, link, pageJsonLd[0] || null);
            // Only keep this as a real event if it has actual event-specific
            // data — a name alone isn't enough, since that would also match
            // a stray "Sign in" or "Blog" page that slipped through the
            // link filter.
            const looksLikeRealEvent = details.event_name && (details.event_date || details.ticket_price || pageJsonLd.length > 0);
            if (looksLikeRealEvent) results.push(details);
          } catch (e) {
            // skip pages that fail to load
          }
          await new Promise(r => setTimeout(r, 200));
        }

        // try to find a next page of the listing itself
        break; // pagination for link-only listings kept simple for now
      }

      if (results.length > 0) {
        return res.json({ mode: 'list', events: results, total_found: results.length });
      }
    }

    // ── Case 4: no JSON-LD, no useful links — but maybe this page itself
    // has plain-text event details (drinkeatrelax-style or generic).
    const hasTextDetails =
      /Details\s*Date:/.test(fullText) ||
      /(?:Date|When)[:\s]+[A-Z][a-z]+\.?\s+\d{1,2}/.test(fullText);

    if (hasTextDetails) {
      const details = extractEventDetails($, fullText, url, null);
      return res.json({ mode: 'single', events: [details], total_found: 1 });
    }

    // ── Nothing found ──
    return res.json({
      mode: 'no_events',
      events: [],
      message: 'No events found on this page. Try a more specific event page or a listing/category page URL.',
    });

  } catch (err) {
    console.error('Crawl error:', err.message);
    if (err.response?.status === 403) {
      return res.status(502).json({ error: 'The website blocked our request. Try again in a moment.' });
    }
    return res.status(502).json({ error: 'Could not fetch that page. Check the URL and try again.' });
  }
});

// ── Serve frontend for any other route ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌶  Hot Sauce Event Finder running!`);
  console.log(`   Open in browser: http://localhost:${PORT}\n`);
});