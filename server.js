const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'flowboard-secret-key-change-in-production';

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS flowboard_state (id TEXT PRIMARY KEY DEFAULT 'main', data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB tablolari hazir.');
  } catch (e) { console.error('DB init hatasi:', e.message); }
}

async function loadState() {
  if (!pool) return null;
  try {
    const res = await pool.query("SELECT data FROM flowboard_state WHERE id = 'main'");
    return res.rows[0]?.data || null;
  } catch (e) { return null; }
}

async function saveState(data) {
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO flowboard_state (id, data, updated_at) VALUES ('main', $1, NOW()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`, [JSON.stringify(data)]);
  } catch (e) { console.error('Kaydetme hatasi:', e.message); }
}

// ── Auth middleware for REST routes ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' });
  }
}

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Registration ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
  }
  if (username.trim().length < 3) {
    return res.status(400).json({ error: 'Kullanıcı adı en az 3 karakter olmalıdır.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
  }
  if (!pool) return res.status(503).json({ error: 'Veritabanı bağlantısı yok.' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, username: user.username, id: user.id });
  } catch (e) {
    console.error('Kayıt hatası:', e.message);
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
  }
  if (!pool) return res.status(503).json({ error: 'Veritabanı bağlantısı yok.' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, id: user.id });
  } catch (e) {
    console.error('Giriş hatası:', e.message);
    res.status(500).json({ error: 'Sunucu hatası.' });
  }
});

// ── Protected state endpoint ──────────────────────────────────────────────────
app.get('/api/state', requireAuth, async (req, res) => res.json({ data: await loadState() }));

// ── Socket.IO — JWT authentication middleware ─────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Kimlik doğrulama gerekli.'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Geçersiz token.'));
  }
});

io.on('connection', (socket) => {
  console.log(`Baglandi: ${socket.id} (${socket.user?.username})`);
  io.emit('users_online', io.engine.clientsCount);

  socket.on('request_state', async () => {
    const d = await loadState();
    if (d) socket.emit('state_loaded', d);
  });

  socket.on('state_update', async (data) => {
    await saveState(data);
    socket.broadcast.emit('state_sync', data);
  });

  socket.on('disconnect', () => {
    io.emit('users_online', io.engine.clientsCount);
  });
});

initDB().then(() => server.listen(PORT, () => console.log('Calisiyor: ' + PORT)));
