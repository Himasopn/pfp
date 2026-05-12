const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} = require('gifted-baileys');
const { Boom } = require('@hapi/boom');
const { Jimp } = require('jimp');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const pino = require('pino');

const S_WHATSAPP_NET = '@s.whatsapp.net';
const activeSessions = new Map();

async function createWhatsAppSession(sessionId, imageBuffer, io, options = {}) {
  const { method = 'qr', phoneNumber = null } = options;

  const tempDir = path.join(os.tmpdir(), `fullpp_${sessionId}`);
  await fs.mkdir(tempDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(tempDir);
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    generateHighQualityLinkPreview: false,
  });

  const sessionData = { sock, tempDir, done: false };
  activeSessions.set(sessionId, sessionData);

  let pairingCodeRequested = false;

  // Auto-expire session after 5 minutes of no connection
  const timeoutHandle = setTimeout(() => {
    if (!sessionData.done) {
      emit(io, sessionId, 'error', { message: 'Connection timed out. Please try again.' });
      cleanupSession(sessionId);
    }
  }, 5 * 60 * 1000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR / Pairing ──────────────────────────────────────────────────────────
    if (qr) {
      if (method === 'qr') {
        try {
          const dataUrl = await QRCode.toDataURL(qr, {
            width: 260,
            margin: 2,
            color: { dark: '#1C1C1E', light: '#FFFFFF' },
          });
          emit(io, sessionId, 'qr', { qr: dataUrl });
        } catch (_) {
          emit(io, sessionId, 'qr', { qr });
        }
      } else if (method === 'pair' && phoneNumber && !pairingCodeRequested) {
        pairingCodeRequested = true;
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          const formatted = (code || '').match(/.{1,4}/g)?.join('-') || code;
          emit(io, sessionId, 'pairing_code', { code: formatted });
        } catch (err) {
          emit(io, sessionId, 'error', {
            message: 'Could not generate pairing code. Make sure the number is registered on WhatsApp.',
          });
        }
      }
    }

    // ── Connected ─────────────────────────────────────────────────────────────
    if (connection === 'open') {
      clearTimeout(timeoutHandle);
      if (sessionData.done) return;
      sessionData.done = true;

      emit(io, sessionId, 'status', { message: 'Connected! Setting your profile picture...' });

      try {
        await setFullPP(sock, imageBuffer);

        // Notify self: send message to own number
        const selfJid = jidNormalizedUser(sock.user.id);
        await sock.sendMessage(selfJid, { text: '*PFP CHANGED 🤍*' });

        emit(io, sessionId, 'success', { message: 'Profile picture updated!' });
      } catch (err) {
        console.error('[fullpp] PP set error:', err.message);
        emit(io, sessionId, 'error', {
          message: 'Failed to set profile picture: ' + err.message,
        });
      }

      // Cleanup after a brief delay so client receives events
      setTimeout(() => cleanupSession(sessionId), 5000);
    }

    // ── Closed ────────────────────────────────────────────────────────────────
    if (connection === 'close') {
      clearTimeout(timeoutHandle);
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 0;

      if (!sessionData.done) {
        if (code === DisconnectReason.loggedOut) {
          emit(io, sessionId, 'error', { message: 'Session logged out. Please try again.' });
        } else {
          emit(io, sessionId, 'error', { message: 'Connection closed unexpectedly. Try again.' });
        }
      }

      cleanupSession(sessionId);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Set full profile picture via raw IQ node (no crop) ──────────────────────
async function setFullPP(sock, imageBuffer) {
  const image = await Jimp.read(imageBuffer);
  image.scaleToFit({ w: 720, h: 720 });
  const processed = await image.getBuffer('image/jpeg');

  await sock.query({
    tag: 'iq',
    attrs: {
      to: S_WHATSAPP_NET,
      type: 'set',
      xmlns: 'w:profile:picture',
    },
    content: [
      {
        tag: 'picture',
        attrs: { type: 'image' },
        content: processed,
      },
    ],
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
async function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  activeSessions.delete(sessionId);

  try { session.sock.end(undefined); } catch (_) {}
  try { await fs.rm(session.tempDir, { recursive: true, force: true }); } catch (_) {}
}

// Helper so whatsapp.js doesn't have to import io
function emit(io, room, event, data) {
  io.to(room).emit(event, data);
}

module.exports = { createWhatsAppSession };
