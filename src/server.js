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

// ── Main scrape endpoint ──────────────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!url.includes('drinkeatrelax.com')) {
    return res.status(400).json({ error: 'Please paste a drinkeatrelax.com URL' });
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
    const fullText = $('body').text().replace(/\s+/g, ' ');

    // ── Event name ──
    const eventName =
      $('h1.tribe-events-single-event-title').text().trim() ||
      $('h1.entry-title').text().trim() ||
      $('h1').first().text().trim() ||
      null;

    // ── Date and time ──
    let eventDate = null;
    let eventTime = null;
    const schedText = $('.tribe-events-schedule').text().replace(/\s+/g, ' ').trim();
    if (schedText) {
      const match = schedText.match(/^([\w\s,]+\d{4})\s*@\s*(.+)$/);
      if (match) {
        eventDate = match[1].trim();
        eventTime = match[2].trim();
      } else {
        eventDate = schedText;
      }
    }
    // fallback
    if (!eventDate) {
      const abbrEl = $('abbr.tribe-events-abbr').first();
      eventDate = abbrEl.attr('title') || abbrEl.text().trim() || null;
    }

    // ── Location ──
    const venueName = $('.tribe-venue').first().text().trim() || null;
    const streetAddr = $('.tribe-street-address').text().trim();
    const city = $('.tribe-city').text().trim();
    const state = $('.tribe-stateprovince').text().trim();
    const zip = $('.tribe-zip').text().trim();

    let location = null;
    if (venueName) {
      const parts = [venueName];
      if (streetAddr) parts.push(streetAddr);
      const cityLine = [city, state, zip].filter(Boolean).join(' ');
      if (cityLine) parts.push(cityLine);
      location = parts.join(', ');
    }

    // ── Cost ──
    const cost =
      $('.tribe-events-cost').text().trim() ||
      $('.tribe-cost').text().trim() ||
      null;

    // ── Organizer ──
    const orgEmail =
      $('.tribe-organizer-email a').text().trim() ||
      null;
    const orgPhone = $('.tribe-organizer-tel').text().trim() || null;
    const contact = orgEmail || orgPhone || 'sales@drinkeatrelax.com';

    // ── Event category ──
    const catLink = $('a[href*="/events/category/"]').first().text().trim() || null;

    // ── Expected attendance ──
    const attMatch = fullText.match(/(\d[\d,]+)\s*(guests|attendees|visitors|people)/i);
    const expectedAttendance = attMatch ? `${attMatch[1]} ${attMatch[2]}` : null;

    // ── Health permit ──
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
      ? 'This event accepts vendors/exhibitors. Contact sales@drinkeatrelax.com or visit der411.com to apply. Booth assignments are given upon arrival.'
      : null;

    return res.json({
      event_name: eventName,
      event_date: eventDate,
      event_time: eventTime,
      location,
      booth_fee: cost,
      application_deadline: applicationDeadline,
      health_permit_required: healthPermit,
      expected_attendance: expectedAttendance,
      event_type: catLink,
      organizer_contact: contact,
      additional_requirements: requirements,
      notes,
      website: url,
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
