// Session-persistence end-to-end test: a player who refreshes/reconnects can
// resume their room, card, marks, and host status via REJOIN_ROOM.
// Usage: BASE=http://127.0.0.1:3123 node test/persistence.js
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://127.0.0.1:3123';
const results = [];
let failed = 0;

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function once(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), timeout);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

(async () => {
  // 1. Host creates a room.
  const host = await connect();
  const created = await new Promise((resolve, reject) => {
    host.once('ROOM_CREATED', resolve);
    host.once('ERROR', reject);
    host.emit('CREATE_ROOM', { playerName: 'Ghostface' });
  });
  check('host creates room', created.roomCode && created.playerId, created);

  // 2. Guest joins.
  const guest = await connect();
  const joined = await new Promise((resolve, reject) => {
    guest.once('JOINED_ROOM', resolve);
    guest.once('ERROR', reject);
    guest.emit('JOIN_ROOM', { roomCode: created.roomCode, playerName: 'Witchy' });
  });
  check('guest joins lobby', joined.players.length === 2, joined.players);

  // 3. Start game.
  host.emit('START_GAME');
  await once(host, 'GAME_STARTED');
  await once(guest, 'GAME_STARTED');

  // 4. Host marks three squares, establishing recoverable state.
  for (const idx of [0, 1, 2]) {
    host.emit('MARK_SQUARE', { cardIndex: idx });
    await once(host, 'MARKS_SYNC');
  }

  // 5. Simulate a refresh: host disconnects (no LEAVE_ROOM), then reconnects.
  host.close();
  await new Promise((r) => setTimeout(r, 200));

  const host2 = await connect();
  const rejoined = await new Promise((resolve, reject) => {
    host2.once('REJOINED_ROOM', resolve);
    host2.once('ERROR', reject);
    host2.emit('REJOIN_ROOM', { roomCode: created.roomCode, playerId: created.playerId });
  });
  check('host resumes same player id', rejoined.playerId === created.playerId, rejoined);
  check('host keeps host status', rejoined.isHost === true, rejoined.isHost);
  check('host resumes in-game', rejoined.gameStarted === true, rejoined.gameStarted);
  check('host gets card back', Array.isArray(rejoined.card) && rejoined.card.length === 25, rejoined.card);
  check('host marks restored', Array.isArray(rejoined.marks) && rejoined.marks.length === 3, rejoined.marks);
  check('host sees both players', rejoined.players.length === 2, rejoined.players);

  // 6. Host can still mark after resume.
  const resumedMark = once(host2, 'MARKS_SYNC');
  host2.emit('MARK_SQUARE', { cardIndex: 5 });
  const mark = await resumedMark;
  check('host can mark after resume', mark.marks.length === 4 && mark.marks.includes(5), mark);

  // 7. Guest refresh mid-game resumes too.
  guest.close();
  await new Promise((r) => setTimeout(r, 200));
  const guest2 = await connect();
  const grejoined = await new Promise((resolve, reject) => {
    guest2.once('REJOINED_ROOM', resolve);
    guest2.once('ERROR', reject);
    guest2.emit('REJOIN_ROOM', { roomCode: created.roomCode, playerId: joined.playerId });
  });
  check('guest resumes mid-game', grejoined.gameStarted === true, grejoined.gameStarted);
  check('guest is not host', grejoined.isHost === false, grejoined.isHost);

  // 8. Explicit leave removes the player immediately (no ghost).
  const leftP = once(host2, 'PLAYER_LEFT');
  guest2.emit('LEAVE_ROOM', null, () => {});
  const left = await leftP;
  check('explicit leave broadcasts PLAYER_LEFT', left.playerId === joined.playerId, left);

  // 9. Rejoin after explicit leave is rejected (session ended).
  const badRejoin = await new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('REJOIN_ROOM', { roomCode: created.roomCode, playerId: joined.playerId }));
    s.once('ERROR', (e) => { resolve(e); s.close(); });
  });
  check('rejoin after leave rejected', /session has ended|rejoin/i.test(badRejoin.message), badRejoin);

  // 10. Rejoin with unknown room rejected.
  const badRoom = await new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('REJOIN_ROOM', { roomCode: 'ZZZZZ', playerId: 'nope' }));
    s.once('ERROR', (e) => { resolve(e); s.close(); });
  });
  check('rejoin unknown room rejected', /not found/i.test(badRoom.message), badRoom);

  host2.close();
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('FATAL', err.message);
  process.exit(2);
});
