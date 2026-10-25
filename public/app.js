// ── State ──────────────────────────────────────────────────────────────
let socket = null;
let myPlayerId = null;
let myPlayerName = null;
let currentRoomCode = null;
let isHost = false;
let gameStarted = false;
let myCard = null;
let myMarks = new Set();
let bingoWinner = null;
let players = [];

// ── Init ───────────────────────────────────────────────────────────────
function init() {
  socket = io();

  socket.on('connect', () => console.log('Connected to server'));

  socket.on('ERROR', ({ message }) => showError(message));

  socket.on('ROOM_CREATED', ({ roomCode, playerId, playerName }) => {
    myPlayerId = playerId;
    myPlayerName = playerName;
    currentRoomCode = roomCode;
    isHost = true;
    gameStarted = false;
    showScreen('lobby');
    renderLobby();
  });

  socket.on('JOINED_ROOM', ({ roomCode, playerId, playerName, players: playerList, isHost: host, gameStarted: started, bingoWinner: winner, card, marks }) => {
    myPlayerId = playerId;
    myPlayerName = playerName;
    currentRoomCode = roomCode;
    isHost = host;
    gameStarted = started;
    bingoWinner = winner;
    players = playerList;
    myCard = card;
    myMarks = new Set(marks || []);
    if (winner) bingoWinner = winner;

    showScreen(started ? 'game' : 'lobby');
    renderLobby();
    if (started) renderGame();
  });

  socket.on('PLAYER_JOINED', ({ player }) => {
    players.push(player);
    renderLobbyPlayers();
    if (gameStarted) renderGamePlayers();
  });

  socket.on('PLAYER_LEFT', ({ playerId, playerName }) => {
    players = players.filter(p => p.id !== playerId);
    if (document.getElementById('screen-lobby').classList.contains('active')) {
      renderLobbyPlayers();
    }
    if (document.getElementById('screen-game').classList.contains('active')) {
      renderGamePlayers();
    }
  });

  socket.on('GAME_STARTED', ({ card, players: playerList }) => {
    gameStarted = true;
    myCard = card;
    myMarks = new Set();
    players = playerList;
    bingoWinner = null;
    showScreen('game');
    renderGame();
  });

  socket.on('SQUARE_MARKED', ({ playerId, playerName, cardIndex, marked, markCount }) => {
    if (playerId === myPlayerId) {
      if (marked) myMarks.add(cardIndex);
      else myMarks.delete(cardIndex);
    }
    const player = players.find(p => p.id === playerId);
    if (player) player.markCount = markCount;

    // Update the cell UI
    const cell = document.querySelector(`[data-index="${cardIndex}"]`);
    if (cell) {
      cell.classList.toggle('marked', marked);
    }
    renderGamePlayers();
  });

  socket.on('WINNER', ({ playerId, playerName }) => {
    bingoWinner = { id: playerId, name: playerName };
    showWinnerModal(playerName);
  });

  // ── Home screen events ──
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('home-name').value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    clearError();
    socket.emit('CREATE_ROOM', { playerName: name });
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const name = document.getElementById('home-name').value.trim();
    const code = document.getElementById('home-code').value.trim().toUpperCase();
    if (!name) { showError('Please enter your name.'); return; }
    if (!code) { showError('Please enter a room code.'); return; }
    clearError();
    socket.emit('JOIN_ROOM', { roomCode: code, playerName: name });
  });

  document.getElementById('home-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create').click();
  });
  document.getElementById('home-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  // ── Lobby events ──
  document.getElementById('btn-lobby-leave').addEventListener('click', () => {
    location.reload();
  });

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoomCode).then(() => {
      const btn = document.getElementById('btn-copy-code');
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
    });
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    socket.emit('START_GAME');
  });

  // ── Game events ──
  document.getElementById('btn-game-leave').addEventListener('click', () => {
    location.reload();
  });

  document.getElementById('btn-dismiss-winner').addEventListener('click', () => {
    document.getElementById('winner-modal').style.display = 'none';
  });

  document.getElementById('btn-new-game').addEventListener('click', () => {
    location.reload();
  });
}

// ── Screen management ─────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

// ── Lobby ──────────────────────────────────────────────────────────────
function renderLobby() {
  document.getElementById('lobby-code').textContent = currentRoomCode;
  renderLobbyPlayers();
  document.getElementById('btn-start').style.display = isHost ? 'block' : 'none';
}

function renderLobbyPlayers() {
  const list = document.getElementById('lobby-player-list');
  const count = document.getElementById('lobby-player-count');
  count.textContent = players.length;
  list.innerHTML = players.map(p => `
    <li>
      <span>${escHtml(p.name)}${p.isHost ? ' <span class="host-badge">HOST</span>' : ''}</span>
    </li>
  `).join('');
}

// ── Game ───────────────────────────────────────────────────────────────
function renderGame() {
  document.getElementById('game-room-code').textContent = currentRoomCode;
  renderBingoCard();
  renderGamePlayers();
  document.getElementById('btn-new-game').style.display = bingoWinner ? 'inline-block' : 'none';
}

function renderBingoCard() {
  const cardEl = document.getElementById('bingo-card');
  if (!myCard) return;
  cardEl.innerHTML = myCard.map((item, i) => {
    const isFree = item.id === -1;
    const isMarked = isFree || myMarks.has(i);
    if (isFree) myMarks.add(i); // ensure free space is always marked
    return `
      <div class="bingo-cell${isFree ? ' free-space' : ''}${isMarked && !isFree ? ' marked' : ''}"
           data-index="${i}"
           data-label="${escHtml(item.label)}">
        <span class="cell-emoji">${item.emoji}</span>
        <span class="cell-label">${item.label}</span>
      </div>
    `;
  }).join('');

  // Attach tap handlers
  cardEl.querySelectorAll('.bingo-cell:not(.free-space)').forEach(cell => {
    cell.addEventListener('click', () => {
      const idx = parseInt(cell.dataset.index, 10);
      const wasMarked = myMarks.has(idx);
      socket.emit('MARK_SQUARE', { cardIndex: idx });
      // Optimistic UI — toggle now, server will confirm
      cell.classList.toggle('marked', !wasMarked);
      if (!wasMarked) myMarks.add(idx);
      else myMarks.delete(idx);
    });
  });
}

function renderGamePlayers() {
  const list = document.getElementById('game-player-list');
  list.innerHTML = players.map(p => `
    <li>
      <span>${escHtml(p.name)}${p.isHost ? ' 👑' : ''}</span>
      <span class="mark-count">${p.markCount || 0} 🎃</span>
    </li>
  `).join('');
}

// ── Winner Modal ───────────────────────────────────────────────────────
function showWinnerModal(playerName) {
  document.getElementById('winner-name').textContent = playerName;
  document.getElementById('winner-modal').style.display = 'flex';
  launchConfetti();
  document.getElementById('btn-new-game').style.display = 'inline-block';
}

// ── Confetti ───────────────────────────────────────────────────────────
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  canvas.innerHTML = '';
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#ff6b2b', '#b14aff', '#39ff14', '#ff4a4a', '#ffd700', '#00d4ff'];
  const pieces = [];

  for (let i = 0; i < 120; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 8 + 4,
      h: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 8,
      speedY: Math.random() * 3 + 2,
      speedX: (Math.random() - 0.5) * 2,
    });
  }

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - frame / 120);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();

      p.y += p.speedY;
      p.x += p.speedX;
      p.rot += p.rotSpeed;
    });
    frame++;
    if (frame < 140) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

// ── Errors ─────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.querySelector('.error-msg:not(#home-error), #home-error');
  const target = document.getElementById('home-error');
  if (target) target.textContent = msg;
}
function clearError() {
  document.querySelectorAll('.error-msg').forEach(el => el.textContent = '');
}

// ── Utils ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
