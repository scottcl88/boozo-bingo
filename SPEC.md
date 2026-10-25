# Boozo Bingo — Specification

## 1. Concept & Vision

A real-time multiplayer Halloween bar crawl bingo game. The host creates a room with a short code, friends join on their phones, each gets a randomized bingo card, and players tap squares as they spot Halloween-themed costumes and moments. First to 5-in-a-row wins. Dark, playful, spooky-but-fun aesthetic — a digital decoration that makes the crawl feel more like a curated event.

## 2. Design Language

**Aesthetic direction:** Neon Halloween night — think arcade cabinet meets haunted house lobby. Dark backgrounds, glowing neon accents, playful not scary.

**Color palette:**
- Background: `#0d0d0d`
- Card background: `#1a1a2e`
- Primary accent (neon orange): `#ff6b2b`
- Secondary accent (neon purple): `#b14aff`
- Success/win: `#39ff14` (neon green)
- Text primary: `#f5f5f5`
- Text muted: `#888899`
- Square unmarked: `#1f1f3a`
- Square marked: `#2a1a4a` with neon border glow

**Typography:**
- Headings: `Creepster` (Google Fonts) — spooky display font
- Body/UI: `Nunito` (Google Fonts) — friendly, readable on mobile

**Motion:**
- Card squares: scale 0.95 on press, 150ms ease-out
- Marked squares: soft neon pulse animation (2s loop)
- Bingo win: full-screen confetti burst + winner modal slide-up
- Join/leave: subtle fade on player list

**Visual assets:**
- Emoji-first for square icons (🎃 👻 🧙 etc.)
- Inline SVG for logo/favicon
- No external images needed

## 3. Layout & Structure

**Screens:**
1. **Home / Join** — logo, room code input OR create room button, player name input
2. **Lobby** — room code display (big, copyable), player list, "Start Game" button (host only), share link
3. **Game Board** — 5×5 bingo card, player list sidebar/bottom bar, room code, marked count per player
4. **Winner Modal** — overlay on all clients when bingo detected, winner name, celebration

**Responsive:** Mobile-first (320px+). On desktop, board is centered with player list to the side. On mobile, board takes full width, player list collapses to a bottom bar showing names + mark counts.

**Navigation:** No traditional nav — state-driven screen transitions (home → lobby → game).

## 4. Features & Interactions

**Room creation:**
- Host enters name → clicks "Create Room" → 5-character alphanumeric code generated (e.g. `SPOOK`)
- Room stored in server memory (no DB needed)
- Host sees room code + share link

**Join room:**
- Guest enters name + room code → joins if room exists and game not started
- If game already started, guest joins and immediately sees the current board state

**Game start (host only):**
- Host clicks "Start Game" → all clients transition to game board
- Each client receives a randomized 5×5 card from a shared pool of 24 items + FREE SPACE

**Bingo squares (24 items, shuffled into 5×5 grids):**
Witch, Vampire, Skeleton, Zombie, Ghost, Werewolf, Devil, Angel, Superhero, Movie Character, Clown, Pirate, Black Cat, Scary Mask, Fortune Teller, Flaming Cocktail, Fog Machine, Costume Contest, Makeup/Creature, Group Costume, Kid in Costume, Pet Costume, Decoration, Themed Bar
FREE SPACE in center.

**Tapping a square:**
- Tap → marked locally → emit to server → server broadcasts to all clients
- Square goes dark purple with neon orange border + pulse
- Tap again to unmark (honor system)
- Cannot tap FREE SPACE (always marked)

**Bingo detection:**
- Client checks after every mark: any 5-in-a-row (horizontal, vertical, diagonal)
- On potential bingo: client emits `bingo` event with row/column/diagonal info
- Server verifies, first valid bingo wins
- Server broadcasts `WINNER` to all clients with winner's name
- All clients show winner modal simultaneously

**Winner modal:**
- Full-screen overlay, neon green glow
- "👻 [Name] got BINGO! 👻"
- "Winner picks: 🧃 Free drink OR 🎯 Pick next stop"
- Dismiss button

**Player list:**
- Shows all players in room
- Shows mark count per player (e.g. "🧟 4 marks")
- Updates in real-time

**Edge cases:**
- Room code not found → "Room not found" error
- Name already taken in room → "Name taken, pick another"
- Host leaves → room persists, next player does NOT become host (just ends)
- All players leave → room deleted after 5 min inactivity
- Double bingo (same turn) → first received by server wins

## 5. Component Inventory

**RoomCodeDisplay:**
- Large text, copyable
- One-click copy to clipboard
- States: generating (spinner), ready (code shown)

**BingoCard:**
- 5×5 grid, each cell a BingoSquare
- Responsive: fills available width, maintains square aspect ratio

**BingoSquare:**
- States: unmarked (dark), marked (dark purple + neon border + pulse), free-space (always marked, different color)
- Content: emoji icon + label text
- Interaction: tap to toggle

**PlayerList:**
- List of PlayerRow items
- PlayerRow: name + mark count badge

**WinnerModal:**
- Overlay covering entire viewport
- Slide-up animation on appear
- Confetti animation behind modal

**JoinForm / CreateForm:**
- Name input + action button
- Error state for invalid input

## 6. Technical Approach

**Stack:**
- Node.js + Express (server)
- Socket.IO (real-time WebSocket sync)
- Vanilla HTML/CSS/JS (client, no framework)
- Single `server.js` entry point

**Project structure:**
```
boozo-bingo/
├── SPEC.md
├── server.js          # Express + Socket.IO server
├── package.json
├── public/
│   ├── index.html     # Single page app
│   ├── style.css
│   └── app.js         # Client-side JS
```

**Socket.IO events:**
- `CREATE_ROOM` (client→server) → `ROOM_CREATED` (server→client: {roomCode, playerId})
- `JOIN_ROOM` (client→server: {roomCode, playerName}) → `JOINED_ROOM` (server→client: {players, isHost, gameStarted, card})
- `PLAYER_JOINED` (server→clients in room: {player})
- `START_GAME` (host→server) → `GAME_STARTED` (server→all clients: {cards})
- `MARK_SQUARE` (client→server: {cardIndex}) → `SQUARE_MARKED` (server→all clients: {playerId, cardIndex, marked})
- `BINGO` (client→server: {playerId, lineInfo}) → `WINNER` (server→all clients: {playerId, playerName})
- `PLAYER_LEFT` (server→clients: {playerId})

**Data model (in-memory, server):**
```js
rooms = Map<roomCode, {
  players: Map<playerId, {id, name, isHost, marks: Set<cardIndex>}>,
  gameStarted: boolean,
  cards: Map<playerId, number[]>, // shuffled card for each player
  bingoWinner: string | null,
  createdAt: timestamp
}>
```

**Deployment:**
- Railway (railway.app) — free tier, Node.js native
- GitHub repo connected to Railway for auto-deploy
- No database, no environment variables needed

**Card randomization:**
- 24 items shuffled with Fisher-Yates
- First 12 placed in card positions 0-11
- FREE SPACE at index 12
- Last 12 placed in card positions 13-24
- Result: each player gets same 24 items, different arrangement

**Bingo validation:**
- Check 12 possible lines (5 rows + 5 cols + 2 diagonals)
- Each line: positions array, all must be marked (or free space)
