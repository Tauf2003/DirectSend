/**
 * DirectSend - Signaling Server
 * 
 * Handles WebSocket-based signaling for WebRTC peer connections.
 * NO files, metadata, or transfer logs are stored on the server.
 * Only temporary connection negotiation.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

function uuidv4() {
  return crypto.randomUUID();
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Room Management ───────────────────────────────────────────
const rooms = new Map(); // roomId -> Map<peerId, ws>

// Clean up empty rooms periodically
setInterval(() => {
  for (const [roomId, peers] of rooms) {
    if (peers.size === 0) {
      rooms.delete(roomId);
    }
  }
}, 30000);

// ─── REST Endpoints ────────────────────────────────────────────

// Create a new room
app.get('/api/create-room', (req, res) => {
  const roomId = generateRoomId();
  rooms.set(roomId, new Map());
  res.json({ roomId });
});

// Check if room exists
app.get('/api/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const exists = rooms.has(roomId);
  const peerCount = exists ? rooms.get(roomId).size : 0;
  res.json({ exists, peerCount });
});

// Generate QR code for a room
app.get('/api/qr/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  const url = `${protocol}://${host}/room/${roomId}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 256,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Room page route (SPA - serve index.html)
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket Signaling ───────────────────────────────────────

wss.on('connection', (ws) => {
  let currentRoom = null;
  let peerId = uuidv4();

  ws.peerId = peerId;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const { roomId } = msg;
        if (!roomId) return;

        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Map());
        }

        const room = rooms.get(roomId);
        currentRoom = roomId;

        // Notify existing peers about new peer
        for (const [existingPeerId, existingWs] of room) {
          send(existingWs, {
            type: 'peer-joined',
            peerId,
          });
        }

        // Send existing peers list to new peer
        const existingPeers = Array.from(room.keys());
        send(ws, {
          type: 'room-joined',
          roomId,
          peerId,
          peers: existingPeers,
        });

        room.set(peerId, ws);
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Relay signaling messages to target peer
        const { targetPeerId } = msg;
        if (!currentRoom || !targetPeerId) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const targetWs = room.get(targetPeerId);
        if (targetWs && targetWs.readyState === 1) {
          send(targetWs, { ...msg, fromPeerId: peerId });
        }
        break;
      }

      case 'file-meta': {
        // Relay file metadata to target peer (no storage)
        const { targetPeerId } = msg;
        if (!currentRoom || !targetPeerId) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const targetWs = room.get(targetPeerId);
        if (targetWs && targetWs.readyState === 1) {
          send(targetWs, { ...msg, fromPeerId: peerId });
        }
        break;
      }

      case 'transfer-control': {
        // Relay pause/resume/cancel signals
        const { targetPeerId } = msg;
        if (!currentRoom || !targetPeerId) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const targetWs = room.get(targetPeerId);
        if (targetWs && targetWs.readyState === 1) {
          send(targetWs, { ...msg, fromPeerId: peerId });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.delete(peerId);
      // Notify remaining peers
      for (const [, peerWs] of room) {
        send(peerWs, { type: 'peer-left', peerId });
      }
      if (room.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

// Heartbeat to detect disconnected clients
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(heartbeat));

// ─── Helpers ───────────────────────────────────────────────────

function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 7; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const details of iface) {
      if (details.family === 'IPv4' && !details.internal) {
        addresses.push(details.address);
      }
    }
  }

  return [...new Set(addresses)];
}

// ─── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const lanUrls = getLocalIPv4Addresses().map((ip) => `http://${ip}:${PORT}`);

  console.log('\n  ⚡ DirectSend is running');
  console.log(`  Local:   http://localhost:${PORT}`);
  if (lanUrls.length > 0) {
    console.log('  LAN:');
    for (const url of lanUrls) {
      console.log(`    - ${url}`);
    }
  }
  console.log('');
});
