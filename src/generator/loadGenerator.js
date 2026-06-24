// =============================================================================
// loadGenerator.js — run the browser board generator headlessly in Node.
//
// The generation subset (frontend/js: constants/utils/GridShape/BoardGenerator)
// is pure logic with zero DOM coupling, so we load it into a bare vm context
// and the SERVER generates boards with the EXACT same code the browser uses —
// no port, no bundling, no drift.
//
// createGenerator() returns:
//   build({ rows, cols, level, tier? }) → serialized board (client-ready shape)
//   sizesForLevel(level)                → [{ rows, cols }]
//   verifySolution(board, order)        → { valid, reason }
// =============================================================================

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const config = require('../config');
const { serializeBoard } = require('./serializeBoard');
const FILES = require('./files');

function buildSandbox() {
    // Minimal global surface (no DOM/canvas). We hand the vm Node's OWN Array /
    // Set / Map / typed arrays, so values cross the boundary without realm
    // mismatches (e.g. Array.isArray on a board passed in from Node works).
    const sandbox = {
        console: { log() {}, info() {}, warn() {}, error() {} },
        Math, Array, Object, Number, String, Boolean, JSON,
        Int8Array, Uint8Array, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array,
        Set, Map, WeakMap, WeakSet, Promise, Symbol,
        Infinity, NaN, undefined,
        Date,
        setTimeout: () => {},
        clearTimeout: () => {},
        performance: { now: () => Date.now() },
    };
    vm.createContext(sandbox);

    for (const f of FILES) {
        const code = fs.readFileSync(path.join(config.jsDir, f), 'utf8');
        try {
            vm.runInContext(code, sandbox, { filename: f });
        } catch (e) {
            throw new Error(`[generator] failed loading ${f}: ${e.message}`);
        }
    }

    // Instantiate the engine + server-side helpers as sandbox globals.
    vm.runInContext(`
        var __gen = new BoardGenerator();

        // Mirror GameController.newGame's board selection, server-side, with an
        // explicit size + level. Milestone levels (multiples of 10) become shaped
        // (mask) boards at the shape's intended size; everything else is the given
        // rectangle/square. Difficulty tier defaults to the level's tier.
        function __build(rows, cols, level, tierName) {
            var tier = tierName ? TIERS.find(function (t) { return t.name === tierName; }) : null;
            if (!tier) tier = tierForLevel(level);

            var COLS = cols, ROWS = rows, mask = null, motifs = null;
            var shapeName = (level % 10 === 0) ? GridShape.forLevel(level) : null;
            if (shapeName) {
                var ss = GridShape.milestoneSize(level);
                COLS = ss.COLS; ROWS = ss.ROWS;
                mask = GridShape.maskFor(shapeName, COLS, ROWS);
                motifs = GridShape.motifsFor(shapeName);
            }

            var result = __gen.generateForTier(COLS, ROWS, mask, tier, motifs);
            return { level: level, tier: tier.name, COLS: COLS, ROWS: ROWS, mask: mask, arrows: result.arrows };
        }

        // Sizes a level can use (for shaped/milestone rounds the caller picks one).
        function __sizesForLevel(level) {
            var ss = (level % 10 === 0) ? GridShape.milestoneSize(level) : sizeForLevel(level);
            return [{ rows: ss.ROWS, cols: ss.COLS }];
        }

        // Server-authoritative solve check: replay a player's clear order under the
        // SAME escape rule the board was built with — each tapped arrow's head ray
        // to the edge must be clear of other still-present arrows (its own cells
        // allowed). Reuses the engine's lane() so it can never drift from gameplay.
        function __verifySolution(board, order) {
            if (!board || !Array.isArray(board.arrows)) return { valid: false, reason: 'no-board' };
            if (!Array.isArray(order))                  return { valid: false, reason: 'order-missing' };
            if (order.length !== board.arrows.length)   return { valid: false, reason: 'order-length' };

            var C = board.COLS, R = board.ROWS;
            var byId = new Map(), occ = new Map();
            for (var i = 0; i < board.arrows.length; i++) {
                var a = board.arrows[i];
                byId.set(a.id, a);
                for (var j = 0; j < a.body.length; j++) occ.set(a.body[j], a.id);
            }

            var removed = new Set();
            for (var k = 0; k < order.length; k++) {
                var id = order[k], p = byId.get(id);
                if (!p)              return { valid: false, reason: 'unknown-arrow:' + id };
                if (removed.has(id)) return { valid: false, reason: 'duplicate-arrow:' + id };
                var head = p.body[p.body.length - 1];
                var own = new Set(p.body);
                var clear = lane(head, p.dir, C, R).every(function (x) { return !occ.has(x) || own.has(x); });
                if (!clear)          return { valid: false, reason: 'illegal-clear:' + id };
                for (var m = 0; m < p.body.length; m++) occ.delete(p.body[m]);
                removed.add(id);
            }
            if (removed.size !== board.arrows.length) return { valid: false, reason: 'incomplete' };
            return { valid: true, reason: 'ok' };
        }
    `, sandbox);

    return sandbox;
}

function createGenerator() {
    const sandbox = buildSandbox();

    return {
        // Generate one board → serialized, JSON-safe, client-ready document.
        build({ rows, cols, level, tier } = {}) {
            sandbox.__r = rows ?? 40;
            sandbox.__c = cols ?? 24;
            sandbox.__l = level ?? 12;
            sandbox.__t = tier || null;
            const board = vm.runInContext('__build(__r, __c, __l, __t)', sandbox);
            if (!board || !board.arrows || !board.arrows.length) {
                throw new Error('[generator] build returned no board');
            }
            return serializeBoard(board);
        },

        // The size(s) a level can use (shaped levels return the shape's size).
        sizesForLevel(level) {
            sandbox.__L = level;
            return vm.runInContext('__sizesForLevel(__L)', sandbox) || [];
        },

        // Verify a player's clear order against a serialized board.
        verifySolution(board, order) {
            sandbox.__vb = board;
            sandbox.__vo = order;
            return vm.runInContext('__verifySolution(__vb, __vo)', sandbox);
        },
    };
}

module.exports = { createGenerator };
