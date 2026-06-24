// =============================================================================
// RoomService.js — authoritative room lifecycle + multi-round race orchestration.
//
// A "game" is a sequence of N rounds (host-chosen). Each round is one race on a
// freshly generated board. Players earn points per round by placement; after
// the final round the cumulative leader(s) are crowned champion. The room is
// reusable — after a game ends the host can pick rounds and start another one
// without anyone re-joining.
//
// Lifecycle:
//   lobby → [ countdown → active → intermission ]×(N-1) → countdown → active → gameover
//   gameover → (host starts again) → lobby-equivalent → countdown → …
//
// The board is held in server memory and emitted ONLY at the synchronized
// reveal (status → 'active') — never in a public room payload.
// =============================================================================

const db = require('../db');
const config = require('../config');
const { generateCode } = require('../util/roomCode');

// Terminal per-player states for a round (can no longer affect the round).
const TERMINAL = new Set(['finished', 'dnf', 'disconnected', 'timeup']);
// States where the room is idle and a new game / join is allowed.
const IDLE = new Set(['lobby', 'gameover']);

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
            rounds: 1,          // total rounds for the current game
            currentRound: 0,    // 1-based once a game is running
            maxPlayers: config.maxPlayers,
            createdAt: Date.now(),
            revealTimer: null,
            raceTimer: null,
            intermissionTimer: null,
            players: [this._newPlayer(playerId, name, socketId, true)],
        };
        this.rooms.set(code, room);
        await this._persist(room);
        return { room, playerId };
    }

    async joinRoom(code, name, socketId) {
        const room = this.rooms.get(code);
        if (!room)                  throw new Error('Room not found');
        if (!IDLE.has(room.status)) throw new Error('Game already in progress');
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
            // Per-round (reset each round):
            status: 'lobby',
            cleared: 0,
            total: 0,
            finishedAt: null,
            placement: null,
            // Per-game (reset each game):
            gamePoints: 0,
            roundsWon: 0,
        };
    }

    // ── Start a game (host only) ───────────────────────────────────────────────

    async startGame(code, requesterId, rounds) {
        const room = this.rooms.get(code);
        if (!room)                       throw new Error('Room not found');
        if (room.hostId !== requesterId) throw new Error('Only the host can start');
        if (!IDLE.has(room.status))      throw new Error('Game already in progress');

        const n = Math.max(1, Math.min(config.maxRounds, parseInt(rounds, 10) || 1));
        room.rounds = n;
        room.currentRound = 0;
        for (const p of room.players) { p.gamePoints = 0; p.roundsWon = 0; }

        await this._beginRound(code);
    }

    // Generates the next round's board and runs its countdown.
    async _beginRound(code) {
        const room = this.rooms.get(code);
        if (!room) return;
        room.currentRound += 1;

        // Tell clients a board is being generated (larger boards take a moment),
        // so they can show a loader until the countdown begins.
        this.transport.broadcast(code, 'race:generating', {
            round: room.currentRound, totalRounds: room.rounds,
        });

        // Generate + store the board now (random size + level). Stays server-side until reveal.
        const { puzzleId, board } = await this.puzzles.generateAndStore();
        room.puzzleId = puzzleId;
        room.board = board;

        // Reset per-round fields for active participants (skip those who left).
        for (const p of room.players) {
            if (p.status === 'disconnected') continue;
            p.status = 'racing';
            p.cleared = 0;
            p.total = board.arrows.length;
            p.finishedAt = null;
            p.placement = null;
        }

        room.status = 'countdown';
        room.startAt = Date.now() + config.countdownMs;
        room.intermissionTimer = null;
        await this._persist(room);

        this.transport.broadcast(code, 'race:countdown', {
            startAt: room.startAt, round: room.currentRound, totalRounds: room.rounds,
        });
        this.transport.broadcast(code, 'room:update', { room: this.publicRoom(room) });

        room.revealTimer = setTimeout(() => this._reveal(code), config.countdownMs);
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
            startAt:     room.startAt,
            endsAt:      room.endsAt,
            durationMs:  config.raceDurationMs,
            round:       room.currentRound,
            totalRounds: room.rounds,
            board:       room.board,
            room:        this.publicRoom(room),
        });

        room.raceTimer = setTimeout(() => this._endRound(code, true), config.raceDurationMs);
    }

    // ── In-round events ───────────────────────────────────────────────────────

    markProgress(code, playerId, cleared, total) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'active') return null;
        const p = this._player(room, playerId);
        if (!p || TERMINAL.has(p.status)) return null;
        p.cleared = cleared;
        if (total != null) p.total = total;
        return { playerId, cleared: p.cleared, total: p.total };
    }

    async playerFinished(code, playerId, order) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'active') return null;
        const p = this._player(room, playerId);
        if (!p || TERMINAL.has(p.status)) return null;

        // Server-authoritative finish: the client claims a win, but the server
        // holds the board and replays the player's clear order to confirm it is
        // a real, complete, collision-free solution. A bad/forged claim is
        // rejected — the player stays in the race and can keep solving.
        const check = this.puzzles.verifySolution(room.board, order);
        if (!check.valid) {
            console.warn(`[room] ${code} rejected finish from ${p.name} (${playerId}): ${check.reason}`);
            return { rejected: true, reason: check.reason };
        }

        const placed = room.players.filter((q) => q.placement != null).length;
        p.placement  = placed + 1;
        p.status     = 'finished';
        p.finishedAt = Date.now();

        await this._persist(room);
        await this._maybeEndRound(room);
        return { placement: p.placement };
    }

    // ── Leave / disconnect ────────────────────────────────────────────────────

    async handleLeave(code, playerId) {
        const room = this.rooms.get(code);
        if (!room) return { closed: true };
        const p = this._player(room, playerId);
        if (!p) return { room };

        if (IDLE.has(room.status)) {
            // Idle room → drop entirely; reassign host or destroy if empty.
            room.players = room.players.filter((q) => q.id !== playerId);
            if (room.players.length === 0) { this._destroy(room); return { closed: true, code }; }
            if (room.hostId === playerId) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
            }
            await this._persist(room);
            return { room };
        }

        // Mid-game: mark disconnected; may end the current round.
        p.status = 'disconnected';
        await this._persist(room);
        if (room.status === 'active') await this._maybeEndRound(room);
        return { room };
    }

    findBySocket(socketId) {
        for (const room of this.rooms.values()) {
            const p = room.players.find((q) => q.socketId === socketId);
            if (p) return { room, player: p };
        }
        return null;
    }

    // ── Round / game end ────────────────────────────────────────────────────────

    // Ends the round once every player is terminal.
    async _maybeEndRound(room) {
        if (room.players.every((p) => TERMINAL.has(p.status))) {
            await this._endRound(room.code, false);
        }
    }

    // Ends the current round: ranks unfinished players by % (on timeout), awards
    // points, then either starts the next round or crowns the champion(s).
    async _endRound(code, byTimeout) {
        const room = this.rooms.get(code);
        if (!room || room.status !== 'active') return;

        if (byTimeout) {
            const ranked = room.players
                .filter((p) => p.placement == null && p.status === 'racing')
                .sort((a, b) => (b.cleared / (b.total || 1)) - (a.cleared / (a.total || 1)));
            let next = room.players.filter((p) => p.placement != null).length;
            for (const p of ranked) { p.placement = ++next; p.status = 'timeup'; }
        }

        if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
        if (room.raceTimer)   { clearTimeout(room.raceTimer);   room.raceTimer = null; }

        // Award round points: placement 1..K → K..1 points (K = ranked players).
        const ranked = room.players.filter((p) => p.placement != null).length;
        for (const p of room.players) {
            if (p.placement != null) {
                p.gamePoints += (ranked - p.placement + 1);
                if (p.placement === 1) p.roundsWon += 1;
            }
        }

        const isFinal = room.currentRound >= room.rounds;

        if (isFinal) {
            room.status = 'gameover';
            await this._persist(room);
            this.transport.broadcast(code, 'game:over', {
                round: room.currentRound, totalRounds: room.rounds,
                roundResults: this.buildRoundResults(room),
                standings: this.buildStandings(room),
                champions: this.computeChampions(room),
            });
        } else {
            room.status = 'intermission';
            await this._persist(room);
            this.transport.broadcast(code, 'round:result', {
                round: room.currentRound, totalRounds: room.rounds,
                roundResults: this.buildRoundResults(room),
                standings: this.buildStandings(room),
                nextRoundInMs: config.roundIntermissionMs,
            });
            room.intermissionTimer = setTimeout(() => this._beginRound(code), config.roundIntermissionMs);
        }
    }

    // This round's placements + the points each player earned this round.
    buildRoundResults(room) {
        const ranked = room.players.filter((p) => p.placement != null).length;
        const sorted = [...room.players].sort((a, b) => {
            if (a.placement == null) return 1;
            if (b.placement == null) return -1;
            return a.placement - b.placement;
        });
        return sorted.map((p) => ({
            id: p.id, name: p.name, placement: p.placement, status: p.status,
            solved: p.finishedAt != null, cleared: p.cleared, total: p.total,
            points: p.placement != null ? (ranked - p.placement + 1) : 0,
        }));
    }

    // Cumulative game standings, sorted by points then rounds won.
    buildStandings(room) {
        const max = Math.max(0, ...room.players.map((p) => p.gamePoints));
        return [...room.players]
            .sort((a, b) => (b.gamePoints - a.gamePoints) || (b.roundsWon - a.roundsWon) || a.name.localeCompare(b.name))
            .map((p) => ({
                id: p.id, name: p.name, gamePoints: p.gamePoints, roundsWon: p.roundsWon,
                isChampion: room.status === 'gameover' && p.gamePoints === max && max > 0,
            }));
    }

    computeChampions(room) {
        const max = Math.max(0, ...room.players.map((p) => p.gamePoints));
        if (max <= 0) return [];
        return room.players.filter((p) => p.gamePoints === max).map((p) => ({ id: p.id, name: p.name }));
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    publicRoom(room) {
        return {
            code: room.code,
            status: room.status,
            hostId: room.hostId,
            startAt: room.startAt,
            endsAt: room.endsAt || null,
            rounds: room.rounds,
            currentRound: room.currentRound,
            maxPlayers: room.maxPlayers,
            puzzleId: room.puzzleId,
            players: room.players.map((p) => ({
                id: p.id, name: p.name, isHost: p.isHost, status: p.status,
                cleared: p.cleared, total: p.total,
                placement: p.placement, finishedAt: p.finishedAt,
                gamePoints: p.gamePoints, roundsWon: p.roundsWon,
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
        if (room.revealTimer)       clearTimeout(room.revealTimer);
        if (room.raceTimer)         clearTimeout(room.raceTimer);
        if (room.intermissionTimer) clearTimeout(room.intermissionTimer);
        this.rooms.delete(room.code);
        db.rooms().deleteOne({ code: room.code }).catch(() => {});
    }
}

module.exports = RoomService;
