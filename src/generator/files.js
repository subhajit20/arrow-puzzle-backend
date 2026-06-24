// =============================================================================
// files.js — the exact set of generator source files the server loads.
//
// Single source of truth shared by:
//   - loadGenerator.js  (loads these into the vm sandbox)
//   - scripts/sync-generator.js  (vendors these into backend/vendor/generator)
//
// These are the NEW reverse-construction engine's generation subset (the same
// classic-script files the browser loads), in dependency order:
//   constants.js  → DIRS/COLORS/TIERS/sizeForLevel/tierForLevel/CELL_SIZE/…
//   utils.js      → cr/rnd/pick/lane/occNbrs (needs DIRS/DK from constants)
//   GridShape.js  → shape masks + per-shape sizes/motifs (self-contained)
//   BoardGenerator.js → generateForTier(C,R,mask,tier,motifs) → { arrows }
//
// Rendering/input/HUD files are intentionally excluded — the server only
// generates boards, it never draws them.
// =============================================================================

module.exports = [
    'constants.js',
    'utils.js',
    'GridShape.js',
    'BoardGenerator.js',
];
