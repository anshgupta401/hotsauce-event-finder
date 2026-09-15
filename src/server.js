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
 
// ── Browse endpoint: pulls a whole list of upcoming events at once ───────────
// Works on ANY site's events listing page, not just drinkeatrelax.com — it
// reuses the same JSON-LD detection the single-URL scan uses, since that's
// a widely-adopted standard across event websites. Pagination is detected
// generically (rel="next" links, "Next" buttons, or WordPress-style
// /page/N/ URLs) rather than assuming one site's exact structure.
app.get('/api/events', async (req, res) => {
  const startUrl = req.query.url || 'https://www.drinkeatrelax.com/events/';
  const events = [];
  const seenKeys = new Set();
  const MAX_PAGES = 8;
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
 
  let currentUrl = startUrl;
  let pagesCrawled = 0;
 
  try {
    for (let i = 0; i < MAX_PAGES && currentUrl; i++) {
      let html;
      try {
        const resp = await axios.get(currentUrl, { headers: HEADERS, timeout: 15000 });
        html = resp.data;
      } catch (e) {
        break; // page failed to load — stop here
      }
 
      const $ = cheerio.load(html);
      pagesCrawled++;
 
      // Collect links that look like individual event pages, in document
      // order — a broad heuristic ("/event" anywhere in the href) since
      // sites vary between "/event/", "/events/", "/e/", etc.
      const links = [];
      $('a[href*="event"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && !links.includes(href) && href !== currentUrl) links.push(href);
      });
 
      // Pull every JSON-LD Event block on this page, in order.
      const pageEvents = [];
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const parsed = JSON.parse($(el).contents().text());
          const candidates = Array.isArray(parsed) ? parsed : [parsed];
          candidates.forEach(item => {
            if (item && item['@type'] === 'Event') pageEvents.push(item);
          });
        } catch (e) {
          // skip invalid JSON blocks
        }
      });
 
      if (pageEvents.length === 0) break; // this site/page has no structured event data — stop
 
      pageEvents.forEach((item, idx) => {
        const key = `${item.name}__${item.startDate}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
 
        const loc = item.location || {};
        const addr = loc.address || {};
        const offers = item.offers || [];
        const prices = offers.map(o => o.price).filter(p => typeof p === 'number');
        let ticket_price = null;
        if (prices.length) {
          const min = Math.min(...prices).toFixed(2);
          const max = Math.max(...prices).toFixed(2);
          ticket_price = min === max ? `$${min}` : `$${min} – $${max}`;
        }
 
        let readableDate = null;
        if (item.startDate) {
          const d = new Date(item.startDate);
          if (!isNaN(d)) {
            readableDate = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
          }
        }
 
        // Prefer the JSON-LD's own url field if it has one; otherwise fall
        // back to the positional link match from the page.
        let eventUrl = item.url || links[idx] || null;
        if (eventUrl) {
          try { eventUrl = new URL(eventUrl, currentUrl).toString(); } catch (e) {}
        }
 
        events.push({
          name: item.name || 'Unknown event',
          date: readableDate,
          venue: loc.name || null,
          city: [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ') || null,
          ticket_price,
          url: eventUrl,
        });
      });
 
      // Find the next page, trying generic patterns first.
      let nextHref =
        $('a[rel="next"]').attr('href') ||
        $('a.next, a.next-page, .pagination a').filter((_, el) => /next/i.test($(el).text())).first().attr('href') ||
        null;
 
      if (!nextHref) {
        // WordPress-style pagination fallback: /page/2/, /page/3/, etc.
        const pageMatch = currentUrl.match(/\/page\/(\d+)\/?(\?.*)?$/);
        if (pageMatch) {
          const nextNum = parseInt(pageMatch[1], 10) + 1;
          nextHref = currentUrl.replace(/\/page\/\d+\/?/, `/page/${nextNum}/`);
        } else if (i === 0) {
          // first page with no visible pagination markup — try appending /page/2/
          nextHref = currentUrl.replace(/\/?(\?.*)?$/, '/page/2/');
        }
      }
 
      currentUrl = nextHref ? new URL(nextHref, currentUrl).toString() : null;
      await new Promise(r => setTimeout(r, 250)); // be polite to the server
    }
 
    return res.json({ events, pagesCrawled, source: startUrl });
 
  } catch (err) {
    console.error('Browse error:', err.message);
    return res.status(502).json({ error: 'Could not load that events list. Check the URL and try again.' });
  }
});
 
// ── Main scrape endpoint ──────────────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
 
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
 
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
    });
 
    const $ = cheerio.load(response.data);
    const fullText = $('body').text().replace(/\s+/g, ' ').trim();
 
    // ── STEP 1: Try the embedded JSON-LD structured data first ──────────────
    // WordPress "The Events Calendar" sites embed a clean schema.org Event
    // object in a <script type="application/ld+json"> tag. This doesn't
    // depend on any particular CSS class names, so it's much more reliable
    // than guessing selectors that can change with theme/plugin updates.
    let jsonLdEvent = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdEvent) return; // already found one
      try {
        const parsed = JSON.parse($(el).contents().text());
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const found = candidates.find(c => c && c['@type'] === 'Event');
        if (found) jsonLdEvent = found;
      } catch (e) {
        // not valid JSON, or not the block we want — skip it
      }
    });
 
    // ── STEP 2: Event name ──
    // JSON-LD first (works on any site using schema.org markup), then
    // Open Graph title (works on almost every modern website, since it's
    // what shows up when a link is shared on social media), then a plain h1.
    const eventName =
      (jsonLdEvent && jsonLdEvent.name) ||
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      null;
 
    // ── STEP 2b: Event description ──
    // Open Graph description is the most universally reliable source across
    // different websites, since nearly every site sets it for link previews.
    const description =
      $('meta[property="og:description"]').attr('content') ||
      (jsonLdEvent && jsonLdEvent.description) ||
      $('meta[name="description"]').attr('content') ||
      null;
 
    // ── STEP 3: Date, time, cost ──
    // Layer 1: drinkeatrelax.com's specific "Details" text block.
    // Layer 2: JSON-LD start/end timestamps (works on ANY site using
    //          schema.org Event markup — Eventbrite, Ticketmaster, most
    //          WordPress event plugins, etc.).
    // Layer 3: generic labeled-text patterns ("Date:", "When:", "Price:",
    //          "Cost:", "Tickets:") that many event sites use even without
    //          structured data.
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
 
    // Layer 2: JSON-LD dates
    if (!eventDate && jsonLdEvent && jsonLdEvent.startDate) {
      const start = new Date(jsonLdEvent.startDate);
      if (!isNaN(start)) {
        eventDate = start.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        eventTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      }
    }
 
    // Layer 2: JSON-LD price range
    if (!cost && jsonLdEvent && Array.isArray(jsonLdEvent.offers) && jsonLdEvent.offers.length) {
      const prices = jsonLdEvent.offers.map(o => o.price).filter(p => typeof p === 'number');
      if (prices.length) {
        const min = Math.min(...prices).toFixed(2);
        const max = Math.max(...prices).toFixed(2);
        cost = min === max ? `$${min}` : `$${min} – $${max}`;
      }
    }
 
    // Layer 3: generic labeled-text fallbacks for sites with neither
    // JSON-LD nor the drinkeatrelax-style "Details" block.
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
        // last resort: grab the first price-looking range anywhere on the page
        const anyPrice = fullText.match(/\$[\d,]+\.\d{2}(?:\s*[-–]\s*\$[\d,]+\.\d{2})?/);
        if (anyPrice) cost = anyPrice[0];
      }
    }
 
    // ── STEP 4: Venue / location ──
    // Layer 1: drinkeatrelax-style "Venue ... + Google Map" block.
    // Layer 2: JSON-LD location object (works on any schema.org site).
    // Layer 3: generic "Location:" / "Address:" labeled text.
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
 
    // ── STEP 5: Organizer / contact ──
    // Layer 1: labeled "Email <email>" text (works on any site that shows
    //          this pattern, not just drinkeatrelax).
    // Layer 2: JSON-LD organizer email.
    // Layer 3: the first email address found anywhere on the page — a
    //          reasonable last resort since organizers usually list one.
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
 
    // ── STEP 6: Event category ──
    // Layer 1: drinkeatrelax-style "Event Category:" text.
    // Layer 2: JSON-LD category or keywords fields.
    // Layer 3: any link to a generic "/category/" path — common across
    //          most WordPress-based event sites, not just this one.
    const catLink =
      eventCategoryFromDetails ||
      (jsonLdEvent && (jsonLdEvent.category || (Array.isArray(jsonLdEvent.keywords) ? jsonLdEvent.keywords[0] : jsonLdEvent.keywords))) ||
      $('a[href*="/category/"]').first().text().trim() ||
      $('a[href*="/events/category/"]').first().text().trim() ||
      null;
 
    // ── STEP 7: Event duration ──
    // Computed from the JSON-LD start/end timestamps when available, since
    // that's exact. Falls back to null if the page didn't have JSON-LD.
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
 
    // ── STEP 8: Health permit mention (plain text search, unchanged) ──
    const healthPermit = /health permit|food permit|food handler/i.test(fullText)
      ? 'Likely required'
      : 'Check with organizer';
 
    // ── STEP 9: Application deadline (plain text search, unchanged) ──
    const deadlineMatch = fullText.match(/deadline[:\s]+([A-Z][a-z]+ \d{1,2},?\s*\d{4})/i);
    const applicationDeadline = deadlineMatch ? deadlineMatch[1] : null;
 
    // ── STEP 10: Additional requirements (plain text search, unchanged) ──
    const requirements = [];
    if (/bring your own tent|responsible for.*tent/i.test(fullText)) requirements.push('Bring your own tent & weights');
    if (/electricity.*not included|electricity.*not provided/i.test(fullText)) requirements.push('Electricity not included (rent separately)');
    if (/tables.*not provided|food concession.*not.*table/i.test(fullText)) requirements.push('Tables not provided for food vendors');
    if (/booth accessory form/i.test(fullText)) requirements.push('Booth accessory form required for rentals');
    if (/50%.*deposit/i.test(fullText)) requirements.push('50% deposit required upon acceptance');
    if (/insurance/i.test(fullText)) requirements.push('Proof of insurance may be required');
 
    // ── STEP 11: Notes (generic keyword search — works on any site) ──
    const hasVendorInfo = /exhibitor|vendor application|sponsor/i.test(fullText);
    const notes = hasVendorInfo
      ? `This event accepts vendors/exhibitors.${contact ? ` Contact ${contact} to apply.` : ' Check the site for a vendor/exhibitor application page.'} Booth assignments are typically given upon arrival.`
      : null;
 
    // ── Site identification, for display ──
    let sourceSite = null;
    try { sourceSite = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
 
    return res.json({
      event_name: eventName,
      event_description: description,
      event_date: eventDate,
      event_time: eventTime,
      location,
      ticket_price: cost, // what ATTENDEES pay — not the vendor booth fee
      application_deadline: applicationDeadline,
      health_permit_required: healthPermit,
      event_duration: duration,
      event_type: catLink,
      organizer_contact: contact,
      additional_requirements: requirements,
      notes,
      website: url,
      source_site: sourceSite,
      // Vendor/booth pricing is rarely on the event page itself for any of
      // these event-series sites — it usually lives in a separate vendor
      // application PDF or page. We surface where to look instead of
      // guessing a number that could be wrong.
      vendor_info_note: sourceSite && sourceSite.includes('drinkeatrelax')
        ? 'Booth/table pricing is not listed on this page. Check der411.com for the current vendor application PDF, or contact ' + (contact || 'the organizer') + '.'
        : `Booth/table pricing usually isn't listed on the event page itself. Look for an "Exhibitor," "Vendor," or "Sponsor" link on ${sourceSite || 'this site'}, or contact ${contact || 'the organizer'} directly.`,
    });
 
  } catch (err) {
    console.error('Scrape error:', err.message);
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
 