const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Both secrets must be set in the environment (Replit: Tools → Secrets).
// There are deliberately no fallbacks: this repository is public.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MEMBER_CODE = (process.env.MEMBER_CODE || '').trim().toUpperCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set — admin portal is disabled.');
if (!MEMBER_CODE) console.warn('MEMBER_CODE is not set — new member sign-ups are disabled.');
if (!RESEND_API_KEY || !EMAIL_FROM) console.warn('RESEND_API_KEY / EMAIL_FROM not set — sign-in codes are printed to this log instead of emailed.');

// Edit this list to publish events. Past events are hidden automatically.
const EVENTS = [
  { id: 'e1', name: 'Friends & Family Pre-Opening', date: '2026-05-10', time: '6:00 PM', desc: 'Complimentary first-look dinner for Paddock members and their guests before anyone else sets foot in the restaurant.', seats: 40, price: 'Complimentary' },
  { id: 'e2', name: 'Meet the Team', date: '2026-05-15', time: '5:30 PM', desc: 'Casual evening with passed bites and cocktails, kitchen tour, meet the chef and bar team. No reservation needed.', seats: 60, price: 'Complimentary' },
  { id: 'e3', name: 'Grand Opening', date: '2026-05-18', time: '5:00 PM', desc: 'Doors officially open. Full dinner service, bar open, Paddock 17 members get priority seating before the public.', seats: 80, price: 'À la carte' }
];
const WATER_OPTS = ['Still', 'Sparkling', 'No preference'];
const SEAT_OPTS = ['Bar', 'Booth', 'Table', 'Terrace', 'No preference'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  next();
});
app.use(express.json({ limit: '20kb' }));

// Only the two pages are public — never the project directory.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ---------- helpers ----------

function todayLocal() {
  // Middleburg, VA
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isUpcoming(ev) {
  return ev.date >= todayLocal();
}

function parseList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { const v = JSON.parse(val); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

// Older comments were stored without ids; their array position is stable
// because comments are append-only, so derive an id from it.
function withCommentIds(comments) {
  return comments.map((c, i) => Object.assign({}, c, { id: c.id || 'c' + i }));
}

function str(val, max) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, max);
}

function normEmail(val) {
  const e = str(val, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function publicMember(row) {
  return {
    email: row.email,
    first: row.first_name,
    last: row.last_name,
    memberId: row.member_id,
    memberSince: row.member_since,
    visits: row.visits || 0,
    rsvps: parseList(row.rsvps),
    comments: withCommentIds(parseList(row.comments)).map(c => ({
      id: c.id, text: c.text, date: c.date, reply: c.reply || null, replyDate: c.replyDate || null
    })),
    waterPref: row.water_pref,
    seatPref: row.seat_pref,
    dietary: row.dietary,
    notes: row.notes
  };
}

async function rsvpCounts(client) {
  const result = await (client || pool).query('SELECT rsvps FROM members');
  const counts = {};
  result.rows.forEach(r => parseList(r.rsvps).forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
  return counts;
}

function handleError(res, err) {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Simple in-memory limiter for guessable secrets (admin password, member code).
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { failures.delete(key); return false; }
  return f.count >= 10;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

// ---------- email ----------

// Sends via Resend (https://resend.com). Without RESEND_API_KEY the message is
// written to the server log instead, which is fine for testing but not for members.
async function sendEmail(to, subject, text) {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.log(`[email not configured] To: ${to} | ${subject}\n${text}`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text })
  });
  if (!r.ok) throw new Error('Email send failed: ' + r.status + ' ' + (await r.text()));
}

function codeEmail(first, code) {
  return (first ? first + ',\n\n' : '') +
    'Your Paddock 17 sign-in code is:\n\n    ' + code + '\n\n' +
    'It expires in 10 minutes. If you didn’t ask for this, you can safely ignore this email.\n\n' +
    '— The Vintage Equestrian Club';
}

// ---------- member auth ----------

const SESSION_DAYS = 180;

async function requireMember(req, res, next) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const result = await pool.query(
      `UPDATE sessions SET last_seen = NOW()
       WHERE token_hash = $1 AND last_seen > NOW() - make_interval(days => $2)
       RETURNING member_id`,
      [hashToken(m[1]), SESSION_DAYS]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    const member = await pool.query('SELECT * FROM members WHERE id = $1', [result.rows[0].member_id]);
    if (member.rows.length === 0) return res.status(401).json({ error: 'Please sign in.' });
    req.member = member.rows[0];
    req.tokenHash = hashToken(m[1]);
    next();
  } catch (err) {
    handleError(res, err);
  }
}

async function createSession(memberId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (token_hash, member_id) VALUES ($1, $2)', [hashToken(token), memberId]);
  return token;
}

// Runs fn(row) inside a transaction with the member row locked, then saves
// whatever fields fn returns. Prevents concurrent requests clobbering each other.
async function updateMember(email, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM members WHERE lower(email) = lower($1) FOR UPDATE', [email]);
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return null; }
    const changes = await fn(result.rows[0], client);
    if (changes && changes.error) { await client.query('ROLLBACK'); return changes; }
    const cols = Object.keys(changes || {});
    let row = result.rows[0];
    if (cols.length) {
      const sets = cols.map((c, i) => c + ' = $' + (i + 2));
      const updated = await client.query(
        'UPDATE members SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $1 RETURNING *',
        [row.id].concat(cols.map(c => changes[c]))
      );
      row = updated.rows[0];
    }
    await client.query('COMMIT');
    return { row };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- member endpoints ----------

// Counts requests per key in a 15-minute window (for sending codes).
const sends = new Map();
function overLimit(key, limit) {
  const now = Date.now();
  const s = sends.get(key);
  if (!s || now - s.first > 15 * 60 * 1000) { sends.set(key, { first: now, count: 1 }); return false; }
  s.count++;
  return s.count > limit;
}

// Step 1 of sign-in and sign-up: email a 6-digit code.
// Existing members only need their email. New members also need their name and
// the invite code (from the QR code or the team). The response never reveals
// whether an email belongs to a member.
app.post('/api/auth/start', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (overLimit('ip:' + req.ip, 20) || overLimit('email:' + email, 5)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  }
  const invite = str(req.body.invite, 60).toUpperCase();
  const first = str(req.body.first, 60);
  const last = str(req.body.last, 60);
  const joining = !!invite;

  if (joining) {
    const ipKey = 'invite:' + req.ip;
    if (tooManyFailures(ipKey)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    if (!MEMBER_CODE) return res.status(503).json({ error: 'New memberships are not open yet.' });
    if (!first || !last) return res.status(400).json({ error: 'Please enter your name.' });
    if (!safeEqual(invite, MEMBER_CODE)) {
      recordFailure(ipKey);
      return res.status(403).json({ error: 'That invitation code isn’t valid. Please check it and try again.' });
    }
  }

  try {
    const existing = await pool.query('SELECT first_name FROM members WHERE lower(email) = $1', [email]);
    const isMember = existing.rows.length > 0;
    if (!isMember && !joining) {
      await sendEmail(email, 'Paddock 17',
        'Someone tried to sign in to Paddock 17 with this email, but we don’t have a membership under it.\n\n' +
        'If you’d like to join, scan the Paddock 17 QR code at The Vintage Equestrian Club or ask any of our team for an invitation.\n\n' +
        '— The Vintage Equestrian Club');
      return res.json({ ok: true });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO login_codes (email, code_hash, expires_at, attempts, first_name, last_name)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes', 0, $3, $4)
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
         attempts = 0, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name`,
      [email, hashToken(email + ':' + code), isMember ? null : first, isMember ? null : last]
    );
    await sendEmail(email, 'Your Paddock 17 sign-in code: ' + code,
      codeEmail(isMember ? existing.rows[0].first_name : first, code));
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// Step 2: exchange the emailed code for a session. Creates the membership on first sign-in.
app.post('/api/auth/verify', async (req, res) => {
  const email = normEmail(req.body.email);
  const code = str(req.body.code, 12).replace(/\D/g, '');
  if (!email || code.length !== 6) return res.status(400).json({ error: 'Please enter the 6-digit code from your email.' });
  try {
    const found = await pool.query('SELECT * FROM login_codes WHERE email = $1 AND expires_at > NOW()', [email]);
    const pending = found.rows[0];
    if (!pending || pending.attempts >= 5) {
      return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
    }
    if (!safeEqual(pending.code_hash, hashToken(email + ':' + code))) {
      await pool.query('UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1', [email]);
      return res.status(400).json({ error: 'That code isn’t right. Please check your email and try again.' });
    }
    await pool.query('DELETE FROM login_codes WHERE email = $1', [email]);

    let member = (await pool.query('SELECT * FROM members WHERE lower(email) = $1', [email])).rows[0];
    if (!member) {
      if (!pending.first_name) return res.status(400).json({ error: 'Please start again with your invitation.' });
      const now = new Date();
      const since = MONTHS[now.getMonth()] + ' ' + now.getFullYear();
      for (let attempt = 0; attempt < 5 && !member; attempt++) {
        const memberId = 'VEC-' + now.getFullYear() + '-' + crypto.randomInt(1000, 10000);
        const taken = await pool.query('SELECT 1 FROM members WHERE member_id = $1', [memberId]);
        if (taken.rows.length) continue;
        member = (await pool.query(
          `INSERT INTO members (email, first_name, last_name, member_id, member_since, visits, rsvps, comments, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, '[]', '[]', NOW())
           ON CONFLICT (email) DO UPDATE SET updated_at = NOW() RETURNING *`,
          [email, pending.first_name, pending.last_name, memberId, since]
        )).rows[0];
      }
      if (!member) return res.status(500).json({ error: 'Could not assign a member ID. Please try again.' });
    }
    const token = await createSession(member.id);
    res.json({ token, member: publicMember(member) });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/auth/signout', requireMember, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.tokenHash]);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.get('/api/me', requireMember, (req, res) => {
  res.json(publicMember(req.member));
});

app.patch('/api/me', requireMember, async (req, res) => {
  const b = req.body || {};
  const changes = {};
  if ('first' in b) { const v = str(b.first, 60); if (!v) return res.status(400).json({ error: 'First name is required.' }); changes.first_name = v; }
  if ('last' in b) { const v = str(b.last, 60); if (!v) return res.status(400).json({ error: 'Last name is required.' }); changes.last_name = v; }
  if ('waterPref' in b) { if (!WATER_OPTS.includes(b.waterPref)) return res.status(400).json({ error: 'Invalid option.' }); changes.water_pref = b.waterPref; }
  if ('seatPref' in b) { if (!SEAT_OPTS.includes(b.seatPref)) return res.status(400).json({ error: 'Invalid option.' }); changes.seat_pref = b.seatPref; }
  if ('dietary' in b) changes.dietary = str(b.dietary, 200) || null;
  if ('notes' in b) changes.notes = str(b.notes, 1000) || null;
  if (!Object.keys(changes).length) return res.json(publicMember(req.member));
  try {
    const out = await updateMember(req.member.email, () => changes);
    res.json(publicMember(out.row));
  } catch (err) {
    handleError(res, err);
  }
});

app.get('/api/events', requireMember, async (req, res) => {
  try {
    const counts = await rsvpCounts();
    res.json(EVENTS.filter(isUpcoming).map(ev => Object.assign({}, ev, { taken: counts[ev.id] || 0 })));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/me/rsvps', requireMember, async (req, res) => {
  const ev = EVENTS.find(e => e.id === req.body.eventId);
  if (!ev || !isUpcoming(ev)) return res.status(400).json({ error: 'This event is no longer available.' });
  try {
    const out = await updateMember(req.member.email, async (row, client) => {
      const rsvps = parseList(row.rsvps);
      if (rsvps.includes(ev.id)) return {};
      // Serialise RSVPs so two members can't take the last seat at once.
      await client.query('SELECT pg_advisory_xact_lock(17)');
      const counts = await rsvpCounts(client);
      if ((counts[ev.id] || 0) >= ev.seats) return { error: 'This event is fully booked.' };
      return { rsvps: JSON.stringify(rsvps.concat(ev.id)) };
    });
    if (out.error) return res.status(409).json({ error: out.error });
    res.json(publicMember(out.row));
  } catch (err) {
    handleError(res, err);
  }
});

app.delete('/api/me/rsvps/:eventId', requireMember, async (req, res) => {
  try {
    const out = await updateMember(req.member.email, row => ({
      rsvps: JSON.stringify(parseList(row.rsvps).filter(id => id !== req.params.eventId))
    }));
    res.json(publicMember(out.row));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/me/comments', requireMember, async (req, res) => {
  const text = str(req.body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Please write a message.' });
  try {
    const out = await updateMember(req.member.email, row => {
      const comments = withCommentIds(parseList(row.comments));
      comments.push({ id: crypto.randomUUID(), text, date: new Date().toISOString(), from: 'member' });
      return { comments: JSON.stringify(comments) };
    });
    res.json(publicMember(out.row));
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- admin endpoints ----------

function requireAdmin(req, res, next) {
  const key = 'admin:' + req.ip;
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin access is not configured.' });
  if (tooManyFailures(key)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  if (!safeEqual(req.headers['x-admin-key'] || '', ADMIN_PASSWORD)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, (SELECT COUNT(*) FROM sessions s WHERE s.member_id = m.id) AS session_count
       FROM members m ORDER BY m.created_at DESC`
    );
    const counts = await rsvpCounts();
    res.json({
      members: result.rows.map(r => Object.assign(publicMember(r), { devices: Number(r.session_count) })),
      events: EVENTS.map(ev => Object.assign({}, ev, { taken: counts[ev.id] || 0, upcoming: isUpcoming(ev) }))
    });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/admin/reply', requireAdmin, async (req, res) => {
  const email = normEmail(req.body.email);
  const commentId = str(req.body.commentId, 64);
  const reply = str(req.body.reply, 2000);
  if (!email || !commentId || !reply) return res.status(400).json({ error: 'email, commentId, and reply required' });
  try {
    const out = await updateMember(email, row => {
      const comments = withCommentIds(parseList(row.comments));
      const c = comments.find(x => x.id === commentId);
      if (!c) return { error: 'Comment not found' };
      c.reply = reply;
      c.replyDate = new Date().toISOString();
      return { comments: JSON.stringify(comments) };
    });
    if (!out) return res.status(404).json({ error: 'Member not found' });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/admin/visits', requireAdmin, async (req, res) => {
  const email = normEmail(req.body.email);
  const delta = req.body.delta === -1 ? -1 : 1;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const out = await updateMember(email, row => ({ visits: Math.max(0, (row.visits || 0) + delta) }));
    if (!out) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true, visits: out.row.visits });
  } catch (err) {
    handleError(res, err);
  }
});

// Signs the member out on every device (e.g. a lost phone). They sign back in with their email.
app.post('/api/admin/signout-member', requireAdmin, async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const result = await pool.query(
      'DELETE FROM sessions WHERE member_id = (SELECT id FROM members WHERE lower(email) = $1)', [email]
    );
    res.json({ ok: true, removed: result.rowCount });
  } catch (err) {
    handleError(res, err);
  }
});

// The invite link and QR code new members scan to join.
app.get('/api/admin/invite', requireAdmin, async (req, res) => {
  if (!MEMBER_CODE) return res.status(503).json({ error: 'Set MEMBER_CODE to enable invitations.' });
  const base = (process.env.PUBLIC_URL || req.protocol + '://' + req.get('host')).replace(/\/$/, '');
  const url = base + '/?invite=' + encodeURIComponent(MEMBER_CODE);
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0F1E2B', light: '#FFFFFF' } });
    res.json({ url, svg });
  } catch (err) {
    handleError(res, err);
  }
});

// ---------- startup ----------

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      first_name TEXT,
      last_name TEXT,
      member_id TEXT,
      member_since TEXT,
      visits INTEGER NOT NULL DEFAULT 0,
      rsvps JSONB NOT NULL DEFAULT '[]',
      comments JSONB NOT NULL DEFAULT '[]',
      water_pref TEXT,
      seat_pref TEXT,
      dietary TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // The live table predates this file; make sure every column the server relies on exists.
  await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS id SERIAL');
  await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await pool.query('DROP INDEX IF EXISTS members_token_hash_idx');
  await pool.query('ALTER TABLE members DROP COLUMN IF EXISTS token_hash');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS sessions_member_idx ON sessions (member_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_name TEXT,
      last_name TEXT
    )`);
}

const PORT = process.env.PORT || 5000;
migrate()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Paddock 17 server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Database setup failed:', err);
    process.exit(1);
  });
