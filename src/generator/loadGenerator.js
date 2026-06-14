// =============================================================================
// loadGenerator.js — run the browser board generator headlessly in Node.
//
// The generator (js/*.js) is pure logic with zero DOM coupling — proven by
// test-regression.js, which loads it into a bare vm context. We replicate that
// here so the SERVER can generate boards: same code, no port, no bundling.
//
// createGenerator() returns { build({rows, cols, level}) → serialized board }.
// =============================================================================

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');
const config = require('../config');
const { serializeResult } = require('./serializeBoard');
const FILES = require('./files');

function buildSandbox() {
    // Same minimal global surface the generator expects (no DOM, no canvas).
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

    // Instantiate the pipeline as sandbox globals (same wiring as the harness).
    vm.runInContext(`
        var oracle  = new SolvabilityOracle();
        var builder = new RCBuilder(oracle);
        var diff    = new DifficultyEngine(oracle);
        var val     = new Validator(oracle);
        var gen     = new Generator(builder, diff, val);
    `, sandbox);

    return sandbox;
}

function createGenerator() {
    const sandbox = buildSandbox();

    return {
        // Generates one board and returns the serialized, JSON-safe document.
        build({ rows, cols, level, batch = 4, context = 'normal' } = {}) {
            const r = rows  ?? config.race.rows;
            const c = cols  ?? config.race.cols;
            const l = level ?? config.race.level;

            sandbox.__r = r; sandbox.__c = c; sandbox.__l = l;
            sandbox.__b = batch; sandbox.__x = context;

            // Run inside the context so instanceof / typed-array realms line up.
            const result = vm.runInContext('gen.build(__r, __c, __l, __b, __x)', sandbox);
            if (!result || !result.paths || !result.grid) {
                throw new Error('[generator] build returned no board');
            }
            return serializeResult(result, l);
        },
    };
}

module.exports = { createGenerator };
