/**
 * lan-play-bridge — Node.js server
 *
 * Express serves static frontend from ../public.
 * Socket.io handles real-time room coordination (matchmaking).
 * The relay tunnel itself is handled by switch-lan-play on port 11451 —
 * this server only coordinates "are both players ready?"
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check endpoint (useful for monitoring / uptime checks)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
// Map<roomCode, { players: Map<socketId, { ip }>, created: number, lastActivity: number }>
const rooms = new Map();

// Max players per room (trading is 1-to-1)
const MAX_PLAYERS = 2;

// Room expiry: 30 minutes of inactivity
const ROOM_TTL_MS = 30 * 60 * 1000;

// Cleanup sweep every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      for (const id of room.players.keys()) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.emit('room-expired');
          s.leave(code);
        }
      }
      rooms.delete(code);
    }
  }
}, 60 * 1000);

// ---------------------------------------------------------------------------
// IP assignment — gives each player a unique 10.13.x.x address
// ---------------------------------------------------------------------------
function generateIP(room) {
  var usedIPs = new Set();
  for (var info of room.players.values()) {
    if (info && info.ip) usedIPs.add(info.ip);
  }

  var ip;
  do {
    // Random octets: 10.13.[1-254].[1-254], avoiding gateway 10.13.37.1
    var a = Math.floor(Math.random() * 254) + 1;
    var b = Math.floor(Math.random() * 254) + 1;
    ip = '10.13.' + a + '.' + b;
  } while (ip === '10.13.37.1' || usedIPs.has(ip));

  return ip;
}

// ---------------------------------------------------------------------------
// Socket.io connection handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // Track which room this socket is currently in
  let currentRoom = null;

  // -- Join room --------------------------------------------------------
  socket.on('join-room', (data) => {
    const code = normalizeCode(data && data.code);
    if (!code) {
      socket.emit('room-error', { message: 'Please enter a valid room code (2-20 characters).' });
      return;
    }

    // Leave current room first if already in one
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
    }

    // Create room if it doesn't exist
    if (!rooms.has(code)) {
      rooms.set(code, {
        players: new Map(),
        created: Date.now(),
        lastActivity: Date.now(),
      });
    }

    const room = rooms.get(code);

    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('room-full', { message: 'Room is full. Try a different code.' });
      return;
    }

    const assignedIP = generateIP(room);
    room.players.set(socket.id, { ip: assignedIP });
    room.lastActivity = Date.now();
    socket.join(code);
    currentRoom = code;

    socket.emit('room-joined', {
      code,
      playerCount: room.players.size,
      position: room.players.size,
      assignedIP: assignedIP,
    });

    // Notify both players if the room is now full (partner arrived)
    if (room.players.size === 2) {
      // Send each player the partner-joined event with their own IP reminder
      for (const [id, info] of room.players) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.emit('partner-joined', { playerCount: 2, assignedIP: info.ip });
        }
      }
    }
  });

  // -- Leave room -------------------------------------------------------
  socket.on('leave-room', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
      currentRoom = null;
    }
  });

  // -- Disconnect -------------------------------------------------------
  socket.on('disconnect', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
      currentRoom = null;
    }
  });

  // -- Helpers ----------------------------------------------------------
  function leaveRoom(sock, code) {
    sock.leave(code);
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(sock.id);
    room.lastActivity = Date.now();

    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      // Notify remaining player that partner left
      for (const [id, info] of room.players) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.emit('partner-left', { playerCount: room.players.size, assignedIP: info.ip });
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length < 2 || trimmed.length > 20) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`lan-play-bridge server listening on http://localhost:${PORT}`);
});
