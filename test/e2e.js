// Two-client end-to-end test against a locally running Boozo Bingo server.
// Usage: BASE=http://127.0.0.1:3123 node test/e2e.js
// Covers: room creation, join, start-game broadcast to all players, late join
// mid-game receiving a card, mark echo, winner, and count sync.
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://127.0.0.1:3123';
const results = [];
let failed = 0;

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
}

// Each client keeps a rolling log of recent events so a fast burst of same-name
// events cannot be missed by a listener attached a moment too late.
const RECENT = 40;
function connect() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    s.log = {};
    const origOnevent = s.onevent.bind(s);
    s.onevent = (packet) => {
      const [event, payload] = packet.data || [];
      const arr = (s.log[event] = s.log[event] || []);
      arr.push(Object.assign({ __at: arr.__mark || 0 }, payload && typeof payload === 'object' ? payload : { value: payload }));
      if (arr.length > RECENT) arr.shift();
      origOnevent(packet);
    };
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

// Wait until N events of `name` have arrived since this call started.
function next(socket, event, count = 1, timeout = 5000) {
  const mark = (socket.log[event] || []).length;
  const seenAtStart = (socket.log[event] || []).slice(-mark);
  const before = new Set(seenAtStart);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const fresh = (socket.log[event] || []).filter((e) => !e.__counted && !before.has(e));
      if (fresh.length >= count) {
        clearInterval(timer);
        fresh.forEach((e) => { e.__counted = true; });
        resolve(fresh.slice(0, count));
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${event}`));
      }
    }, 20);
  });
}

function once(socket, event, timeout = 4000) {
  return next(socket, event, 1, timeout).then((a) => a[0]);
}

(async () => {
  const host = await connect();
  const guest = await connect();
  let late = null;

  // 1. Host creates a room
  const created = await new Promise((resolve, reject) => {
    host.once('ROOM_CREATED', resolve);
    host.once('ERROR', reject);
    host.emit('CREATE_ROOM', { playerName: 'Ghostface' });
  });
  check('host creates room', created.roomCode && created.playerId, created);

  // 2. Guest joins pre-game
  const joinedP = new Promise((resolve, reject) => {
    guest.once('JOINED_ROOM', resolve);
    guest.once('ERROR', reject);
    guest.emit('JOIN_ROOM', { roomCode: created.roomCode, playerName: 'Witchy' });
  });
  const hostSeesJoin = once(host, 'PLAYER_JOINED');
  const joined = await joinedP;
  check('guest joins lobby', joined.gameStarted === false && joined.players.length === 2, joined.players);
  check('pre-game join has no card yet', joined.card === null, joined.card);
  check('host notified of join', (await hostSeesJoin).player.name === 'Witchy', null);

  // 3. Start game: every player gets their own card
  const hostStart = once(host, 'GAME_STARTED');
  const guestStart = once(guest, 'GAME_STARTED');
  host.emit('START_GAME');
  const [hStart, gStart] = await Promise.all([hostStart, guestStart]);
  check('host receives its own GAME_STARTED', Array.isArray(hStart.card) && hStart.card.length === 25, null);
  check('guest receives its own GAME_STARTED', Array.isArray(gStart.card) && gStart.card.length === 25, null);
  check('cards differ per player', JSON.stringify(hStart.card) !== JSON.stringify(gStart.card), null);
  check('free space at index 12', hStart.card[12].id === -1, hStart.card[12]);
  check('GAME_STARTED player list complete', gStart.players.length === 2, gStart.players);

  // 4. Mark squares as the host; the sync echo must be authoritative
  const hostSync = next(host, 'MARKS_SYNC', 3);
  const guestMarked = next(guest, 'SQUARE_MARKED', 3);
  for (const idx of [0, 1, 2]) {
    host.emit('MARK_SQUARE', { cardIndex: idx });
    await new Promise((r) => setTimeout(r, 80));
  }
  const syncs = await hostSync;
  check('authoritative mark set grows per tap', JSON.stringify(syncs[2].marks) === '[0,1,2]', syncs.map((s) => s.marks));
  const gEchoes = await guestMarked;
  check('opponent sees counts only', gEchoes[2].markCount === 3 && gEchoes[2].playerId === created.playerId, gEchoes[2]);
  check('opponent cannot see my mark set', gEchoes.every((e) => e.marks === undefined), Object.keys(gEchoes[0]));

  // 5. Unmark toggles off in the authoritative set
  const unmark = once(host, 'MARKS_SYNC');
  host.emit('MARK_SQUARE', { cardIndex: 2 });
  const afterUnmark = await unmark;
  check('unmark removes from set', JSON.stringify(afterUnmark.marks) === '[0,1]', afterUnmark);

  // 6. Late joiner mid-game gets a usable card
  late = await connect();
  const lateJoinedP = new Promise((resolve, reject) => {
    late.once('JOINED_ROOM', resolve);
    late.once('ERROR', reject);
    late.emit('JOIN_ROOM', { roomCode: created.roomCode, playerName: 'Mummy' });
  });
  const lateJoined = await lateJoinedP;
  check('late joiner enters game', lateJoined.gameStarted === true, lateJoined.gameStarted);
  check('late joiner receives a card', Array.isArray(lateJoined.card) && lateJoined.card.length === 25, lateJoined.card);
  check('late joiner sees all 3 players', lateJoined.players.length === 3, lateJoined.players);

  // 7. Late joiner can mark and get its own echo
  const lateEcho = once(late, 'MARKS_SYNC');
  late.emit('MARK_SQUARE', { cardIndex: 5 });
  const lEcho = await lateEcho;
  check('late joiner mark accepted', lEcho.marks.includes(5) && lEcho.marks.length === 1, lEcho);

  // 8. Winner detection: complete row 2 around the free space (10,11,[FREE],13,14).
  const winP = once(host, 'WINNER', 6000);
  for (const idx of [10, 11, 13, 14]) {
    host.emit('MARK_SQUARE', { cardIndex: idx });
    await new Promise((r) => setTimeout(r, 100)); // one tap at a time, like a real player
  }
  const win = await winP.catch(() => null);
  check('bingo detected for host (free-space row)', win && win.playerId === created.playerId, win);

  // 9. Duplicate name rejected
  const dup = await new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('JOIN_ROOM', { roomCode: created.roomCode, playerName: 'ghostface' }));
    s.once('ERROR', (e) => { resolve(e); s.close(); });
  });
  check('duplicate name rejected', /already taken/i.test(dup.message), dup);

  // 10. Bad room code rejected
  const bad = await new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('JOIN_ROOM', { roomCode: 'ZZZZZ', playerName: 'Lost' }));
    s.once('ERROR', (e) => { resolve(e); s.close(); });
  });
  check('unknown room rejected', /not found/i.test(bad.message), bad);

  for (const s of [host, guest, late]) if (s) s.close();
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(2);
});
