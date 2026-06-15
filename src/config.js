// =============================================================================
// config.js — Environment-driven configuration (single source of truth)
// =============================================================================

// dotenv is optional — guard so the generator can be smoke-tested before
// `npm install`. Falls back to process.env / defaults when absent.
try { require('dotenv').config(); } catch (_) { /* not installed yet */ }
const path = require('path');
const fs = require('fs');

// Where the generator source lives. Priority:
//   1. GENERATOR_JS_DIR env override (explicit)
//   2. backend/vendor/generator — the vendored copy (deploy-safe, committed)
//   3. ../../frontend/js — the monorepo source (dev fallback)
function resolveJsDir() {
    if (process.env.GENERATOR_JS_DIR) return path.resolve(process.env.GENERATOR_JS_DIR);
    const vendored = path.resolve(__dirname, '../vendor/generator');
    if (fs.existsSync(vendored)) return vendored;
    return path.resolve(__dirname, '../../frontend/js');
}

const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};

module.exports = {
    port:        int(process.env.PORT, 3001),
    mongoUri:    process.env.MONGO_URI || 'mongodb://127.0.0.1:27017',
    dbName:      process.env.DB_NAME   || 'vecto_multiplayer',
    corsOrigin:  process.env.CORS_ORIGIN || '*',

    // Delay between host pressing Start and the synchronized board reveal.
    countdownMs: int(process.env.COUNTDOWN_MS, 3500),

    // Race time limit. When it expires, anyone who hasn't cleared the board is
    // ranked by percentage cleared. Default 2 minutes.
    raceDurationMs: int(process.env.RACE_DURATION_MS, 120000),

    // Pause between rounds (shows round standings before the next round begins).
    roundIntermissionMs: int(process.env.ROUND_INTERMISSION_MS, 5000),

    // Upper bound on rounds a host can pick for a game.
    maxRounds: int(process.env.MAX_ROUNDS, 10),

    // Max players per room (your spec).
    maxPlayers: 4,

    // Race board parameters. Each round picks a random size from this pool and
    // a random level. The generator is the same one the browser uses; sizes are
    // drawn from its known-good size tables (a mix of rectangles and squares).
    // Level is randomized in [levelMin, levelMax] but NEVER a multiple of 10 —
    // those are milestone levels that produce shaped (heart/donut) masks; we
    // want plain rectangles/squares. The level is never surfaced to players.
    race: {
        sizes: [
            // Rectangular (portrait)
            { rows: 36, cols: 22 }, { rows: 40, cols: 24 }, { rows: 42, cols: 26 },
            { rows: 44, cols: 28 }, { rows: 48, cols: 28 }, { rows: 50, cols: 30 },
            { rows: 52, cols: 32 }, { rows: 56, cols: 34 },
            // Square
            { rows: 28, cols: 28 }, { rows: 34, cols: 34 },
            { rows: 40, cols: 40 }, { rows: 46, cols: 46 },
        ],
        levelMin: int(process.env.RACE_LEVEL_MIN, 10),
        levelMax: int(process.env.RACE_LEVEL_MAX, 300),

        // Probability a round is a shaped (milestone) board — heart/donut/etc.
        // at a multiple-of-10 level, using the shape's intended sizes. The rest
        // are plain rectangles/squares.
        shapedChance: parseFloat(process.env.RACE_SHAPED_CHANCE || '0.35'),

        // Picks a random rectangular/square { rows, cols, level } for a round.
        pick() {
            const s = this.sizes[Math.floor(Math.random() * this.sizes.length)];
            let level;
            do {
                level = this.levelMin + Math.floor(Math.random() * (this.levelMax - this.levelMin + 1));
            } while (level % 10 === 0); // skip milestone (shaped-mask) levels
            return { rows: s.rows, cols: s.cols, level };
        },
    },

    // Absolute path to the generator source — vendored copy if present,
    // else the monorepo frontend/js (see resolveJsDir above).
    jsDir: resolveJsDir(),
};
