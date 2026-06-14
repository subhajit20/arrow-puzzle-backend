# VECTO Multiplayer Server

Realtime **live-race** server for VECTO: **Node + ws + MongoDB**.

Players create/join a room (max 4), the host starts, one puzzle is generated
**on the server**, and revealed to everyone simultaneously. First to clear the
board wins; remaining players keep racing for 2nd/3rd/4th placement.

## Key design points

- **Server-side generation.** The exact browser generator (`frontend/js/*.js`)
  runs headlessly in Node via `vm` — no port, no bundling. See
  `src/generator/loadGenerator.js`. A 16×12 board generates in ~130ms and
  serializes to ~10 KB.
- **Share the board by id, not a seed.** The board is generated once, stored as
  a `puzzles` document, and referenced by the room's `puzzleId`. No client ever
  regenerates it — so there is no cross-device determinism risk.
- **Nobody sees the board early — host included.** The board is held in server
  memory and emitted **only** at the `race:start` reveal (status → `active`).
  It is never part of any room payload. The countdown sends a timestamp, not
  the board.

## Layout

```
backend/
  src/
    config.js                  env-driven config (port, mongo, race size, jsDir)
    db.js                      MongoDB connection + collections
    generator/
      loadGenerator.js         loads frontend/js into a vm sandbox → build()
      serializeBoard.js        Generator result → portable V5 board JSON
    services/
      PuzzleService.js         generate + store board (puzzles collection)
      RoomService.js           room lifecycle, placement, synced reveal
    socket/registerHandlers.js Socket.IO event wiring
    server.js                  entry point (HTTP health/debug + Socket.IO)
```

## Setup

```bash
cd backend
cp .env.example .env          # adjust if needed
npm install
# ensure MongoDB is running locally (mongodb://127.0.0.1:27017) — e.g. via Docker:
#   docker run -d -p 27017:27017 --name vecto-mongo mongo:7
npm run dev                   # node --watch src/server.js
```

Sanity checks:

```bash
curl http://localhost:3001/health        # { ok: true, rooms: 0 }
curl http://localhost:3001/debug/board    # a freshly generated board (JSON)
```

## Socket protocol

### Client → Server

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `room:create` | `{ name }` | `{ code, playerId, room }` | creates a room, you are host |
| `room:join` | `{ code, name }` | `{ ok, playerId, room }` / `{ error }` | rejects if full / started / unknown |
| `room:start` | — | `{ ok }` / `{ error }` | **host only**; generates puzzle + countdown |
| `race:progress` | `{ cleared, total }` | — | ephemeral; not persisted |
| `race:finished` | — | `{ placement }` | cleared the whole board |
| `race:out` | — | — | out of lives / gave up → DNF |
| `room:leave` | — | — | leave the room |

### Server → Room

| Event | Payload | When |
|---|---|---|
| `room:update` | `{ room }` | roster / status change |
| `race:countdown` | `{ startAt }` | host started; board still hidden |
| `race:start` | `{ startAt, board, room }` | **the reveal** — board crosses the wire |
| `race:progress` | `{ playerId, cleared, total }` | opponent progress |
| `race:placement` | `{ playerId, placement }` | someone finished |
| `race:finished` | `{ results }` | race over — final standings |

`room` payloads never contain the board or socket ids.

## Data model (MongoDB)

- **`puzzles`** — `{ _id, boardJson, genParams, genMs, createdAt }`
- **`rooms`** — `{ code, status, hostId, puzzleId, startAt, maxPlayers, players[], createdAt, updatedAt }`
  - `players[]` embedded: `{ id, name, isHost, status, cleared, total, placement, finishedAt }`

Live race state is authoritative **in memory**; Mongo is the write-through
durable copy (and where the board document lives).
