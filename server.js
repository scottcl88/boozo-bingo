const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── SAFEGUARD CONSTANTS ────────────────────────────────────────────────────────
const MAX_GLOBAL_ROOMS     = 50;    // hard cap to protect Railway 512MB RAM
const MAX_PLAYERS_PER_ROOM = 20;   // sanity limit for a bar crawl
const MAX_ROOMS_PER_IP     = 3;    // rooms an IP can create per hour
const MAX_CONNECTIONS_PER_IP = 20;  // concurrent socket connections per IP (matches room cap: a bar group shares one public IP)
const MARK_RATE_WINDOW_MS  = 10_000; // window for mark rate limiting
const MARKS_PER_WINDOW     = 10;   // max marks a player can emit per window
const MIN_PLAYERS_TO_START = 2;    // prevent solo / accidental game start

// ── SAFEGUARD STATE ────────────────────────────────────────────────────────────
const rooms = new Map();
const ipTracker = new Map();
const playerMarkTimestamps = new Map();

// ── HEALTH CHECK ENDPOINT (Railway readiness probe) ────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: Math.floor(process.uptime()),
    memoryUsage: process.memoryUsage(),
  });
});

// ── SAFEGUARD HELPERS ──────────────────────────────────────────────────────────
function getClientIp(socket) {
  // Trust X-Forwarded-For when behind a proxy (Railway adds this)
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;
}

function trackIp(ip) {
  if (!ipTracker.has(ip)) {
    ipTracker.set(ip, { roomCreations: [], connections: new Set() });
  }
  return ipTracker.get(ip);
}

function isRateLimited(ip, action, maxCount, windowMs) {
  const tracker = trackIp(ip);
  const now = Date.now();
  const windowStart = now - windowMs;

  // Filter to only events within the window
  const recent = (tracker[action] || []).filter(ts => ts > windowStart);
  tracker[action] = recent;

  if (recent.length >= maxCount) {
    return true;
  }
  recent.push(now);
  return false;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  // Strip HTML tags, trim, enforce max length
  return name
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 20);
}

function isValidCardIndex(idx) {
  return Number.isInteger(idx) && idx >= 0 && idx <= 24;
}

// Bingo square pool (24 items, one per non-center cell)
const BINGO_ITEMS = [
  { id: 0,  label: 'Witch',             emoji: '🧙‍♀️' },
  { id: 1,  label: 'Vampire',           emoji: '🧛' },
  { id: 2,  label: 'Skeleton',          emoji: '💀' },
  { id: 3,  label: 'Zombie',            emoji: '🧟' },
  { id: 4,  label: 'Ghost',             emoji: '👻' },
  { id: 5,  label: 'Werewolf',          emoji: '🐺' },
  { id: 6,  label: 'Devil',             emoji: '😈' },
  { id: 7,  label: 'Angel',             emoji: '👼' },
  { id: 8,  label: 'Superhero',         emoji: '🦸' },
  { id: 9,  label: 'Movie Character',   emoji: '🎬' },
  { id: 10, label: 'Clown',             emoji: '🤡' },
  { id: 11, label: 'Pirate',            emoji: '🏴‍☠️' },
  { id: 12, label: 'Black Cat',         emoji: '🐈‍⬛' },
  { id: 13, label: 'Scary Mask',        emoji: '🎭' },
  { id: 14, label: 'Fortune Teller',    emoji: '🔮' },
  { id: 15, label: 'Flaming Cocktail',  emoji: '🍸' },
  { id: 16, label: 'Fog Machine',       emoji: '🌫️' },
  { id: 17, label: 'Costume Contest',   emoji: '🏆' },
  { id: 18, label: 'Makeup/Creature',   emoji: '👹' },
  { id: 19, label: 'Group Costume',     emoji: '👥' },
  { id: 20, label: 'Kid in Costume',    emoji: '🧒' },
  { id: 21, label: 'Pet Costume',       emoji: '🐶' },
  { id: 22, label: 'Decoration',        emoji: '🎃' },
  { id: 23, label: 'Themed Bar',        emoji: '🍺' },
];

// Card sizes and their parameters
const CARD_SIZES = {
  '3x3': { cells: 9,  freeIndex: 4, lines: [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]] },
  '4x4': { cells: 16, freeIndex: null, lines: [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15],[0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15],[0,5,10,15],[3,6,9,12]] },
  '5x5': { cells: 25, freeIndex: 12, lines: [[0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],[0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],[0,6,12,18,24],[4,8,12,16,20]] },
};

// Fisher-Yates shuffle
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Generate a unique player ID
function generatePlayerId() {
  return Math.random().toString(36).substring(2, 10);
}

// Generate a short unique room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

// Build a card array for a player based on card size
// 3x3: 8 items + free space in center
// 4x4: 16 items, no free space
// 5x5: 24 items + free space in center
function generateCard(cardSize) {
  const config = CARD_SIZES[cardSize] || CARD_SIZES['5x5'];
  const { cells, freeIndex } = config;
  const shuffled = shuffle(BINGO_ITEMS);
  const card = new Array(cells);

  if (freeIndex !== null) {
    // Free space in center: fill before, insert free, fill after
    const beforeCount = freeIndex;
    const afterCount = cells - freeIndex - 1;
    for (let i = 0; i < beforeCount; i++) card[i] = shuffled[i];
    card[freeIndex] = { id: -1, label: 'FREE SPACE', emoji: '👻' };
    for (let i = freeIndex + 1; i < cells; i++) card[i] = shuffled[i - 1];
  } else {
    // No free space: fill with shuffled items
    for (let i = 0; i < cells; i++) card[i] = shuffled[i];
  }
  return card;
}

// Public player fields for client-facing lists (no socket id / internal state).
function publicPlayers(room) {
  return Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    markCount: p.marks.size
  }));
}

// Check if a set of marks produces a bingo
function checkBingo(marks, cardSize) {
  const config = CARD_SIZES[cardSize] || CARD_SIZES['5x5'];
  for (const line of config.lines) {
    if (line.every(pos => config.freeIndex === null || pos === config.freeIndex || marks.has(pos))) {
      return true;
    }
  }
  return false;
}

// Clean up abandoned rooms and disconnected players every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    // Prune players who disconnected and never came back.
    for (const [pid, p] of room.players) {
      if (p.socketId === null && now - p.disconnectedAt > 5 * 60 * 1000) {
        room.players.delete(pid);
        room.cards.delete(pid);
        console.log(`Removed disconnected player ${p.name} from room ${code}`);
      }
    }
    if (room.players.size === 0 && now - room.lastActivity > 5 * 60 * 1000) {
      rooms.delete(code);
      console.log(`Cleaned up empty room: ${code}`);
    }
  }
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
  const ip = getClientIp(socket);
  const ipData = trackIp(ip);

  // ── Connection safeguard: per-IP concurrent connection limit ──
  if (ipData.connections.size >= MAX_CONNECTIONS_PER_IP) {
    socket.emit('ERROR', { message: 'Too many connections from your network. Try again shortly.' });
    socket.disconnect(true);
    return;
  }
  ipData.connections.add(socket.id);

  console.log(`Client connected: ${socket.id} (IP: ${ip})`);

  let currentRoomCode = null;
  let currentPlayerId = null;

  // ── CREATE ROOM ──────────────────────────────────────────────────────────
  socket.on('CREATE_ROOM', ({ playerName, cardSize }) => {
    if (!playerName || playerName.trim().length === 0) {
      socket.emit('ERROR', { message: 'Please enter your name.' });
      return;
    }
    const name = sanitizeName(playerName);
    if (!name) {
      socket.emit('ERROR', { message: 'Invalid name.' });
      return;
    }

    const ip = getClientIp(socket);

    // Per-IP room creation rate limit (3 rooms / hour)
    if (isRateLimited(ip, 'roomCreations', MAX_ROOMS_PER_IP, 60 * 60 * 1000)) {
      socket.emit('ERROR', { message: 'Too many rooms created. Try again later.' });
      return;
    }

    // Global room cap
    if (rooms.size >= MAX_GLOBAL_ROOMS) {
      socket.emit('ERROR', { message: 'Server at capacity. Try again shortly.' });
      return;
    }

    const roomCode = generateRoomCode();
    const playerId = generatePlayerId();
    currentRoomCode = roomCode;
    currentPlayerId = playerId;

    const validCardSize = CARD_SIZES[cardSize] ? cardSize : '5x5';

    const room = {
      code: roomCode,
      cardSize: validCardSize,
      players: new Map([[playerId, {
        id: playerId,
        name,
        isHost: true,
        socketId: socket.id,
        marks: new Set()
      }]]),
      gameStarted: false,
      cards: new Map([[playerId, generateCard(validCardSize)]]),
      bingoWinner: null,
      lastActivity: Date.now()
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);

    console.log(`Room ${roomCode} created by ${playerName} (cardSize: ${validCardSize})`);

    socket.emit('ROOM_CREATED', {
      roomCode,
      playerId,
      playerName: name
    });
  });

  // ── JOIN ROOM ─────────────────────────────────────────────────────────────
  socket.on('JOIN_ROOM', ({ roomCode, playerName }) => {
    if (!playerName || playerName.trim().length === 0) {
      socket.emit('ERROR', { message: 'Please enter your name.' });
      return;
    }
    const name = sanitizeName(playerName);
    if (!name) {
      socket.emit('ERROR', { message: 'Invalid name.' });
      return;
    }
    if (!roomCode || roomCode.trim().length === 0) {
      socket.emit('ERROR', { message: 'Please enter a room code.' });
      return;
    }

    const code = roomCode.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('ERROR', { message: 'Room not found. Check the code and try again.' });
      return;
    }

    // Player cap per room
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('ERROR', { message: 'Room is full (20 players max).' });
      return;
    }

    // Check for duplicate name
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        socket.emit('ERROR', { message: 'That name is already taken. Pick another.' });
        return;
      }
    }

    const playerId = generatePlayerId();
    currentRoomCode = code;
    currentPlayerId = playerId;

    const player = {
      id: playerId,
      name,
      isHost: false,
      socketId: socket.id,
      marks: new Set()
    };
    room.players.set(playerId, player);

    const card = generateCard(room.cardSize);
    room.cards.set(playerId, card);
    room.lastActivity = Date.now();

    socket.join(code);

    const players = publicPlayers(room);

    socket.emit('JOINED_ROOM', {
      roomCode: code,
      playerId,
      playerName: name,
      players,
      isHost: false,
      gameStarted: room.gameStarted,
      bingoWinner: room.bingoWinner,
      cardSize: room.cardSize,
      card: room.gameStarted ? card : null,
      marks: room.gameStarted ? Array.from(player.marks) : []
    });

    // Notify others
    socket.to(code).emit('PLAYER_JOINED', {
      player: { id: playerId, name, isHost: false, markCount: 0 }
    });

    console.log(`${name} joined room ${code}`);
  });

  // ── START GAME ────────────────────────────────────────────────────────────
  socket.on('START_GAME', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players.get(currentPlayerId);
    if (!player || !player.isHost) {
      socket.emit('ERROR', { message: 'Only the host can start the game.' });
      return;
    }

    if (room.gameStarted) return; // already started

    // Guard: require at least MIN_PLAYERS_TO_START to start
    if (room.players.size < MIN_PLAYERS_TO_START) {
      socket.emit('ERROR', {
        message: `Need at least ${MIN_PLAYERS_TO_START} players to start. Wait for others!`
      });
      return;
    }

    room.gameStarted = true;
    room.lastActivity = Date.now();

    const playerList = publicPlayers(room);

    for (const p of room.players.values()) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit('GAME_STARTED', {
        card: room.cards.get(p.id),
        cardSize: room.cardSize,
        players: playerList
      });
    }

    console.log(`Game started in room ${currentRoomCode} (${room.players.size} players)`);
  });

  // ── MARK / UNMARK SQUARE ──────────────────────────────────────────────────
  socket.on('MARK_SQUARE', ({ cardIndex }) => {
    if (!isValidCardIndex(cardIndex)) {
      socket.emit('ERROR', { message: 'Invalid square.' });
      return;
    }

    const room = rooms.get(currentRoomCode);
    if (!room || !room.gameStarted) return;

    const player = room.players.get(currentPlayerId);
    if (!player) return;

    // Rate limit: max MARKS_PER_WINDOW marks per MARK_RATE_WINDOW_MS
    const now = Date.now();
    const windowStart = now - MARK_RATE_WINDOW_MS;
    if (!playerMarkTimestamps.has(currentPlayerId)) {
      playerMarkTimestamps.set(currentPlayerId, []);
    }
    const ts = playerMarkTimestamps.get(currentPlayerId).filter(t => t > windowStart);
    playerMarkTimestamps.set(currentPlayerId, ts);
    if (ts.length >= MARKS_PER_WINDOW) {
      socket.emit('ERROR', { message: 'Slow down! Too many marks too fast.' });
      return;
    }
    ts.push(now);

    const config = CARD_SIZES[room.cardSize] || CARD_SIZES['5x5'];
    if (cardIndex === config.freeIndex) return; // never allow toggling free space

    // Toggle mark
    if (player.marks.has(cardIndex)) {
      player.marks.delete(cardIndex);
    } else {
      player.marks.add(cardIndex);
    }
    room.lastActivity = Date.now();

    io.to(currentRoomCode).emit('SQUARE_MARKED', {
      playerId: currentPlayerId,
      playerName: player.name,
      cardIndex,
      marked: player.marks.has(cardIndex),
      markCount: player.marks.size
    });
    socket.emit('MARKS_SYNC', { marks: Array.from(player.marks) });

    // Check for bingo — include free space if present
    const marksWithFree = new Set(player.marks);
    if (config.freeIndex !== null) marksWithFree.add(config.freeIndex);
    if (checkBingo(marksWithFree, room.cardSize)) {
      room.bingoWinner = currentPlayerId;
      room.lastActivity = Date.now();

      // Clean up rate-limit state for winner — no more marks accepted
      playerMarkTimestamps.delete(currentPlayerId);

      io.to(currentRoomCode).emit('WINNER', {
        playerId: currentPlayerId,
        playerName: player.name
      });
      console.log(`BINGO! ${player.name} wins in room ${currentRoomCode}`);
    }
  });

  // ── REJOIN ROOM (resume after refresh / reconnect) ───────────────────────
  socket.on('REJOIN_ROOM', ({ roomCode, playerId }) => {
    if (!roomCode || !playerId) {
      socket.emit('ERROR', { message: 'Invalid session.' });
      return;
    }

    const code = String(roomCode).trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('ERROR', { message: 'Room not found. It may have ended.' });
      return;
    }

    const player = room.players.get(playerId);
    if (!player) {
      socket.emit('ERROR', { message: 'Your session has ended. Please rejoin.' });
      return;
    }

    currentRoomCode = code;
    currentPlayerId = playerId;
    player.socketId = socket.id;
    delete player.disconnectedAt;
    room.lastActivity = Date.now();
    socket.join(code);

    socket.emit('REJOINED_ROOM', {
      roomCode: code,
      playerId,
      playerName: player.name,
      players: publicPlayers(room),
      isHost: player.isHost,
      gameStarted: room.gameStarted,
      bingoWinner: room.bingoWinner,
      cardSize: room.cardSize,
      card: room.gameStarted ? room.cards.get(playerId) : null,
      marks: room.gameStarted ? Array.from(player.marks) : []
    });

    socket.to(code).emit('PLAYER_JOINED', {
      player: { id: playerId, name: player.name, isHost: player.isHost, markCount: player.marks.size }
    });

    console.log(`${player.name} rejoined room ${code}`);
  });

  // ── LEAVE ROOM (explicit leave) ───────────────────────────────────────────
  socket.on('LEAVE_ROOM', (_payload, ack) => {
    if (currentRoomCode && currentPlayerId) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        const player = room.players.get(currentPlayerId);
        const playerName = player ? player.name : 'Unknown';
        room.players.delete(currentPlayerId);
        room.cards.delete(currentPlayerId);
        room.lastActivity = Date.now();

        io.to(currentRoomCode).emit('PLAYER_LEFT', {
          playerId: currentPlayerId,
          playerName
        });
        console.log(`${playerName} left room ${currentRoomCode}`);
      }
    }
    currentRoomCode = null;
    currentPlayerId = null;
    if (typeof ack === 'function') ack();
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    ipData.connections.delete(socket.id);

    if (currentRoomCode && currentPlayerId) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        const player = room.players.get(currentPlayerId);
        if (!player) return;
        const playerName = player.name;
        player.socketId = null;
        player.disconnectedAt = Date.now();
        room.lastActivity = Date.now();

        io.to(currentRoomCode).emit('PLAYER_LEFT', {
          playerId: currentPlayerId,
          playerName
        });
        console.log(`${playerName} disconnected from room ${currentRoomCode} (retained for resume)`);
      }
    }

    playerMarkTimestamps.delete(currentPlayerId);
  });
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('SIGTERM received — closing server gracefully');
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received — closing server gracefully');
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Boozo Bingo running on port ${PORT}`);
});
