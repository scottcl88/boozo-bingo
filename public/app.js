// ── State ──────────────────────────────────────────────────────────────
let socket = null;
let myPlayerId = null;
let myPlayerName = null;
let currentRoomCode = null;
let isHost = false;
let gameStarted = false;
let myCard = null;
let myCardSize = '5x5';
let myMarks = new Set();
let bingoWinner = null;
let players = [];

// Selected card size (host only, defaults to 5x5)
let selectedCardSize = '5x5';

// Join-link room code if arriving via ?join=CODE
let joinLinkRoomCode = null;

// Session persistence
const SESSION_KEY = 'boozo-bingo.session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.roomCode && s.playerId) return s;
  } catch (e) { /* ignore corrupt storage */ }
  return null;
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      roomCode: currentRoomCode,
      playerId: myPlayerId,
      playerName: myPlayerName
    }));
  } catch (e) { /* storage may be unavailable */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

// ── Init ───────────────────────────────────────────────────────────────
let attemptingRejoin = false;

function init() {
  socket = io();

  // Detect if we arrived via a share link
  const params = new URLSearchParams(window.location.search);
  joinLinkRoomCode = params.get('join');

  socket.on('connect', () => {
    console.log('Connected to server');

    // If arriving via share link, show the join-link screen
    if (joinLinkRoomCode) {
      joinLinkRoomCode = joinLinkRoomCode.trim().toUpperCase();
      showScreen('join-link');
      return;
    }

    // Otherwise, try to auto-rejoin a stored session
    const session = loadSession();
    if (session) {
      attemptingRejoin = true;
      socket.emit('REJOIN_ROOM', { roomCode: session.roomCode, playerId: session.playerId });
    } else {
      showScreen('home');
    }
  });

  socket.on('ERROR', ({ message }) => {
    if (attemptingRejoin) {
      attemptingRejoin = false;
      clearSession();
      showScreen('home');
    }
    showError(message);
  });

  socket.on('ROOM_CREATED', ({ roomCode, playerId, playerName }) => {
    myPlayerId = playerId;
    myPlayerName = playerName;
    currentRoomCode = roomCode;
    isHost = true;
    gameStarted = false;
    bingoWinner = null;
    saveSession();
    showScreen('lobby');
    renderLobby();
    // Update share link button
    updateShareLink();
  });

  socket.on('JOINED_ROOM', ({ roomCode, playerId, playerName, players: playerList, isHost: host, gameStarted: started, bingoWinner: winner, cardSize, card, marks }) => {
    myPlayerId = playerId;
    myPlayerName = playerName;
    currentRoomCode = roomCode;
    isHost = host;
    gameStarted = started;
    bingoWinner = winner;
    players = playerList;
    myCard = card;
    myCardSize = cardSize || '5x5';
    myMarks = new Set(marks || []);
    if (winner) bingoWinner = winner;
    saveSession();

    showScreen(started ? 'game' : 'lobby');
    renderLobby();
    if (started) renderGame();
    // If winner already exists, show the alert
    if (winner) showWinnerAlert(winner.name || winner);
  });

  socket.on('REJOINED_ROOM', ({ roomCode, playerId, playerName, players: playerList, isHost: host, gameStarted: started, bingoWinner: winner, cardSize, card, marks }) => {
    attemptingRejoin = false;
    myPlayerId = playerId;
    myPlayerName = playerName;
    currentRoomCode = roomCode;
    isHost = host;
    gameStarted = started;
    bingoWinner = winner;
    players = playerList;
    myCard = card;
    myCardSize = cardSize || '5x5';
    myMarks = new Set(marks || []);
    if (winner) bingoWinner = winner;
    saveSession();

    showScreen(started ? 'game' : 'lobby');
    renderLobby();
    if (started) renderGame();
    if (winner) showWinnerAlert(winner.name || winner);
  });

  socket.on('PLAYER_JOINED', ({ player }) => {
    updatePlayerFromServer({ playerId: player.id, playerName: player.name, markCount: player.markCount, isHost: player.isHost });
    renderLobbyPlayers();
    if (gameStarted) renderGamePlayers();
  });

  socket.on('PLAYER_LEFT', ({ playerId }) => {
    players = players.filter(p => p.id !== playerId);
    renderLobbyPlayers();
    if (gameStarted) renderGamePlayers();
  });

  socket.on('GAME_STARTED', ({ card, cardSize, players: playerList }) => {
    gameStarted = true;
    myCard = card;
    myCardSize = cardSize || '5x5';
    myMarks = new Set();
    players = playerList;
    bingoWinner = null;
    showScreen('game');
    renderGame();
  });

  socket.on('MARKS_SYNC', ({ marks }) => {
    myMarks = new Set(marks || []);
    syncMyCells();
    updateMarkBingoButton();
  });

  socket.on('SQUARE_MARKED', ({ playerId, playerName, cardIndex, marked, markCount }) => {
    if (playerId === myPlayerId) {
      if (marked) myMarks.add(cardIndex);
      else myMarks.delete(cardIndex);
      syncMyCells();
    }
    updatePlayerFromServer({ playerId, playerName, markCount });
    renderGamePlayers();
    updateMarkBingoButton();
  });

  socket.on('WINNER', ({ playerId, playerName }) => {
    bingoWinner = { id: playerId, name: playerName };
    showWinnerAlert(playerName);
    updateMarkBingoButton();
  });

  // ── Join-link screen events ──
  document.getElementById('btn-join-link').addEventListener('click', () => {
    const name = document.getElementById('join-name').value.trim();
    if (!name) { showJoinLinkError('Please enter your name.'); return; }
    clearError();
    socket.emit('JOIN_ROOM', { roomCode: joinLinkRoomCode, playerName: name });
  });

  document.getElementById('join-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-link').click();
  });

  // ── Home screen events ──
  document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('home-name').value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    clearError();
    socket.emit('CREATE_ROOM', { playerName: name, cardSize: selectedCardSize });
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
  document.getElementById('btn-lobby-leave').addEventListener('click', leaveAndReset);

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoomCode).then(() => {
      const btn = document.getElementById('btn-copy-code');
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
    });
  });

  document.getElementById('btn-share-link').addEventListener('click', () => {
    const url = `${window.location.origin}${window.location.pathname}?join=${currentRoomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('btn-share-link');
      btn.textContent = '✅ Link Copied!';
      setTimeout(() => { btn.textContent = '🔗 Share Link'; }, 2000);
    });
  });

  // Card size selector (host only)
  document.querySelectorAll('.card-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!isHost || gameStarted) return;
      document.querySelectorAll('.card-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCardSize = btn.dataset.size;
    });
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    socket.emit('START_GAME');
  });

  // ── Game events ──
  document.getElementById('btn-game-leave').addEventListener('click', leaveAndReset);

  document.getElementById('btn-mark-bingo').addEventListener('click', () => {
    document.querySelectorAll('#bingo-card .bingo-cell:not(.free-space)').forEach(cell => {
      cell.classList.add('marked');
      myMarks.add(parseInt(cell.dataset.index, 10));
    });
    document.getElementById('btn-mark-bingo').style.display = 'none';
  });

  document.getElementById('btn-dismiss-winner').addEventListener('click', () => {
    dismissWinnerAlert();
  });

  document.getElementById('btn-new-game').addEventListener('click', () => {
    clearSession();
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

  // Show card size selector only for host and only before game starts
  const selector = document.getElementById('card-size-selector');
  if (selector) {
    selector.style.display = isHost && !gameStarted ? 'flex' : 'none';
  }
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
  updateMarkBingoButton();
  document.getElementById('btn-new-game').style.display = bingoWinner ? 'inline-block' : 'none';
}

function updateMarkBingoButton() {
  const btn = document.getElementById('btn-mark-bingo');
  if (!btn) return;
  if (bingoWinner || !myCard) { btn.style.display = 'none'; return; }
  const totalCells = myCard.length;
  const markedCells = myMarks.size;
  const unmarked = totalCells - markedCells;
  btn.style.display = unmarked <= 2 ? 'inline-block' : 'none';
}

function renderBingoCard() {
  const cardEl = document.getElementById('bingo-card');
  if (!myCard) return;

  // Set grid columns based on card size
  const size = myCardSize || '5x5';
  const dimension = parseInt(size, 10);
  cardEl.style.gridTemplateColumns = `repeat(${dimension}, minmax(0, 1fr))`;
  cardEl.style.gridTemplateRows = `repeat(${dimension}, minmax(0, 1fr))`;

  cardEl.innerHTML = myCard.map((item, i) => {
    const isFree = item.id === -1;
    const isMarked = isFree || myMarks.has(i);
    if (isFree) myMarks.add(i);
    return `
      <div class="bingo-cell${isFree ? ' free-space' : ''}${isMarked && !isFree ? ' marked' : ''}"
           data-index="${i}"
           data-label="${escHtml(item.label)}">
        <span class="cell-emoji">${item.emoji}</span>
        <span class="cell-label">${item.label}</span>
      </div>
    `;
  }).join('');

  // Attach tap handlers (never block on bingoWinner — continue playing after win)
  cardEl.querySelectorAll('.bingo-cell:not(.free-space)').forEach(cell => {
    cell.addEventListener('click', () => {
      const idx = parseInt(cell.dataset.index, 10);
      socket.emit('MARK_SQUARE', { cardIndex: idx });
    });
  });
}

function syncMyCells() {
  document.querySelectorAll('#bingo-card .bingo-cell').forEach(cell => {
    if (cell.classList.contains('free-space')) return;
    const idx = parseInt(cell.dataset.index, 10);
    cell.classList.toggle('marked', myMarks.has(idx));
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

function updatePlayerFromServer({ playerId, playerName, markCount, isHost: hostFlag }) {
  let p = players.find(x => x.id === playerId);
  if (!p) {
    p = { id: playerId, name: playerName || 'Player', isHost: !!hostFlag, markCount: markCount || 0 };
    players.push(p);
  } else {
    if (typeof markCount === 'number') p.markCount = markCount;
    if (playerName) p.name = playerName;
  }
  return p;
}

// ── Winner Alert (dismissible, game continues) ─────────────────────────
let winnerAlertDismissed = false;

function showWinnerAlert(playerName) {
  winnerAlertDismissed = false;
  document.getElementById('winner-alert-name').textContent = playerName;
  document.getElementById('winner-alert').style.display = 'block';
  launchConfetti();
  document.getElementById('btn-new-game').style.display = 'inline-block';
  document.getElementById('btn-mark-bingo').style.display = 'none';
}

function dismissWinnerAlert() {
  winnerAlertDismissed = true;
  document.getElementById('winner-alert').style.display = 'none';
}

// ── Confetti ───────────────────────────────────────────────────────────
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  const ctx = canvas.getContext('2d');

  // Size the canvas to the viewport
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  canvas.width = viewportW;
  canvas.height = viewportH;
  canvas.style.width = viewportW + 'px';
  canvas.style.height = viewportH + 'px';

  const colors = ['#ff6b2b', '#b14aff', '#39ff14', '#ff4a4a', '#ffd700', '#00d4ff'];
  const pieces = [];

  for (let i = 0; i < 100; i++) {
    pieces.push({
      x: Math.random() * viewportW,
      y: Math.random() * viewportH - viewportH,
      w: Math.random() * 8 + 3,
      h: Math.random() * 5 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 7,
      speedY: Math.random() * 3 + 1.5,
      speedX: (Math.random() - 0.5) * 1.5,
    });
  }

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, viewportW, viewportH);
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
    else ctx.clearRect(0, 0, viewportW, viewportH);
  }
  draw();
}

// ── Share Link ─────────────────────────────────────────────────────────
function updateShareLink() {
  // Share link button is in lobby; nothing extra needed here
}

// ── Errors ─────────────────────────────────────────────────────────────
function showError(msg) {
  clearError();
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) return;
  const el = activeScreen.querySelector('.error-msg');
  if (el) el.textContent = msg;
}

function showJoinLinkError(msg) {
  const el = document.getElementById('join-link-error');
  if (el) el.textContent = msg;
}

function clearError() {
  document.querySelectorAll('.error-msg').forEach(el => el.textContent = '');
}

// ── Leave & Reset ──────────────────────────────────────────────────────
function leaveAndReset() {
  const finish = () => {
    myPlayerId = null;
    currentRoomCode = null;
    bingoWinner = null;
    showScreen('home');
  };
  clearSession();
  if (socket && socket.connected) {
    socket.emit('LEAVE_ROOM', null, () => finish());
    setTimeout(finish, 1500);
  } else {
    finish();
  }
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
