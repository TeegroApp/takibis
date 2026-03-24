const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id        SERIAL PRIMARY KEY,
        name      TEXT NOT NULL,
        email     TEXT UNIQUE NOT NULL,
        role      TEXT NOT NULL DEFAULT 'member',
        color     TEXT NOT NULL DEFAULT '#3D7FFF',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sectors (
        id        SERIAL PRIMARY KEY,
        name      TEXT NOT NULL,
        icon      TEXT NOT NULL DEFAULT '📋',
        color     TEXT NOT NULL DEFAULT '#3D7FFF',
        columns   JSONB NOT NULL DEFAULT '["Bekliyor","Devam Ediyor","Tamamlandı"]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          SERIAL PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT,
        priority    TEXT NOT NULL DEFAULT 'mid',
        status      TEXT NOT NULL DEFAULT 'Bekliyor',
        sector_id   INTEGER REFERENCES sectors(id) ON DELETE SET NULL,
        deadline    DATE,
        progress    INTEGER NOT NULL DEFAULT 0,
        archived    BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS task_assignments (
        id      SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (task_id, user_id)
      );
    `);
    console.log('✓ Database tables ready');
  } finally {
    client.release();
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(__dirname));

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', message: err.message });
  }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

app.post('/api/tasks', async (req, res, next) => {
  try {
    const { title, description, priority = 'mid', status = 'Bekliyor', sector_id, deadline, progress = 0, assignee_ids = [] } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const { rows } = await pool.query(
      `INSERT INTO tasks (title, description, priority, status, sector_id, deadline, progress)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, description || null, priority, status, sector_id || null, deadline || null, progress]
    );
    const task = rows[0];

    if (assignee_ids.length > 0) {
      const values = assignee_ids.map((uid, i) => `($1, ${i + 2})`).join(', ');
      await pool.query(
        `INSERT INTO task_assignments (task_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [task.id, ...assignee_ids]
      );
    }

    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

app.get('/api/tasks', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.*,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('id', u.id, 'name', u.name, 'color', u.color)
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'
        ) AS assignees
      FROM tasks t
      LEFT JOIN task_assignments ta ON ta.task_id = t.id
      LEFT JOIN users u ON u.id = ta.user_id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.put('/api/tasks/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, priority, status, sector_id, deadline, progress, archived, assignee_ids } = req.body;

    const { rows } = await pool.query(
      `UPDATE tasks SET
        title       = COALESCE($1, title),
        description = COALESCE($2, description),
        priority    = COALESCE($3, priority),
        status      = COALESCE($4, status),
        sector_id   = COALESCE($5, sector_id),
        deadline    = COALESCE($6, deadline),
        progress    = COALESCE($7, progress),
        archived    = COALESCE($8, archived),
        updated_at  = NOW()
       WHERE id = $9
       RETURNING *`,
      [title, description, priority, status, sector_id, deadline, progress, archived, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    if (Array.isArray(assignee_ids)) {
      await pool.query('DELETE FROM task_assignments WHERE task_id = $1', [id]);
      if (assignee_ids.length > 0) {
        const values = assignee_ids.map((uid, i) => `($1, ${i + 2})`).join(', ');
        await pool.query(
          `INSERT INTO task_assignments (task_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
          [id, ...assignee_ids]
        );
      }
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/tasks/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Users ─────────────────────────────────────────────────────────────────────

app.post('/api/users', async (req, res, next) => {
  try {
    const { name, email, role = 'member', color = '#3D7FFF' } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

    const { rows } = await pool.query(
      `INSERT INTO users (name, email, role, color) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, email, role, color]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
});

app.get('/api/users', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── Sectors ───────────────────────────────────────────────────────────────────

app.post('/api/sectors', async (req, res, next) => {
  try {
    const { name, icon = '📋', color = '#3D7FFF', columns } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { rows } = await pool.query(
      `INSERT INTO sectors (name, icon, color, columns) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, icon, color, JSON.stringify(columns || ['Bekliyor', 'Devam Ediyor', 'Tamamlandı'])]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

app.get('/api/sectors', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sectors ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── Static / SPA fallback ─────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`FlowBoard çalışıyor: http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
