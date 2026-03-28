const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS flowboard_state (id TEXT PRIMARY KEY DEFAULT 'main', data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    console.log('DB tablosu hazir.');
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

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/state', async (req, res) => res.json({ data: await loadState() }));

io.on('connection', (socket) => {
  console.log('Baglandi: ' + socket.id);
  socket.on('request_state', async () => { const d = await loadState(); if(d) socket.emit('state_loaded', d); });
  socket.on('state_update', async (data) => { await saveState(data); socket.broadcast.emit('state_sync', data); });
});

initDB().then(() => server.listen(PORT, () => console.log('Calisiyor: ' + PORT)));
