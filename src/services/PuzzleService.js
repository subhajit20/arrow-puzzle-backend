// =============================================================================
// PuzzleService.js — generate a board server-side and store it as a document.
//
// The board lives ONLY here (and in the active room's memory) until the race
// reveal — it is never part of any room payload sent to clients before then.
// That is what makes "nobody, not even the host, can see it early" true: the
// board doesn't leave the server until status === 'active'.
// =============================================================================

const { ObjectId } = require('mongodb');
const db = require('../db');
const config = require('../config');

class PuzzleService {
    constructor(generator) {
        this.generator = generator; // from createGenerator()
    }

    // Chooses round params: usually a rectangular/square board, sometimes a
    // shaped (milestone) board paired with its intended sizes.
    _pickParams() {
        const r = config.race;
        if (Math.random() < r.shapedChance) {
            // Milestone levels in range (multiples of 10) → shaped masks.
            const levels = [];
            for (let l = Math.ceil(r.levelMin / 10) * 10; l <= r.levelMax; l += 10) levels.push(l);
            if (levels.length) {
                const level = levels[Math.floor(Math.random() * levels.length)];
                const sizes = this.generator.sizesForLevel(level);
                if (sizes && sizes.length) {
                    const s = sizes[Math.floor(Math.random() * sizes.length)];
                    return { rows: s.rows, cols: s.cols, level };
                }
            }
        }
        return r.pick(); // rectangular / square
    }

    // Generates a fresh board and persists it. Returns { puzzleId, board }.
    // With no params, picks a random size + level for the round.
    async generateAndStore(params) {
        const { rows, cols, level } = params || this._pickParams();
        const t0 = Date.now();
        const board = this.generator.build({ rows, cols, level });
        const genMs = Date.now() - t0;

        const doc = {
            boardJson: board,
            genParams: { rows: board.ROWS, cols: board.COLS, level: board.level },
            genMs,
            createdAt: new Date(),
        };
        const res = await db.puzzles().insertOne(doc);
        console.log(`[puzzle] generated ${board.ROWS}x${board.COLS} L${level} ` +
            `(${board.arrows.length} arrows, ${board.tier}, ${genMs}ms) → ${res.insertedId}`);

        return { puzzleId: res.insertedId.toString(), board };
    }

    // Verifies a player's clear order solves the given board. Returns
    // { valid: boolean, reason: string }. Delegates to the headless generator
    // so verification uses the exact escape model the board was built with.
    verifySolution(board, order) {
        return this.generator.verifySolution(board, order);
    }

    // Fetches a stored board by id (used for reconnect-into-active-race).
    async getBoard(puzzleId) {
        const doc = await db.puzzles().findOne({ _id: new ObjectId(puzzleId) });
        return doc ? doc.boardJson : null;
    }
}

module.exports = PuzzleService;
