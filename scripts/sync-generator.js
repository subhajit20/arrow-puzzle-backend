// =============================================================================
// sync-generator.js — vendor the browser generator into the backend.
//
// Copies the files listed in src/generator/files.js from the frontend's js/
// directory into backend/vendor/generator/, so the backend is self-contained
// and deployable on its own (no dependency on ../frontend at runtime).
//
// Run after changing any generator source, then commit backend/vendor/:
//   npm run sync-generator
//
// Source can be overridden with GENERATOR_SRC_DIR.
// =============================================================================

const fs   = require('fs');
const path = require('path');
const FILES = require('../src/generator/files');

const SRC = process.env.GENERATOR_SRC_DIR
    ? path.resolve(process.env.GENERATOR_SRC_DIR)
    : path.resolve(__dirname, '../../frontend/js');
const DEST = path.resolve(__dirname, '../vendor/generator');

if (!fs.existsSync(SRC)) {
    console.error(`[sync-generator] source not found: ${SRC}`);
    console.error('  Set GENERATOR_SRC_DIR to the frontend js/ directory.');
    process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const f of FILES) {
    const src = path.join(SRC, f);
    if (!fs.existsSync(src)) {
        console.error(`[sync-generator] missing generator file: ${src}`);
        process.exit(1);
    }
    fs.copyFileSync(src, path.join(DEST, f));
    copied++;
}

console.log(`[sync-generator] vendored ${copied} files`);
console.log(`  from: ${SRC}`);
console.log(`  to:   ${DEST}`);
console.log('  → commit backend/vendor/ so the backend deploys standalone.');
