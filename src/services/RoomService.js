// =============================================================================
// RoomService.js — authoritative room lifecycle + race orchestration.
//
// Live state is held in memory (the source of truth for an in-flight race);
// a write-through copy is persisted to MongoDB for durability and results.
// The board is held in memory on the room and emitted to clients ONLY at the
// synchronized reveal (status → 'active') — never in a public room payload.
//
// Lifecycle:  lobby → countdown → active → finished
//   - lobby:    players join (max 4); host can start
//   - countdown: board generated + held; clients see a timer, NOT the board
//   - active:    board revealed to everyone at the same instant; racing
//   - finished:  all players finished or DNF; placements 1..N reported
// =============================================================================

const db = require('../db');
const config = require('../config');
const { generateCode } = require('../util/roomCode');

// Terminal per-player states (player can no longer affect the race outcome).
const TERMINAL = new Set(['finished', 'dnf', 'disconnected', 'timeup']);

class RoomService {
    constructor(transport, puzzleService) {
        this.transport = transport; // realtime Transport (ws broadcast layer)
        this.puzzles = puzzleService;
        this.rooms = new Map(); // code → live room object
    }

    // ── Lookups ───────────────────────────────────────────────────────────────

    get(code) { return this.rooms.get(code); }

    _player(room, playerId) {
        return room ? room.players.find((p) => p.id === playerId) : null;
    }

    // ── Create / join ───────────────────────────────────────────────────────

    async createRoom(name, socketId) {
        let code;
        do { code = generateCode(); } while (this.rooms.has(code));

        const playerId = generateCode(8);
        const room = {
            code,
            status: 'lobby',
            hostId: playerId,
            puzzleId: null,
            board: null,        // in-memory only; never in public payloads
            startAt: null,
            endsAt: null,
            maxPlayers: config.maxPlayers,
            createdAt: Date.now(),
            revealTimer: null,
            raceTimer: null,
            players: [this._newPlayer(playerId, name, socketId, true)],
        };
        this.rooms.set(code, room);
        await this._persist(room);
        return { room, playerId };
    }

    async joinRoom(code, name, socketId) {
        const room = this.rooms.get(code);
        if (!room)                       throw new Error('Room not found');
        if (room.status !== 'lobby')     throw new Error('Race already started');
        if (room.players.length >= room.maxPlayers) throw new Error('Room is full');

        const playerId = generateCode(8);
        room.players.push(this._newPlayer(playerId, name, socketId, false));
        await this._persist(room);
        return { room, playerId };
    }

    _newPlayer(id, name, socketId, isHost) {
        return {
            id,
            name: (name || 'Player').slice(0, 16),
            socketId,
            isHost,
            status: 'lobby',   // lobby → racing → finished/dnf/disconnected
            cleared: 0,
            total: 0,
            finishedAt: null,
            placement: null,
        };
    }

    // ── Start the race (host only) ────────────────────────────────────────────

    async startRace(code, requesterId) {
        const room = this.rooms.get(code);
        if (!room)                       throw new Error('Room not found');
        if (room.hostId !== requesterId) throw new Error('Only the host can start');
        if (room.status !== 'lobby')     throw new Error('Race already started');

        // Generate + store the board now. It stays server-side until reveal.
        const { puzzleId, board } = await this.puzzles.generateAndStore(config.race);
        room.puzzleId = puzzleId;
        room.board    = board;

        // Enter countdown; clients get a start timestamp but NOT the board.
        room.status  = 'countdown';
        room.startAt = Date.now() + config.countdownMs;
        for (const p of room.players) {
            p.status = 'racing';
            p.cleared = 0;
            p.total = board.paths.length;
            p.finishedAt = null;
            p.placement = null;
        }
        await this._persist(room);

        this.transport.broadcast(code, 'race:countdown', { startAt: room.startAt });
        this.transport.broadcast(code, 'room:update', { room: this.publicRoom(room) });

        // Reveal the board to everyone simultaneously when the countdown ends.
        room.revealTimer = setTimeout(() => this._reveal(code), config.countdownMs);

        return this.publicRoom(room);
    }

    async _reveal(code) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'countdown') return;
        room.status = 'active';
        room.revealTimer = null;
        room.endsAt = Date.now() + config.raceDurationMs;
        await this._persist(room);

        // THE reveal — first and only time the board crosses the wire.
        this.transport.broadcast(code, 'race:start', {
            startAt:    room.startAt,
            endsAt:     room.endsAt,
            durationMs: config.raceDurationMs,
            board:      room.board,
            room:       this.publicRoom(room),
        });

        // Time limit — at expiry, unfinished players are ranked by % cleared.
        room.raceTimer = setTimeout(() => this._timeUp(code), config.raceDurationMs);
    }

    // ── In-race events ──────────────────────────────────────────────────────

    // Lightweight progress tick — broadcast only, not persisted per tick.
    markProgress(code, playerId, cleared, total) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'active') return null;
        const p = this._player(room, playerId);
        if (!p || TERMINAL.has(p.status)) return null;
        p.cleared = cleared;
        if (total != null) p.total = total;
        return { playerId, cleared: p.cleared, total: p.total };
    }

    // A player cleared the whole board → assign the next placement.
    async playerFinished(code, playerId) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'active') return null;
        const p = this._player(room, playerId);
        if (!p || TERMINAL.has(p.status)) return null;

        const placed = room.players.filter((q) => q.placement != null).length;
        p.placement  = placed + 1;
        p.status     = 'finished';
        p.finishedAt = Date.now();

        await this._persist(room);
        const ended = await this._maybeFinish(room);
        return { placement: p.placement, ended };
    }

    // A player ran out of lives or quit mid-race → DNF (no placement).
    async playerOut(code, playerId, reason = 'dnf') {
        const room = this.rooms.get(code);
        if (!room) return null;
        const p = this._player(room, playerId);
        if (!p || TERMINAL.has(p.status)) return null;

        p.status = reason === 'disconnected' ? 'disconnected' : 'dnf';
        await this._persist(room);
        const ended = room.status === 'active' ? await this._maybeFinish(room) : false;
        return { status: p.status, ended };
    }

    // ── Leave / disconnect ────────────────────────────────────────────────────

    // Returns { room, removed, closed } so the caller can broadcast/cleanup.
    async handleLeave(code, playerId) {
        const room = this.rooms.get(code);
        if (!room) return { closed: true };
        const p = this._player(room, playerId);
        if (!p) return { room };

        if (room.status === 'lobby') {
            // Drop them entirely; reassign host or close the room if empty.
            room.players = room.players.filter((q) => q.id !== playerId);
            if (room.players.length === 0) {
                this._destroy(room);
                return { closed: true, code };
            }
            if (room.hostId === playerId) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
            }
            await this._persist(room);
            return { room };
        }

        // Mid-race: mark DNF/disconnected and possibly end the race.
        await this.playerOut(code, playerId, 'disconnected');
        return { room };
    }

    // Find the room/player a socket belongs to (for disconnect handling).
    findBySocket(socketId) {
        for (const room of this.rooms.values()) {
            const p = room.players.find((q) => q.socketId === socketId);
            if (p) return { room, player: p };
        }
        return null;
    }

    // ── Race end ──────────────────────────────────────────────────────────────

    // Ends the race if every player is in a terminal state. Returns true if it did.
    async _maybeFinish(room) {
        const allDone = room.players.every((p) => TERMINAL.has(p.status));
        if (!allDone) return false;
        await this._endRace(room, false);
        return true;
    }

    // Fired when the race clock expires.
    async _timeUp(code) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'active') return;
        await this._endRace(room, true);
    }

    // Ends the race and broadcasts standings. On a timeout, players who never
    // cleared the board are ranked by progress (% cleared) and placed after the
    // finishers.
    async _endRace(room, byTimeout) {
        if (room.status === 'finished') return;

        if (byTimeout) {
            const ranked = room.players
                .filter((p) => p.placement == null && p.status === 'racing')
                .sort((a, b) => (b.cleared / (b.total || 1)) - (a.cleared / (a.total || 1)));
            let next = room.players.filter((p) => p.placement != null).length;
            for (const p of ranked) { p.placement = ++next; p.status = 'timeup'; }
        }

        room.status = 'finished';
        if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
        if (room.raceTimer)   { clearTimeout(room.raceTimer);   room.raceTimer = null; }
        await this._persist(room);

        this.transport.broadcast(room.code, 'race:finished', { results: this.buildResults(room) });
    }

    // Standings: ranked players by placement (1..N), then anyone who left.
    buildResults(room) {
        const ranked = room.players
            .filter((p) => p.placement != null)
            .sort((a, b) => a.placement - b.placement);
        const others = room.players.filter((p) => p.placement == null);
        return [...ranked, ...others].map((p) => ({
            id: p.id, name: p.name, placement: p.placement, status: p.status,
            solved: p.finishedAt != null, finishedAt: p.finishedAt,
            cleared: p.cleared, total: p.total,
        }));
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    // Client-facing room payload — NEVER includes the board or socket ids.
    publicRoom(room) {
        return {
            code: room.code,
            status: room.status,
            hostId: room.hostId,
            startAt: room.startAt,
            endsAt: room.endsAt || null,
            maxPlayers: room.maxPlayers,
            puzzleId: room.puzzleId,
            players: room.players.map((p) => ({
                id: p.id, name: p.name, isHost: p.isHost, status: p.status,
                cleared: p.cleared, total: p.total,
                placement: p.placement, finishedAt: p.finishedAt,
            })),
        };
    }

    async _persist(room) {
        try {
            const doc = this.publicRoom(room);
            doc.createdAt = new Date(room.createdAt);
            doc.updatedAt = new Date();
            await db.rooms().updateOne({ code: room.code }, { $set: doc }, { upsert: true });
        } catch (e) {
            console.warn(`[room] persist failed for ${room.code}: ${e.message}`);
        }
    }

    _destroy(room) {
        if (room.revealTimer) clearTimeout(room.revealTimer);
        if (room.raceTimer)   clearTimeout(room.raceTimer);
        this.rooms.delete(room.code);
        db.rooms().deleteOne({ code: room.code }).catch(() => {});
    }
}

module.exports = RoomService;
