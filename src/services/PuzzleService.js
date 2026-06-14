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

class PuzzleService {
    constructor(generator) {
        this.generator = generator; // from createGenerator()
    }

    // Generates a fresh board and persists it. Returns { puzzleId, board }.
    async generateAndStore({ rows, cols, level }) {
        const t0 = Date.now();
        const board = this.generator.build({ rows, cols, level });
        const genMs = Date.now() - t0;

        const doc = {
            boardJson: board,
            genParams: { rows: board.gridRows, cols: board.gridCols, level: board.level },
            genMs,
            createdAt: new Date(),
        };
        const res = await db.puzzles().insertOne(doc);
        console.log(`[puzzle] generated ${board.gridRows}x${board.gridCols} ` +
            `(${board.paths.length} paths, ${genMs}ms) → ${res.insertedId}`);

        return { puzzleId: res.insertedId.toString(), board };
    }

    // Fetches a stored board by id (used for reconnect-into-active-race).
    async getBoard(puzzleId) {
        const doc = await db.puzzles().findOne({ _id: new ObjectId(puzzleId) });
        return doc ? doc.boardJson : null;
    }
}

module.exports = PuzzleService;
