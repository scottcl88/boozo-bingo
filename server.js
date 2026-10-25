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

// In-memory room storage
const rooms = new Map();

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

// Center cell is FREE SPACE (index 12)
const FREE_SPACE_INDEX = 12;

// Bingo lines: 12 possible winning lines (5 rows, 5 cols, 2 diagonals)
const BINGO_LINES = [
  [0,  1,  2,  3,  4],   // row 0
  [5,  6,  7,  8,  9],   // row 1
  [10, 11, 12, 13, 14],  // row 2 (contains free space)
  [15, 16, 17, 18, 19],  // row 3
  [20, 21, 22, 23, 24],  // row 4
  [0,  5,  10, 15, 20],  // col 0
  [1,  6,  11, 16, 21],  // col 1
  [2,  7,  12, 17, 22],  // col 2 (contains free space)
  [3,  8,  13, 18, 23],  // col 3
  [4,  9,  14, 19, 24],  // col 4
  [0,  6,  12, 18, 24],  // diagonal TL→BR (contains free space)
  [4,  8,  12, 16, 20],  // diagonal TR→BL (contains free space)
];

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

// Generate a 5-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code)); // ensure uniqueness
  return code;
}

// Build a 25-cell card for a player (array of 25 items, index 12 = free space)
function generateCard() {
  const shuffled = shuffle(BINGO_ITEMS);
  const card = new Array(25);
  // Fill positions 0-11, insert the free space at 12, then fill 13-24 with the
  // remaining 12 items. (The old loop overwrote the centre cell and read past the
  // end of the shuffled list, leaving 12 items unused and cell 24 blank.)
  for (let i = 0; i < 12; i++) card[i] = shuffled[i];
  card[FREE_SPACE_INDEX] = { id: -1, label: 'FREE SPACE', emoji: '👻' };
  for (let i = FREE_SPACE_INDEX + 1; i < 25; i++) card[i] = shuffled[i - 1];
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
function checkBingo(marks) {
  for (const line of BINGO_LINES) {
    if (line.every(pos => pos === FREE_SPACE_INDEX || marks.has(pos))) {
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
  console.log(`Client connected: ${socket.id}`);

  let currentRoomCode = null;
  let currentPlayerId = null;

  // ── CREATE ROOM ──────────────────────────────────────────────────────────
  socket.on('CREATE_ROOM', ({ playerName }) => {
    if (!playerName || playerName.trim().length === 0) {
      socket.emit('ERROR', { message: 'Please enter your name.' });
      return;
    }

    const roomCode = generateRoomCode();
    const playerId = generatePlayerId();
    currentRoomCode = roomCode;
    currentPlayerId = playerId;

    const room = {
      code: roomCode,
      players: new Map([[playerId, {
        id: playerId,
        name: playerName.trim(),
        isHost: true,
        socketId: socket.id,
        marks: new Set()
      }]]),
      gameStarted: false,
      cards: new Map([[playerId, generateCard()]]),
      bingoWinner: null,
      lastActivity: Date.now()
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);

    console.log(`Room ${roomCode} created by ${playerName}`);

    socket.emit('ROOM_CREATED', {
      roomCode,
      playerId,
      playerName: playerName.trim()
    });
  });

  // ── JOIN ROOM ─────────────────────────────────────────────────────────────
  socket.on('JOIN_ROOM', ({ roomCode, playerName }) => {
    if (!playerName || playerName.trim().length === 0) {
      socket.emit('ERROR', { message: 'Please enter your name.' });
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

    // Check for duplicate name
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === playerName.trim().toLowerCase()) {
        socket.emit('ERROR', { message: 'That name is already taken. Pick another.' });
        return;
      }
    }

    const playerId = generatePlayerId();
    currentRoomCode = code;
    currentPlayerId = playerId;

    const player = {
      id: playerId,
      name: playerName.trim(),
      isHost: false,
      socketId: socket.id,
      marks: new Set()
    };
    room.players.set(playerId, player);

    // Every player gets a card at insert time. Late joiners receive theirs in
    // JOINED_ROOM so they can play immediately; pre-game joins wait for GAME_STARTED.
    const card = generateCard();
    room.cards.set(playerId, card);
    room.lastActivity = Date.now();

    socket.join(code);

    const players = publicPlayers(room);

    socket.emit('JOINED_ROOM', {
      roomCode: code,
      playerId,
      playerName: playerName.trim(),
      players,
      isHost: false,
      gameStarted: room.gameStarted,
      bingoWinner: room.bingoWinner,
      card: room.gameStarted ? card : null,
      marks: room.gameStarted ? Array.from(player.marks) : []
    });

    // Notify others
    socket.to(code).emit('PLAYER_JOINED', {
      player: { id: playerId, name: playerName.trim(), isHost: false, markCount: 0 }
    });

    console.log(`${playerName} joined room ${code}`);
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

    room.gameStarted = true;
    room.lastActivity = Date.now();

    // Player ids are not socket ids, so address each socket explicitly instead of
    // socket.to(playerId), which targeted a non-existent private room.
    const playerList = publicPlayers(room);

    for (const p of room.players.values()) {
      if (!p.socketId) continue; // skip disconnected players
      io.to(p.socketId).emit('GAME_STARTED', {
        card: room.cards.get(p.id),
        players: playerList
      });
    }

    console.log(`Game started in room ${currentRoomCode}`);
  });

  // ── MARK / UNMARK SQUARE ──────────────────────────────────────────────────
  socket.on('MARK_SQUARE', ({ cardIndex }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.gameStarted || room.bingoWinner) return;

    const player = room.players.get(currentPlayerId);
    if (!player) return;

    // Toggle mark
    if (player.marks.has(cardIndex)) {
      player.marks.delete(cardIndex);
    } else {
      player.marks.add(cardIndex);
    }
    room.lastActivity = Date.now();

    // Every player, including me, learns the new mark count from this broadcast.
    io.to(currentRoomCode).emit('SQUARE_MARKED', {
      playerId: currentPlayerId,
      playerName: player.name,
      cardIndex,
      marked: player.marks.has(cardIndex),
      markCount: player.marks.size
    });
    // The authoritative mark set goes only to the player who owns that card,
    // in a separate event: mark indexes are card positions, not global state.
    socket.emit('MARKS_SYNC', { marks: Array.from(player.marks) });

    // Check for bingo. Count the free space as marked but never let it be toggled.
    const marksWithFree = new Set(player.marks);
    marksWithFree.add(FREE_SPACE_INDEX);
    if (checkBingo(marksWithFree)) {
      room.bingoWinner = currentPlayerId;
      room.lastActivity = Date.now();

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

    // Re-associate this socket with the retained player record.
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
      card: room.gameStarted ? room.cards.get(playerId) : null,
      marks: room.gameStarted ? Array.from(player.marks) : []
    });

    // Tell everyone else this player is back.
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

  // ── DISCONNECT (retain player so a quick refresh can resume) ──────────────
  socket.on('disconnect', () => {
    if (currentRoomCode && currentPlayerId) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        const player = room.players.get(currentPlayerId);
        if (!player) return;
        const playerName = player.name;
        // Keep the record so a refresh/reconnect can resume; mark as disconnected.
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
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Boozo Bingo running on port ${PORT}`);
});
