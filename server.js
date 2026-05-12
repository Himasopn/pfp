require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const { createWhatsAppSession } = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

app.use(express.json());
app.use(express.static('public'));

// ── Multer: memory storage, max 10 MB, images only ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ── POST /api/upload ─────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const sessionId = uuidv4();
    await db.createSession(sessionId, req.file.buffer);

    res.json({ sessionId });
  } catch (err) {
    console.error('[upload]', err.message);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

// ── POST /api/connect ────────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { sessionId, method, phoneNumber } = req.body;

  if (!sessionId || !method) {
    return res.status(400).json({ error: 'sessionId and method are required' });
  }

  try {
    const session = await db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session expired or not found. Please re-upload your image.' });
    }

    const imageBuffer = Buffer.from(session.image_data);
    const cleanPhone = phoneNumber?.replace(/[^0-9]/g, '') || null;

    if (method === 'pair' && !cleanPhone) {
      return res.status(400).json({ error: 'Phone number is required for pairing code method' });
    }

    // Fire-and-forget: WA session runs async and emits events via socket.io
    createWhatsAppSession(sessionId, imageBuffer, io, {
      method,
      phoneNumber: cleanPhone,
    }).catch((err) => {
      console.error('[ws-session]', err.message);
      io.to(sessionId).emit('error', { message: 'Failed to start WhatsApp session.' });
    });

    // Also delete from DB once handed off (image is in memory now)
    await db.deleteSession(sessionId);

    res.json({ success: true });
  } catch (err) {
    console.error('[connect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join', (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length > 64) return;
    socket.join(sessionId);
    socket.emit('joined', { sessionId });
  });

  socket.on('disconnect', () => {});
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 FullPP server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ DB init failed:', err);
    process.exit(1);
  });
