require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { pool, initDb } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const DOWNLOAD_FILENAME = process.env.DOWNLOAD_FILENAME || 'Axiom-Client.jar';

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters long.');
  process.exit(1);
}

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const licenseLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

function normalizeKey(value) {
  return String(value || '').trim().toUpperCase();
}

function hashKey(key) {
  return crypto.createHash('sha256').update(normalizeKey(key)).digest('hex');
}

function generateLicenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(32);
  let raw = '';
  for (let i = 0; i < 32; i++) raw += alphabet[bytes[i] % alphabet.length];
  const groups = raw.match(/.{1,8}/g);
  return `AXIOM-${groups.join('-')}`;
}

function safeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function adminOnly(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'admin') throw new Error('bad type');
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function parseDuration(body) {
  const amount = Number(body.amount);
  const unit = String(body.unit || '').toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0 || amount > 3650) return null;

  const multipliers = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000
  };
  if (!multipliers[unit]) return null;
  return new Date(Date.now() + amount * multipliers[unit]);
}

async function validateLicense(key, clientId, bindIfEmpty = false) {
  const normalized = normalizeKey(key);
  const cid = String(clientId || '').trim();
  if (!normalized || !cid || cid.length > 180) {
    return { ok: false, status: 400, message: 'Key and client ID are required.' };
  }

  const result = await pool.query(
    `SELECT id, client_id, expires_at, revoked, note FROM licenses WHERE key_hash = $1 LIMIT 1`,
    [hashKey(normalized)]
  );

  if (!result.rowCount) return { ok: false, status: 404, message: 'Invalid key.' };
  const row = result.rows[0];
  if (row.revoked) return { ok: false, status: 403, message: 'This key has been revoked.' };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 403, message: 'This key has expired.', expiresAt: row.expires_at };
  }

  if (row.client_id && row.client_id !== cid) {
    return { ok: false, status: 403, message: 'This key is already bound to another client ID.' };
  }

  if (!row.client_id && !bindIfEmpty) {
    return { ok: false, status: 403, message: 'This key must be activated before it can be checked.' };
  }

  if (!row.client_id && bindIfEmpty) {
    await pool.query(
      `UPDATE licenses SET client_id = $1, activated_at = COALESCE(activated_at, NOW()), last_seen_at = NOW() WHERE id = $2`,
      [cid, row.id]
    );
  } else {
    await pool.query(`UPDATE licenses SET last_seen_at = NOW() WHERE id = $1`, [row.id]);
  }

  return {
    ok: true,
    id: row.id,
    expiresAt: row.expires_at,
    clientId: row.client_id || (bindIfEmpty ? cid : null),
    note: row.note || ''
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({
    discordUrl: process.env.PUBLIC_DISCORD_URL || '#',
    version: process.env.PUBLIC_CLIENT_VERSION || '1.0.0'
  });
});

app.post('/api/admin/login', authLimiter, (req, res) => {
  const password = String(req.body.password || '');
  if (!safeEqualText(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect owner password.' });
  }
  const token = jwt.sign({ type: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, expiresIn: 8 * 60 * 60 });
});

app.post('/api/admin/licenses', adminOnly, async (req, res, next) => {
  try {
    const expiresAt = parseDuration(req.body);
    if (!expiresAt) return res.status(400).json({ error: 'Choose a valid duration.' });

    const requestedClientId = String(req.body.clientId || '').trim();
    if (requestedClientId.length > 180) return res.status(400).json({ error: 'Client ID is too long.' });
    const note = String(req.body.note || '').trim().slice(0, 120);

    let key;
    let inserted = false;
    for (let i = 0; i < 4 && !inserted; i++) {
      key = generateLicenseKey();
      try {
        await pool.query(
          `INSERT INTO licenses (key_hash, key_preview, client_id, expires_at, note) VALUES ($1, $2, $3, $4, $5)`,
          [hashKey(key), `${key.slice(0, 14)}…`, requestedClientId || null, expiresAt, note]
        );
        inserted = true;
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }

    if (!inserted) throw new Error('Could not generate a unique key.');

    res.status(201).json({
      key,
      expiresAt: expiresAt.toISOString(),
      clientId: requestedClientId || null,
      note
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/licenses', adminOnly, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id, key_preview, client_id, expires_at, revoked, note, created_at, activated_at, last_seen_at,
             (expires_at > NOW() AND revoked = FALSE) AS active
      FROM licenses
      ORDER BY created_at DESC
      LIMIT 250
    `);
    res.json({ licenses: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/licenses/:id/revoke', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid license ID.' });
    const result = await pool.query(`UPDATE licenses SET revoked = TRUE WHERE id = $1 RETURNING id`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'License not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/licenses/:id/unbind', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid license ID.' });
    const result = await pool.query(
      `UPDATE licenses SET client_id = NULL, activated_at = NULL, last_seen_at = NULL WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'License not found.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/license/activate', licenseLimiter, async (req, res, next) => {
  try {
    const result = await validateLicense(req.body.key, req.body.clientId, true);
    if (!result.ok) return res.status(result.status).json({ valid: false, error: result.message, expiresAt: result.expiresAt });

    const downloadTicket = jwt.sign(
      { type: 'download', licenseId: result.id, clientId: result.clientId },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    res.json({
      valid: true,
      message: 'Key successful',
      expiresAt: result.expiresAt,
      downloadTicket
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/license/check', licenseLimiter, async (req, res, next) => {
  try {
    const result = await validateLicense(req.body.key, req.body.clientId, false);
    if (!result.ok) return res.status(result.status).json({ valid: false, error: result.message, expiresAt: result.expiresAt });
    res.json({ valid: true, expiresAt: result.expiresAt });
  } catch (err) {
    next(err);
  }
});

app.get('/api/download/windows', licenseLimiter, async (req, res, next) => {
  try {
    const ticket = String(req.query.ticket || '');
    let payload;
    try {
      payload = jwt.verify(ticket, JWT_SECRET);
      if (payload.type !== 'download') throw new Error('bad type');
    } catch {
      return res.status(401).send('Invalid or expired download ticket.');
    }

    const result = await pool.query(
      `SELECT id, client_id, expires_at, revoked FROM licenses WHERE id = $1 LIMIT 1`,
      [payload.licenseId]
    );
    if (!result.rowCount) return res.status(404).send('License not found.');
    const license = result.rows[0];
    if (license.revoked || new Date(license.expires_at).getTime() <= Date.now()) {
      return res.status(403).send('License is no longer active.');
    }
    if (license.client_id !== payload.clientId) return res.status(403).send('Client ID mismatch.');

    const filePath = path.join(__dirname, 'protected', DOWNLOAD_FILENAME);
    if (!fs.existsSync(filePath)) {
      return res.status(503).send(`Owner setup incomplete: add ${DOWNLOAD_FILENAME} to the protected folder on the server.`);
    }
    res.download(filePath, DOWNLOAD_FILENAME);
  } catch (err) {
    next(err);
  }
});

app.get('/owner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Axiom Client website running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
