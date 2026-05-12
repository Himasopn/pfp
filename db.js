require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pp_sessions (
      id          VARCHAR(36)  PRIMARY KEY,
      image_data  BYTEA        NOT NULL,
      status      VARCHAR(50)  DEFAULT 'pending',
      created_at  TIMESTAMP    DEFAULT NOW(),
      expires_at  TIMESTAMP    DEFAULT NOW() + INTERVAL '15 minutes'
    );
  `);

  // Clean expired sessions every minute
  setInterval(async () => {
    try {
      await pool.query("DELETE FROM pp_sessions WHERE expires_at < NOW()");
    } catch (_) {}
  }, 60 * 1000);

  console.log('✅ Database ready');
}

async function createSession(id, imageData) {
  await pool.query(
    'INSERT INTO pp_sessions (id, image_data) VALUES ($1, $2)',
    [id, imageData]
  );
}

async function getSession(id) {
  const res = await pool.query(
    'SELECT * FROM pp_sessions WHERE id = $1 AND expires_at > NOW()',
    [id]
  );
  return res.rows[0] || null;
}

async function deleteSession(id) {
  await pool.query('DELETE FROM pp_sessions WHERE id = $1', [id]);
}

module.exports = { init, createSession, getSession, deleteSession };
