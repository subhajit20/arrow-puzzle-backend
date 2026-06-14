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

    // Max players per room (your spec).
    maxPlayers: 4,

    // Race board parameters. The generator is the same one the browser uses.
    // 48×28 at level 7 → a full rectangle (~150 packed pieces, generates in
    // well under 1s). Avoid multiples of 10 for RACE_LEVEL — those trigger
    // milestone *shaped* masks (heart/donut) instead of a plain rectangle.
    race: {
        rows:  int(process.env.RACE_ROWS, 48),
        cols:  int(process.env.RACE_COLS, 28),
        level: int(process.env.RACE_LEVEL, 7),
    },

    // Absolute path to the generator source — vendored copy if present,
    // else the monorepo frontend/js (see resolveJsDir above).
    jsDir: resolveJsDir(),
};
