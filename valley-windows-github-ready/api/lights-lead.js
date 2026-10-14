// Vercel serverless function: POST /api/lights-lead
// Receives the Christmas lights quote form and creates a lead in Housecall Pro.
// Required env var:  HCP_API_KEY        (The Valley Holiday Lighting HCP account)
// Optional env var:  ZAPIER_WEBHOOK_URL (backup notification)

const HCP_URL = 'https://api.housecallpro.com/leads';
const SITE = 'thevalleywindows.com/christmas-lights';
const PHONE = '(256) 217-5335';
const CALL_MSG = `Sorry, we couldn't send your request. Please call or text us at ${PHONE} and we'll get you a quote.`;

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const ABBRS = new Set(Object.values(STATES));

const ALLOWED_SERVICES = new Set([
  'Roofline', 'Trees', 'Bushes & shrubs', 'Wreaths & garland', 'Walkway / pathway', 'Not sure, design it for me',
]);
const ALLOWED_COLORS = new Set(['', 'Warm white', 'Multicolor', 'Candy cane (red & white)', 'Red, green & white', 'Other / mix']);

// Best-effort rate limit: 5 submissions per minute per IP.
// (Kept in memory, so it resets when Vercel starts a fresh instance.)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 5;
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : null;
}

function normalizeState(raw) {
  const s = String(raw || '').trim();
  if (ABBRS.has(s.toUpperCase())) return s.toUpperCase();
  return STATES[s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')] || null;
}

async function notifyZapier(payload) {
  const url = process.env.ZAPIER_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('Zapier webhook failed:', e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, message: 'Please fill out the form and try again.' });
  }

  // Honeypot: real visitors never see this field. Bots get a fake success.
  if (str(body.website, 200)) {
    return res.status(200).json({ ok: true });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, message: `Too many requests. Please wait a minute, or call or text us at ${PHONE}.` });
  }

  // Validate
  const firstName = str(body.firstName, 60);
  const lastName = str(body.lastName, 60);
  const email = str(body.email, 120).toLowerCase();
  const street = str(body.street, 120);
  const city = str(body.city, 60);
  const zip = str(body.zip, 10);
  const notes = str(body.notes, 1000);
  const design = str(body.design, 200);
  const color = ALLOWED_COLORS.has(str(body.color, 40)) ? str(body.color, 40) : '';
  const services = Array.isArray(body.services)
    ? [...new Set(body.services.filter((s) => typeof s === 'string' && ALLOWED_SERVICES.has(s)))]
    : [];
  const phone = normalizePhone(body.phone);
  const state = normalizeState(body.state);

  const missing = [];
  if (!firstName) missing.push('first name');
  if (!lastName) missing.push('last name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) missing.push('a valid email');
  if (!phone) missing.push('a 10-digit phone number');
  if (!street) missing.push('street address');
  if (!city) missing.push('city');
  if (!state) missing.push('state');
  if (!/^\d{5}(-\d{4})?$/.test(zip)) missing.push('a valid ZIP code');
  if (body.minAck !== true) missing.push('the $800 project minimum acknowledgment');
  if (missing.length) {
    return res.status(400).json({ ok: false, message: `Please check: ${missing.join(', ')}.` });
  }

  const description = [
    `Customer email: ${email}`,
    `Customer phone: ${phone}`,
    `Services requested: ${services.length ? services.join(', ') : 'Not specified'}`,
    `Light color: ${color || 'No preference yet'}`,
    ...(design ? [`Design picked in website preview: ${design}`] : []),
    `Notes: ${notes || 'None'}`,
    'Acknowledged $800 project minimum: Yes',
    `Submitted from ${SITE} quote form.`,
  ].join('\n\n');

  const lead = {
    customer: {
      first_name: firstName,
      last_name: lastName,
      email,
      mobile_number: phone,
      notifications_enabled: false,
      addresses: [{ type: 'service', street, city, state, zip, country: 'US' }],
    },
    lead_source: 'Website',
    description,
  };

  const backup = {
    first_name: firstName, last_name: lastName, email, phone,
    street, city, state, zip, services: services.join(', '), color, notes, design, minimum_acknowledged: true,
    source: SITE, submitted_at: new Date().toISOString(),
  };

  const key = process.env.HCP_API_KEY;
  if (!key) {
    console.error('HCP_API_KEY is not set.');
    await notifyZapier({ ...backup, status: 'housecall_request_failed', reason: 'missing_api_key' });
    return res.status(500).json({ ok: false, message: CALL_MSG });
  }

  try {
    const hcp = await fetch(HCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(lead),
    });

    if (!hcp.ok) {
      const text = await hcp.text().catch(() => '');
      console.error(`Housecall Pro rejected lead: ${hcp.status} ${text.slice(0, 2000)}`);
      await notifyZapier({ ...backup, status: 'housecall_rejected', hcp_status: hcp.status });
      return res.status(502).json({ ok: false, message: CALL_MSG });
    }

    await notifyZapier({ ...backup, status: 'created_in_housecall' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Housecall Pro request failed:', e.message);
    await notifyZapier({ ...backup, status: 'housecall_request_failed' });
    return res.status(502).json({ ok: false, message: CALL_MSG });
  }
};
