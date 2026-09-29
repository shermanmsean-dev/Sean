const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Both secrets must be set in the environment (Replit: Tools → Secrets).
// There are deliberately no fallbacks: this repository is public.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MEMBER_CODE = (process.env.MEMBER_CODE || '').trim().toUpperCase();
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set — admin portal is disabled.');
if (!MEMBER_CODE) console.warn('MEMBER_CODE is not set — new member sign-ups are disabled.');

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

// ---------- member auth ----------

async function requireMember(req, res, next) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const result = await pool.query('SELECT * FROM members WHERE token_hash = $1', [hashToken(m[1])]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    req.member = result.rows[0];
    next();
  } catch (err) {
    handleError(res, err);
  }
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

app.post('/api/join', async (req, res) => {
  const ip = 'join:' + req.ip;
  if (!MEMBER_CODE) return res.status(503).json({ error: 'Sign-ups are not open yet.' });
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });

  const first = str(req.body.first, 60);
  const last = str(req.body.last, 60);
  const email = normEmail(req.body.email);
  const code = str(req.body.code, 60).toUpperCase();
  if (!first || !last) return res.status(400).json({ error: 'Please enter your name.' });
  if (!email) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (!safeEqual(code, MEMBER_CODE)) {
    recordFailure(ip);
    return res.status(403).json({ error: 'Invalid member code. Please try again.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    const existing = await pool.query('SELECT id, token_hash FROM members WHERE lower(email) = $1', [email]);
    if (existing.rows.length) {
      // An active member keeps sole access; the owner can release it from the admin portal.
      if (existing.rows[0].token_hash) {
        return res.status(409).json({ error: 'This email is already an active member on another device. Please ask the Paddock 17 team to restore your access.' });
      }
      const result = await pool.query(
        'UPDATE members SET token_hash = $2, updated_at = NOW() WHERE id = $1 AND token_hash IS NULL RETURNING *',
        [existing.rows[0].id, hashToken(token)]
      );
      if (!result.rows.length) return res.status(409).json({ error: 'Please try again.' });
      return res.json({ token, member: publicMember(result.rows[0]) });
    }

    const now = new Date();
    const since = MONTHS[now.getMonth()] + ' ' + now.getFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const memberId = 'VEC-' + now.getFullYear() + '-' + crypto.randomInt(1000, 10000);
      const taken = await pool.query('SELECT 1 FROM members WHERE member_id = $1', [memberId]);
      if (taken.rows.length) continue;
      const result = await pool.query(
        `INSERT INTO members (email, first_name, last_name, member_id, member_since, visits, rsvps, comments, token_hash, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, '[]', '[]', $6, NOW())
         ON CONFLICT (email) DO NOTHING RETURNING *`,
        [email, first, last, memberId, since, hashToken(token)]
      );
      if (!result.rows.length) return res.status(409).json({ error: 'This email is already a member. Please try again.' });
      return res.json({ token, member: publicMember(result.rows[0]) });
    }
    res.status(500).json({ error: 'Could not assign a member ID. Please try again.' });
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
  if ('email' in b) { const v = normEmail(b.email); if (!v) return res.status(400).json({ error: 'Please enter a valid email.' }); changes.email = v; }
  if ('waterPref' in b) { if (!WATER_OPTS.includes(b.waterPref)) return res.status(400).json({ error: 'Invalid option.' }); changes.water_pref = b.waterPref; }
  if ('seatPref' in b) { if (!SEAT_OPTS.includes(b.seatPref)) return res.status(400).json({ error: 'Invalid option.' }); changes.seat_pref = b.seatPref; }
  if ('dietary' in b) changes.dietary = str(b.dietary, 200) || null;
  if ('notes' in b) changes.notes = str(b.notes, 1000) || null;
  if (!Object.keys(changes).length) return res.json(publicMember(req.member));
  try {
    const out = await updateMember(req.member.email, async (row, client) => {
      if (changes.email) {
        const dupe = await client.query('SELECT 1 FROM members WHERE lower(email) = $1 AND id <> $2', [changes.email, row.id]);
        if (dupe.rows.length) return { error: 'That email is already used by another member.' };
      }
      return changes;
    });
    if (out.error) return res.status(409).json({ error: out.error });
    res.json(publicMember(out.row));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already used by another member.' });
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
    const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
    const counts = await rsvpCounts();
    res.json({
      members: result.rows.map(r => Object.assign(publicMember(r), { hasAccess: !!r.token_hash })),
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

// Signs the member out everywhere so they can re-join (keeping their history)
// from a new device with their email and the member code.
app.post('/api/admin/reset-access', requireAdmin, async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const out = await updateMember(email, () => ({ token_hash: null }));
    if (!out) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true });
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
  await pool.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS token_hash TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS members_token_hash_idx ON members (token_hash)');
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
