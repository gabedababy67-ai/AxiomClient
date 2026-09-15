require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { pool, initDb } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const DOWNLOAD_FILENAME = process.env.DOWNLOAD_FILENAME || 'Axiom-Client.jar';
const SESSION_COOKIE = 'axiom_session';
const OAUTH_STATE_COOKIE = 'axiom_oauth_state';
const OAUTH_NEXT_COOKIE = 'axiom_oauth_next';

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const allowedRoleIds = splitIds(process.env.DISCORD_ALLOWED_ROLE_IDS || '');
const ownerRoleIds = splitIds(process.env.DISCORD_OWNER_ROLE_IDS || '');
const DISCORD_CUSTOMER_ROLE_ID = process.env.DISCORD_CUSTOMER_ROLE_ID || allowedRoleIds[0] || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_MONTHLY_PRICE_ID = process.env.STRIPE_MONTHLY_PRICE_ID || '';
const STRIPE_LIFETIME_PRICE_ID = process.env.STRIPE_LIFETIME_PRICE_ID || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const MONTHLY_PRICE_USD = Number(process.env.MONTHLY_PRICE_USD || '15.99');
const LIFETIME_PRICE_USD = Number(process.env.LIFETIME_PRICE_USD || '25.99');
const LICENSE_ENCRYPTION_KEY = process.env.LICENSE_ENCRYPTION_KEY || JWT_SECRET;

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
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
// Stripe must receive the unmodified raw request body for webhook signature verification.
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/index.html', (req, res) => res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const licenseLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false });

function splitIds(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}
function normalizeKey(value) { return String(value || '').trim().toUpperCase(); }
function hashText(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function hashKey(key) { return hashText(normalizeKey(key)); }
function generateLicenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(32);
  let raw = '';
  for (let i = 0; i < 32; i++) raw += alphabet[bytes[i] % alphabet.length];
  return `AXIOM-${raw.match(/.{1,8}/g).join('-')}`;
}

function encryptionKey() {
  return crypto.createHash('sha256').update(String(LICENSE_ENCRYPTION_KEY)).digest();
}
function encryptLicenseKey(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptLicenseKey(value) {
  if (!value) return null;
  try {
    const [ivText, tagText, dataText] = String(value).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}
function planAmount(plan) {
  return plan === 'monthly' ? MONTHLY_PRICE_USD : plan === 'lifetime' ? LIFETIME_PRICE_USD : null;
}
function lifetimeExpiry() { return new Date('2126-01-01T00:00:00.000Z'); }
function addDays(date, days) { return new Date(new Date(date).getTime() + days * 86400000); }
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = sortObject(value[key]); return out; }, {});
  }
  return value;
}
function nowPaymentsSignatureIsValid(body, signature) {
  if (!NOWPAYMENTS_IPN_SECRET || !signature) return false;
  const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(JSON.stringify(sortObject(body))).digest('hex');
  return safeEqualText(expected, signature);
}
function publicBaseUrl(req) {
  return (process.env.PUBLIC_SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
async function grantCustomerRole(discordUserId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !DISCORD_CUSTOMER_ROLE_ID || !discordUserId) return { ok: false, skipped: true };
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${DISCORD_CUSTOMER_ROLE_ID}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn('Discord role grant failed:', response.status, text.slice(0, 300));
      return { ok: false, status: response.status };
    }
    try {
      const sessions = await pool.query(`SELECT id,roles FROM web_sessions WHERE discord_user_id=$1 AND expires_at>NOW()`, [discordUserId]);
      for (const row of sessions.rows) {
        const roles = Array.isArray(row.roles) ? row.roles : [];
        if (!roles.includes(DISCORD_CUSTOMER_ROLE_ID)) {
          roles.push(DISCORD_CUSTOMER_ROLE_ID);
          await pool.query(`UPDATE web_sessions SET roles=$1::jsonb WHERE id=$2`, [JSON.stringify(roles), row.id]);
        }
      }
    } catch (sessionErr) { console.warn('Could not refresh local Discord role cache:', sessionErr.message); }
    return { ok: true };
  } catch (err) {
    console.warn('Discord role grant failed:', err.message);
    return { ok: false };
  }
}
async function fulfillOrder(orderId, options = {}) {
  const client = await pool.connect();
  let resultForUser = null;
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(`SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!orderResult.rowCount) throw new Error('Payment order not found.');
    const order = orderResult.rows[0];

    const existingResult = await client.query(
      `SELECT * FROM licenses WHERE discord_user_id = $1 AND revoked = FALSE ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [order.discord_user_id]
    );
    let license = existingResult.rows[0] || null;

    let targetExpiry;
    if (order.plan === 'lifetime') targetExpiry = lifetimeExpiry();
    else if (options.periodEnd) targetExpiry = new Date(Number(options.periodEnd) * 1000);
    else {
      const start = license && new Date(license.expires_at).getTime() > Date.now() ? new Date(license.expires_at) : new Date();
      targetExpiry = addDays(start, 30);
    }

    if (order.fulfilled_at && license) {
      await client.query('COMMIT');
      resultForUser = { licenseId: license.id, key: decryptLicenseKey(license.key_ciphertext), expiresAt: license.expires_at, discordUserId: order.discord_user_id };
      await grantCustomerRole(order.discord_user_id);
      return resultForUser;
    }

    const paymentReference = options.subscriptionId || options.providerId || order.provider_subscription_id || order.provider_id || order.id;
    if (license && license.key_ciphertext) {
      const newType = (license.license_type === 'lifetime' || order.plan === 'lifetime') ? 'lifetime' : 'monthly';
      if (newType === 'lifetime') targetExpiry = lifetimeExpiry();
      const updated = await client.query(
        `UPDATE licenses SET expires_at = CASE WHEN $1 = 'lifetime' THEN $2 ELSE GREATEST(expires_at, $2) END,
         license_type = $1, payment_provider = $3, payment_reference = $4, note = $5
         WHERE id = $6 RETURNING *`,
        [newType, targetExpiry, order.provider, paymentReference, `${order.provider} ${order.plan} purchase`, license.id]
      );
      license = updated.rows[0];
    } else {
      const key = generateLicenseKey();
      const inserted = await client.query(
        `INSERT INTO licenses (key_hash,key_preview,key_ciphertext,discord_user_id,expires_at,note,license_type,payment_provider,payment_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [hashKey(key), `${key.slice(0, 14)}…`, encryptLicenseKey(key), order.discord_user_id, targetExpiry,
         `${order.provider} ${order.plan} purchase`, order.plan === 'lifetime' ? 'lifetime' : 'monthly', order.provider, paymentReference]
      );
      license = inserted.rows[0];
    }

    await client.query(
      `UPDATE payment_orders SET status = 'finished', fulfilled_at = COALESCE(fulfilled_at, NOW()),
       provider_id = COALESCE($2, provider_id), provider_subscription_id = COALESCE($3, provider_subscription_id),
       raw_status = COALESCE($4::jsonb, raw_status), updated_at = NOW() WHERE id = $1`,
      [order.id, options.providerId || null, options.subscriptionId || null, options.raw ? JSON.stringify(options.raw) : null]
    );
    await client.query('COMMIT');
    resultForUser = { licenseId: license.id, key: decryptLicenseKey(license.key_ciphertext), expiresAt: license.expires_at, discordUserId: order.discord_user_id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }

  if (resultForUser?.discordUserId) await grantCustomerRole(resultForUser.discordUserId);
  return resultForUser;
}
async function extendStripeSubscription(subscription) {
  if (!subscription) return;
  const orderId = subscription.metadata?.orderId;
  if (!orderId) return;
  const periodEnd = subscription.current_period_end;
  if (!periodEnd) return;
  const orderResult = await pool.query(`SELECT discord_user_id FROM payment_orders WHERE id = $1 LIMIT 1`, [orderId]);
  if (!orderResult.rowCount) return;
  await pool.query(
    `UPDATE licenses SET expires_at = GREATEST(expires_at, $1), payment_provider = 'stripe', payment_reference = $2, license_type = 'monthly'
     WHERE discord_user_id = $3 AND revoked = FALSE AND license_type <> 'lifetime'`,
    [new Date(Number(periodEnd) * 1000), subscription.id, orderResult.rows[0].discord_user_id]
  );
}
async function handleStripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook is not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Stripe webhook signature failed:', err.message);
    return res.status(400).send('Invalid Stripe signature.');
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;
      if (orderId && session.payment_status === 'paid') {
        let periodEnd = null;
        let subscriptionId = null;
        if (session.mode === 'subscription' && session.subscription) {
          subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          periodEnd = subscription.current_period_end || null;
        }
        await fulfillOrder(orderId, { providerId: session.id, subscriptionId, periodEnd, raw: session });
      }
    } else if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id || invoice.parent?.subscription_details?.subscription;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await extendStripeSubscription(subscription);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const orderId = subscription.metadata?.orderId;
      if (orderId) {
        const order = await pool.query(`SELECT discord_user_id FROM payment_orders WHERE id = $1 LIMIT 1`, [orderId]);
        if (order.rowCount) {
          const end = subscription.current_period_end ? new Date(Number(subscription.current_period_end) * 1000) : new Date();
          await pool.query(`UPDATE licenses SET expires_at = LEAST(expires_at, $1) WHERE discord_user_id = $2 AND payment_reference = $3 AND license_type <> 'lifetime'`, [end, order.rows[0].discord_user_id, subscription.id]);
        }
      }
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook processing failed:', err);
    return res.status(500).send('Webhook processing failed.');
  }
}

function safeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function parseDuration(body) {
  const amount = Number(body.amount);
  const unit = String(body.unit || '').toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0 || amount > 3650) return null;
  const multipliers = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000, months: 2592000000 };
  if (!multipliers[unit]) return null;
  return new Date(Date.now() + amount * multipliers[unit]);
}
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}
function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) { setCookie(res, name, '', { maxAge: 0 }); }
function sanitizeNext(value) {
  const text = String(value || '/dashboard');
  if (!text.startsWith('/') || text.startsWith('//')) return '/dashboard';
  return text.slice(0, 300);
}
function roleMatch(roles, required) {
  if (!required.length) return false;
  const set = new Set(Array.isArray(roles) ? roles : []);
  return required.some(id => set.has(id));
}
function hasDashboardRole(roles) { return roleMatch(roles, [...allowedRoleIds, ...ownerRoleIds]); }
function hasOwnerRole(roles) { return roleMatch(roles, ownerRoleIds); }
function discordConfigured() {
  return Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_GUILD_ID);
}

function callbackUrl(req) {
  return process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
}
function avatarUrl(user) {
  if (!user?.avatar) return '';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}
async function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const result = await pool.query(
    `SELECT discord_user_id, username, avatar, roles, expires_at FROM web_sessions WHERE token_hash = $1 AND expires_at > NOW() LIMIT 1`,
    [hashText(token)]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.discord_user_id,
    username: row.username,
    avatar: row.avatar || '',
    roles: Array.isArray(row.roles) ? row.roles : [],
    expiresAt: row.expires_at,
    isOwner: hasOwnerRole(row.roles),
    hasAccess: hasDashboardRole(row.roles)
  };
}
async function requireUser(req, res, next) {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Sign in with Discord first.' });
    req.userSession = session;
    next();
  } catch (err) { next(err); }
}
async function adminOnly(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.type === 'admin') { req.admin = payload; return next(); }
    } catch {}
  }
  try {
    const session = await getSession(req);
    if (session?.isOwner) { req.userSession = session; return next(); }
  } catch (err) { return next(err); }
  return res.status(401).json({ error: 'Owner access required.' });
}

async function validateLicense(key, clientId, bindIfEmpty = false) {
  const normalized = normalizeKey(key);
  const cid = String(clientId || '').trim();
  if (!normalized || !cid || cid.length > 180) return { ok: false, status: 400, message: 'Key and client ID are required.' };
  const result = await pool.query(
    `SELECT id, client_id, discord_user_id, expires_at, revoked, note FROM licenses WHERE key_hash = $1 LIMIT 1`,
    [hashKey(normalized)]
  );
  if (!result.rowCount) return { ok: false, status: 404, message: 'Invalid key.' };
  const row = result.rows[0];
  if (row.revoked) return { ok: false, status: 403, message: 'This key has been revoked.' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, status: 403, message: 'This key has expired.', expiresAt: row.expires_at };
  if (row.client_id && row.client_id !== cid) return { ok: false, status: 403, message: 'This key is already bound to another client ID.' };
  if (!row.client_id && !bindIfEmpty) return { ok: false, status: 403, message: 'This key must be activated before it can be checked.' };
  if (!row.client_id && bindIfEmpty) {
    await pool.query(`UPDATE licenses SET client_id = $1, activated_at = COALESCE(activated_at, NOW()), last_seen_at = NOW() WHERE id = $2`, [cid, row.id]);
  } else {
    await pool.query(`UPDATE licenses SET last_seen_at = NOW() WHERE id = $1`, [row.id]);
  }
  return { ok: true, id: row.id, expiresAt: row.expires_at, clientId: row.client_id || cid, discordUserId: row.discord_user_id, note: row.note || '' };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => {
  res.json({
    discordUrl: process.env.PUBLIC_DISCORD_URL || '#',
    version: process.env.PUBLIC_CLIENT_VERSION || '1.0.0',
    updated: process.env.PUBLIC_CLIENT_UPDATED || 'Latest',
    monthlyUrl: '/dashboard?tab=purchase&plan=monthly',
    lifetimeUrl: '/dashboard?tab=purchase&plan=lifetime',
    deviceSlotUrl: '/dashboard?tab=license',
    discordLoginConfigured: discordConfigured()
  });
});

app.get('/auth/discord', authLimiter, (req, res) => {
  if (!discordConfigured()) return res.redirect(`${sanitizeNext(req.query.next)}?error=discord_not_configured`);
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, OAUTH_STATE_COOKIE, state, { maxAge: 600 });
  setCookie(res, OAUTH_NEXT_COOKIE, sanitizeNext(req.query.next), { maxAge: 600 });
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: callbackUrl(req),
    scope: 'identify guilds.members.read',
    state,
    prompt: 'consent'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', authLimiter, async (req, res, next) => {
  try {
    const cookies = parseCookies(req);
    const nextPath = sanitizeNext(cookies[OAUTH_NEXT_COOKIE] || '/dashboard');
    if (!req.query.code || !req.query.state || req.query.state !== cookies[OAUTH_STATE_COOKIE]) {
      return res.redirect(`${nextPath}?error=oauth_state`);
    }
    clearCookie(res, OAUTH_STATE_COOKIE);
    clearCookie(res, OAUTH_NEXT_COOKIE);

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: callbackUrl(req)
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return res.redirect(`${nextPath}?error=oauth_token`);

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const [userResponse, memberResponse] = await Promise.all([
      fetch('https://discord.com/api/v10/users/@me', { headers }),
      fetch(`https://discord.com/api/v10/users/@me/guilds/${DISCORD_GUILD_ID}/member`, { headers })
    ]);
    if (!userResponse.ok) return res.redirect(`${nextPath}?error=discord_user`);
    if (!memberResponse.ok) return res.redirect(`${nextPath}?error=not_in_server`);
    const user = await userResponse.json();
    const member = await memberResponse.json();
    const roles = Array.isArray(member.roles) ? member.roles : [];

    const rawSession = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(`DELETE FROM web_sessions WHERE discord_user_id = $1 OR expires_at <= NOW()`, [user.id]);
    await pool.query(
      `INSERT INTO web_sessions (token_hash, discord_user_id, username, avatar, roles, expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [hashText(rawSession), user.id, user.global_name || user.username || 'Discord User', avatarUrl(user), JSON.stringify(roles), expiresAt]
    );
    setCookie(res, SESSION_COOKIE, rawSession, { maxAge: 24 * 60 * 60 });
    res.redirect(nextPath);
  } catch (err) { next(err); }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await pool.query(`DELETE FROM web_sessions WHERE token_hash = $1`, [hashText(token)]);
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/auth/me', async (req, res, next) => {
  try {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, user: session });
  } catch (err) { next(err); }
});


app.get('/api/payments/config', requireUser, (req, res) => {
  res.json({
    stripeConfigured: Boolean(stripe && STRIPE_MONTHLY_PRICE_ID && STRIPE_LIFETIME_PRICE_ID && STRIPE_WEBHOOK_SECRET),
    ltcConfigured: Boolean(NOWPAYMENTS_API_KEY && NOWPAYMENTS_IPN_SECRET),
    monthlyPriceUsd: MONTHLY_PRICE_USD,
    lifetimePriceUsd: LIFETIME_PRICE_USD,
    monthlyLabel: '30 days / recurring by card',
    lifetimeLabel: 'Lifetime access'
  });
});

app.post('/api/payments/stripe/checkout', requireUser, writeLimiter, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured yet.' });
    const plan = String(req.body.plan || '');
    if (!['monthly', 'lifetime'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
    const existing = await pool.query(`SELECT license_type,payment_provider,payment_reference FROM licenses WHERE discord_user_id=$1 AND revoked=FALSE AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`, [req.userSession.id]);
    if (existing.rows[0]?.license_type === 'lifetime') return res.status(409).json({ error: 'This account already has lifetime Axiom access.' });
    if (plan === 'monthly' && existing.rows[0]?.license_type === 'monthly' && existing.rows[0]?.payment_provider === 'stripe' && String(existing.rows[0]?.payment_reference || '').startsWith('sub_')) {
      return res.status(409).json({ error: 'This account already has an active Stripe monthly subscription.' });
    }
    const priceId = plan === 'monthly' ? STRIPE_MONTHLY_PRICE_ID : STRIPE_LIFETIME_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: `Stripe ${plan} Price ID is not configured.` });

    const orderId = crypto.randomUUID();
    const amount = planAmount(plan);
    await pool.query(
      `INSERT INTO payment_orders (id,discord_user_id,provider,plan,amount_usd,status) VALUES ($1,$2,'stripe',$3,$4,'created')`,
      [orderId, req.userSession.id, plan, amount]
    );

    const base = publicBaseUrl(req);
    const sessionOptions = {
      mode: plan === 'monthly' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/dashboard?tab=license&purchase=success`,
      cancel_url: `${base}/dashboard?tab=purchase&purchase=cancelled`,
      client_reference_id: req.userSession.id,
      metadata: { orderId, discordUserId: req.userSession.id, plan },
      allow_promotion_codes: true
    };
    if (plan === 'monthly') {
      sessionOptions.subscription_data = { metadata: { orderId, discordUserId: req.userSession.id, plan } };
    }
    const session = await stripe.checkout.sessions.create(sessionOptions);
    await pool.query(`UPDATE payment_orders SET provider_id = $2, status = 'checkout', updated_at = NOW() WHERE id = $1`, [orderId, session.id]);
    res.json({ url: session.url, orderId });
  } catch (err) { next(err); }
});

app.post('/api/payments/ltc/checkout', requireUser, writeLimiter, async (req, res, next) => {
  try {
    if (!NOWPAYMENTS_API_KEY || !NOWPAYMENTS_IPN_SECRET) return res.status(503).json({ error: 'Litecoin payments are not configured yet.' });
    const plan = String(req.body.plan || '');
    if (!['monthly', 'lifetime'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
    const existing = await pool.query(`SELECT license_type FROM licenses WHERE discord_user_id=$1 AND revoked=FALSE AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`, [req.userSession.id]);
    if (existing.rows[0]?.license_type === 'lifetime') return res.status(409).json({ error: 'This account already has lifetime Axiom access.' });
    const amount = planAmount(plan);
    const orderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payment_orders (id,discord_user_id,provider,plan,amount_usd,status,pay_currency) VALUES ($1,$2,'nowpayments',$3,$4,'created','ltc')`,
      [orderId, req.userSession.id, plan, amount]
    );

    const base = publicBaseUrl(req);
    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        pay_currency: 'ltc',
        ipn_callback_url: `${base}/api/payments/nowpayments/ipn`,
        order_id: orderId,
        order_description: `Axiom Client ${plan === 'monthly' ? '30-day' : 'Lifetime'} access`
      })
    });
    const data = await response.json();
    if (!response.ok || !data.payment_id) {
      await pool.query(`UPDATE payment_orders SET status = 'failed', raw_status = $2::jsonb, updated_at = NOW() WHERE id = $1`, [orderId, JSON.stringify(data)]);
      return res.status(502).json({ error: data.message || 'Could not create Litecoin payment.' });
    }
    await pool.query(
      `UPDATE payment_orders SET provider_id = $2, status = $3, pay_amount = $4, pay_address = $5, raw_status = $6::jsonb, updated_at = NOW() WHERE id = $1`,
      [orderId, String(data.payment_id), data.payment_status || 'waiting', String(data.pay_amount || ''), data.pay_address || '', JSON.stringify(data)]
    );
    res.json({
      orderId,
      paymentId: String(data.payment_id),
      status: data.payment_status || 'waiting',
      payAmount: String(data.pay_amount || ''),
      payAddress: data.pay_address || '',
      payCurrency: 'LTC',
      priceUsd: amount
    });
  } catch (err) { next(err); }
});

app.post('/api/payments/nowpayments/ipn', async (req, res, next) => {
  try {
    const signature = String(req.get('x-nowpayments-sig') || '');
    if (!nowPaymentsSignatureIsValid(req.body, signature)) return res.status(401).send('Invalid NOWPayments signature.');
    const orderId = String(req.body.order_id || '');
    if (!orderId) return res.status(400).send('Missing order ID.');
    const status = String(req.body.payment_status || 'unknown');
    const result = await pool.query(`SELECT id FROM payment_orders WHERE id = $1 AND provider = 'nowpayments' LIMIT 1`, [orderId]);
    if (!result.rowCount) return res.status(404).send('Order not found.');
    await pool.query(
      `UPDATE payment_orders SET status=$2, provider_id=COALESCE($3,provider_id), pay_amount=COALESCE($4,pay_amount),
       pay_address=COALESCE($5,pay_address), raw_status=$6::jsonb, updated_at=NOW() WHERE id=$1`,
      [orderId, status, req.body.payment_id ? String(req.body.payment_id) : null, req.body.pay_amount ? String(req.body.pay_amount) : null, req.body.pay_address || null, JSON.stringify(req.body)]
    );
    if (status === 'finished') await fulfillOrder(orderId, { providerId: req.body.payment_id ? String(req.body.payment_id) : null, raw: req.body });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/payments/ltc/status/:orderId', requireUser, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '');
    let orderResult = await pool.query(`SELECT * FROM payment_orders WHERE id=$1 AND discord_user_id=$2 AND provider='nowpayments' LIMIT 1`, [orderId, req.userSession.id]);
    if (!orderResult.rowCount) return res.status(404).json({ error: 'Payment not found.' });
    let order = orderResult.rows[0];

    if (NOWPAYMENTS_API_KEY && order.provider_id && order.status !== 'finished') {
      try {
        const remote = await fetch(`https://api.nowpayments.io/v1/payment/${encodeURIComponent(order.provider_id)}`, { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } });
        if (remote.ok) {
          const data = await remote.json();
          const status = String(data.payment_status || order.status);
          await pool.query(
            `UPDATE payment_orders SET status=$2,pay_amount=COALESCE($3,pay_amount),pay_address=COALESCE($4,pay_address),raw_status=$5::jsonb,updated_at=NOW() WHERE id=$1`,
            [orderId, status, data.pay_amount ? String(data.pay_amount) : null, data.pay_address || null, JSON.stringify(data)]
          );
          if (status === 'finished') await fulfillOrder(orderId, { providerId: String(data.payment_id || order.provider_id), raw: data });
          order.status = status;
          order.pay_amount = data.pay_amount ? String(data.pay_amount) : order.pay_amount;
          order.pay_address = data.pay_address || order.pay_address;
        }
      } catch (pollErr) { console.warn('NOWPayments status poll failed:', pollErr.message); }
    }

    const refreshed = await pool.query(`SELECT status,pay_amount,pay_address,fulfilled_at FROM payment_orders WHERE id=$1 LIMIT 1`, [orderId]);
    res.json({ orderId, ...refreshed.rows[0], payCurrency: 'LTC' });
  } catch (err) { next(err); }
});

app.get('/api/payments/orders', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id,provider,plan,amount_usd,status,pay_currency,pay_amount,pay_address,fulfilled_at,created_at,updated_at
       FROM payment_orders WHERE discord_user_id=$1 ORDER BY created_at DESC LIMIT 25`,
      [req.userSession.id]
    );
    res.json({ orders: result.rows });
  } catch (err) { next(err); }
});

app.post('/api/admin/login', authLimiter, (req, res) => {
  const password = String(req.body.password || '');
  if (!safeEqualText(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Incorrect owner password.' });
  const token = jwt.sign({ type: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, expiresIn: 28800 });
});
app.get('/api/admin/session', adminOnly, (req, res) => res.json({ ok: true, viaDiscord: Boolean(req.userSession), user: req.userSession || null }));
app.post('/api/admin/licenses', adminOnly, async (req, res, next) => {
  try {
    const expiresAt = parseDuration(req.body);
    if (!expiresAt) return res.status(400).json({ error: 'Choose a valid duration.' });
    const requestedClientId = String(req.body.clientId || '').trim();
    const discordUserId = String(req.body.discordUserId || '').trim();
    if (requestedClientId.length > 180) return res.status(400).json({ error: 'Client ID is too long.' });
    if (discordUserId.length > 40) return res.status(400).json({ error: 'Discord user ID is too long.' });
    const note = String(req.body.note || '').trim().slice(0, 120);
    let key, inserted = false;
    for (let i = 0; i < 4 && !inserted; i++) {
      key = generateLicenseKey();
      try {
        await pool.query(
          `INSERT INTO licenses (key_hash, key_preview, key_ciphertext, client_id, discord_user_id, expires_at, note, license_type) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual')`,
          [hashKey(key), `${key.slice(0, 14)}…`, encryptLicenseKey(key), requestedClientId || null, discordUserId || null, expiresAt, note]
        );
        inserted = true;
      } catch (err) { if (err.code !== '23505') throw err; }
    }
    if (!inserted) throw new Error('Could not generate a unique key.');
    res.status(201).json({ key, expiresAt: expiresAt.toISOString(), clientId: requestedClientId || null, discordUserId: discordUserId || null, note });
  } catch (err) { next(err); }
});
app.get('/api/admin/licenses', adminOnly, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id,key_preview,client_id,discord_user_id,expires_at,revoked,note,created_at,activated_at,last_seen_at,
      (expires_at > NOW() AND revoked = FALSE) AS active FROM licenses ORDER BY created_at DESC LIMIT 250
    `);
    res.json({ licenses: result.rows });
  } catch (err) { next(err); }
});
app.post('/api/admin/licenses/:id/revoke', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid license ID.' });
    const result = await pool.query(`UPDATE licenses SET revoked = TRUE WHERE id = $1 RETURNING id`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'License not found.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
app.post('/api/admin/licenses/:id/unbind', adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid license ID.' });
    const result = await pool.query(`UPDATE licenses SET client_id = NULL, activated_at = NULL, last_seen_at = NULL WHERE id = $1 RETURNING id`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'License not found.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/license/activate', licenseLimiter, async (req, res, next) => {
  try {
    const result = await validateLicense(req.body.key, req.body.clientId, true);
    if (!result.ok) return res.status(result.status).json({ valid: false, error: result.message, expiresAt: result.expiresAt });
    const downloadTicket = jwt.sign({ type: 'download', licenseId: result.id, clientId: result.clientId }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ valid: true, message: 'Key successful', expiresAt: result.expiresAt, downloadTicket });
  } catch (err) { next(err); }
});
app.post('/api/license/check', licenseLimiter, async (req, res, next) => {
  try {
    const result = await validateLicense(req.body.key, req.body.clientId, false);
    if (!result.ok) return res.status(result.status).json({ valid: false, error: result.message, expiresAt: result.expiresAt });
    res.json({ valid: true, expiresAt: result.expiresAt });
  } catch (err) { next(err); }
});

app.get('/api/dashboard/license', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id,key_preview,key_ciphertext,client_id,expires_at,revoked,note,license_type,payment_provider,payment_reference,created_at,activated_at,last_seen_at,
      (expires_at > NOW() AND revoked = FALSE) AS active
      FROM licenses WHERE discord_user_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [req.userSession.id]);
    if (!result.rowCount) return res.json({ license: null });
    const license = result.rows[0];
    license.key = decryptLicenseKey(license.key_ciphertext);
    delete license.key_ciphertext;
    res.json({ license });
  } catch (err) { next(err); }
});
app.post('/api/dashboard/redeem', requireUser, licenseLimiter, async (req, res, next) => {
  try {
    const result = await validateLicense(req.body.key, req.body.clientId, true);
    if (!result.ok) return res.status(result.status).json({ valid: false, error: result.message });
    const claimed = await pool.query(
      `UPDATE licenses SET discord_user_id = $1 WHERE id = $2 AND (discord_user_id IS NULL OR discord_user_id = $1) RETURNING id,expires_at,client_id,key_preview`,
      [req.userSession.id, result.id]
    );
    if (!claimed.rowCount) return res.status(403).json({ error: 'This key belongs to another Discord account.' });
    res.json({ valid: true, message: 'Key successful', license: claimed.rows[0] });
  } catch (err) { next(err); }
});
app.post('/api/dashboard/download-ticket', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,client_id,expires_at,revoked FROM licenses WHERE discord_user_id = $1 AND expires_at > NOW() AND revoked = FALSE ORDER BY created_at DESC LIMIT 1`, [req.userSession.id]);
    if (!result.rowCount) return res.status(403).json({ error: 'No active Axiom license is linked to this Discord account.' });
    const license = result.rows[0];
    const ticket = jwt.sign({ type: 'download-account', licenseId: license.id, discordUserId: req.userSession.id }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ ticket });
  } catch (err) { next(err); }
});
app.post('/api/dashboard/hwid-reset', requireUser, writeLimiter, async (req, res, next) => {
  let client;
  try {
    const licenseResult = await pool.query(`SELECT id FROM licenses WHERE discord_user_id = $1 AND expires_at > NOW() AND revoked = FALSE ORDER BY created_at DESC LIMIT 1`, [req.userSession.id]);
    if (!licenseResult.rowCount) return res.status(404).json({ error: 'No active license found.' });
    const licenseId = licenseResult.rows[0].id;
    const resets = await pool.query(`SELECT COUNT(*)::int AS count FROM hwid_resets WHERE discord_user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`, [req.userSession.id]);
    if (resets.rows[0].count >= 2) return res.status(429).json({ error: 'You already used 2 device resets in the last 30 days.' });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`UPDATE licenses SET client_id = NULL, activated_at = NULL, last_seen_at = NULL WHERE id = $1`, [licenseId]);
    await client.query(`INSERT INTO hwid_resets (discord_user_id, license_id) VALUES ($1,$2)`, [req.userSession.id, licenseId]);
    await client.query('COMMIT');
    res.json({ ok: true, remaining: 1 - resets.rows[0].count });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    next(err);
  } finally {
    if (client) client.release();
  }
});
app.get('/api/dashboard/hwid-reset-status', requireUser, async (req, res, next) => {
  try {
    const resets = await pool.query(`SELECT COUNT(*)::int AS count FROM hwid_resets WHERE discord_user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`, [req.userSession.id]);
    res.json({ used: resets.rows[0].count, remaining: Math.max(0, 2 - resets.rows[0].count) });
  } catch (err) { next(err); }
});
app.get('/api/dashboard/default-config', requireUser, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="axiom-default-config.json"');
  res.type('application/json').send(JSON.stringify({ theme: 'dark', keybind: 'RIGHT_SHIFT', hud: true, notifications: true, modules: {} }, null, 2));
});
app.post('/api/dashboard/analyze-log', requireUser, writeLimiter, (req, res) => {
  const log = String(req.body.log || '').slice(0, 300000);
  if (!log.trim()) return res.status(400).json({ error: 'Paste a crash log first.' });
  const checks = [
    [/OutOfMemoryError|Java heap space/i, 'Java ran out of memory. Raise the launcher memory allocation or remove unusually heavy mods/resource packs.'],
    [/MixinApplyError|MixinTransformerError/i, 'A mixin failed to apply. This usually points to an incompatible mod version or two mods editing the same code.'],
    [/NoSuchMethodError|NoSuchFieldError/i, 'A mod is calling code that does not exist in the installed version. Check Minecraft, Fabric Loader, Fabric API, and mod version compatibility.'],
    [/ModResolutionException|Incompatible mods found/i, 'Fabric found incompatible or missing dependencies. Read the lines immediately below the error for the exact mod and required version.'],
    [/UnsupportedClassVersionError/i, 'The Java version is wrong for one of the installed files. Use the Java version required by your Minecraft version.'],
    [/Connection refused|Connection timed out/i, 'A network connection failed. Confirm the server/API address is reachable and that the service is running.']
  ];
  const findings = checks.filter(([re]) => re.test(log)).map(([, text]) => text);
  res.json({ findings: findings.length ? findings : ['No common signature was detected. Check the first “Caused by:” section and the earliest mod named around it.'] });
});

app.get('/api/community/:type', async (req, res, next) => {
  try {
    const type = String(req.params.type);
    if (!['review','suggestion','basefind'].includes(type)) return res.status(404).json({ error: 'Unknown feed.' });
    if (type !== 'review') {
      const session = await getSession(req);
      if (!session?.hasAccess) return res.status(401).json({ error: 'Authorized Discord access required.' });
    }
    const limit = type === 'review' ? 12 : 50;
    const result = await pool.query(`SELECT id,username,title,body,rating,created_at FROM community_posts WHERE post_type = $1 ORDER BY created_at DESC LIMIT $2`, [type, limit]);
    res.json({ posts: result.rows });
  } catch (err) { next(err); }
});
app.post('/api/community/:type', requireUser, writeLimiter, async (req, res, next) => {
  try {
    const type = String(req.params.type);
    if (!['review','suggestion','basefind'].includes(type)) return res.status(404).json({ error: 'Unknown feed.' });
    const body = String(req.body.body || '').trim().slice(0, 1800);
    const title = String(req.body.title || '').trim().slice(0, 100);
    const rating = type === 'review' ? Math.min(5, Math.max(1, Number(req.body.rating) || 5)) : null;
    if (!body) return res.status(400).json({ error: 'Write something first.' });
    await pool.query(`INSERT INTO community_posts (post_type,discord_user_id,username,title,body,rating) VALUES ($1,$2,$3,$4,$5,$6)`, [type, req.userSession.id, req.userSession.username, title, body, rating]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/download/windows', licenseLimiter, async (req, res, next) => {
  try {
    let payload;
    try {
      payload = jwt.verify(String(req.query.ticket || ''), JWT_SECRET);
      if (!['download','download-account'].includes(payload.type)) throw new Error('bad type');
    } catch { return res.status(401).send('Invalid or expired download ticket.'); }
    const result = await pool.query(`SELECT id,client_id,expires_at,revoked FROM licenses WHERE id = $1 LIMIT 1`, [payload.licenseId]);
    if (!result.rowCount) return res.status(404).send('License not found.');
    const license = result.rows[0];
    if (license.revoked || new Date(license.expires_at).getTime() <= Date.now()) return res.status(403).send('License is no longer active.');
    if (payload.type === 'download' && license.client_id !== payload.clientId) return res.status(403).send('Client ID mismatch.');
    if (payload.type === 'download-account') {
      const owner = await pool.query(`SELECT discord_user_id FROM licenses WHERE id = $1 LIMIT 1`, [payload.licenseId]);
      if (!owner.rowCount || owner.rows[0].discord_user_id !== payload.discordUserId) return res.status(403).send('Account mismatch.');
    }
    const filePath = path.join(__dirname, 'protected', DOWNLOAD_FILENAME);
    if (!fs.existsSync(filePath)) return res.status(503).send(`Owner setup incomplete: add ${DOWNLOAD_FILENAME} to the protected folder on the server.`);
    res.download(filePath, DOWNLOAD_FILENAME);
  } catch (err) { next(err); }
});

app.get('/', async (req, res, next) => {
  try {
    const session = await getSession(req);
    if (!session) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (err) { next(err); }
});
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/owner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error.' });
});

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Axiom Client website running on port ${PORT}`));
}).catch((err) => {
  console.error('Database initialization failed:', err);
  process.exit(1);
});
