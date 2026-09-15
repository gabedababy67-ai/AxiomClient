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
      discord_user_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ
    );
  `);
  await pool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS discord_user_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS licenses_expires_idx ON licenses(expires_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS licenses_client_idx ON licenses(client_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS licenses_discord_idx ON licenses(discord_user_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      discord_user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar TEXT,
      roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS web_sessions_token_idx ON web_sessions(token_hash);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS web_sessions_expires_idx ON web_sessions(expires_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id BIGSERIAL PRIMARY KEY,
      post_type TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      title TEXT DEFAULT '',
      body TEXT NOT NULL,
      rating INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS community_posts_type_idx ON community_posts(post_type, created_at DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hwid_resets (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id TEXT NOT NULL,
      license_id BIGINT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS hwid_resets_user_idx ON hwid_resets(discord_user_id, created_at DESC);`);
}

module.exports = { pool, initDb };
