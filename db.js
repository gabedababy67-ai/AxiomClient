const { Pool } = require('pg');

const sslEnabled = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id BIGSERIAL PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      key_preview TEXT NOT NULL,
      client_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS licenses_expires_idx ON licenses(expires_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS licenses_client_idx ON licenses(client_id);`);
}

module.exports = { pool, initDb };
