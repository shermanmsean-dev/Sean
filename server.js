const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'paddock17';
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.post('/api/members', async (req, res) => {
  const { email, first, last, memberId, memberSince, visits, rsvps, comments, waterPref, seatPref, dietary, notes } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    await pool.query(
      `INSERT INTO members (email, first_name, last_name, member_id, member_since, visits, rsvps, comments, water_pref, seat_pref, dietary, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (email) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         member_id = EXCLUDED.member_id,
         member_since = EXCLUDED.member_since,
         visits = EXCLUDED.visits,
         rsvps = EXCLUDED.rsvps,
         comments = EXCLUDED.comments,
         water_pref = EXCLUDED.water_pref,
         seat_pref = EXCLUDED.seat_pref,
         dietary = EXCLUDED.dietary,
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [
        email, first, last, memberId, memberSince,
        visits || 0,
        JSON.stringify(rsvps || []),
        JSON.stringify(comments || []),
        waterPref || null, seatPref || null,
        dietary || null, notes || null
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
app.get('/api/admin/members', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM members ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Paddock 17 server running on port ${PORT}`);
});
