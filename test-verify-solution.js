// Standalone test for server-authoritative finish verification.
// No DB needed — exercises the generator's verifySolution directly.
const { createGenerator } = require('./src/generator/loadGenerator');

// Independent greedy solver (mirrors the escape rule) to produce a KNOWN-valid
// clear order to test against — a cross-check on the real verifier.
const D = { UP: [-1, 0], DOWN: [1, 0], LEFT: [0, -1], RIGHT: [0, 1] };
function ownerMap(b) {
    const W = b.gridCols + 1;
    const o = new Int32Array((b.gridRows + 1) * W).fill(-1);
    for (const p of b.paths) for (const n of p.nodes) o[n.r * W + n.c] = p.id;
    return { o, W, rows: b.gridRows, cols: b.gridCols };
}
function inB(g, r, c) { return r >= 0 && r <= g.rows && c >= 0 && c <= g.cols; }
function canEscape(g, p, removed) {
    const [dr, dc] = D[p.heading];
    const h = p.nodes[p.nodes.length - 1];
    let r = h.r, c = h.c;
    for (;;) {
        const nr = r + dr, nc = c + dc;
        if (!inB(g, nr, nc)) return true;
        const ow = g.o[nr * g.W + nc];
        if (ow === -1 || ow === p.id || removed.has(ow)) { r = nr; c = nc; continue; }
        return false;
    }
}
function greedyOrder(b) {
    const g = ownerMap(b), removed = new Set(), order = [];
    let prog = true;
    while (prog) {
        prog = false;
        for (const p of b.paths) {
            if (removed.has(p.id)) continue;
            if (canEscape(g, p, removed)) { removed.add(p.id); order.push(p.id); prog = true; }
        }
    }
    return { order, complete: removed.size === b.paths.length };
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const gen = createGenerator();

for (const [rows, cols, level] of [[12, 8, 5], [16, 12, 10], [20, 16, 15]]) {
    const board = gen.build({ rows, cols, level });
    const ids = board.paths.map((p) => p.id);
    console.log(`\nBoard ${board.gridRows}x${board.gridCols} L${level} — ${ids.length} paths`);

    const { order, complete } = greedyOrder(board);
    check('greedy produced a complete order', complete && order.length === ids.length);

    // Valid solve passes.
    check('valid clear order accepted', gen.verifySolution(board, order).valid === true);

    // Reversed order — generally illegal (last-cleared can't escape first).
    const rev = gen.verifySolution(board, [...order].reverse());
    check('reversed order rejected', rev.valid === false && rev.reason.startsWith('illegal'));

    // Incomplete order (missing last clear).
    check('incomplete order rejected', gen.verifySolution(board, order.slice(0, -1)).reason === 'order-length');

    // Duplicate id.
    const dup = [order[0], ...order.slice(0, -1)];
    check('duplicate path rejected', gen.verifySolution(board, dup).reason.startsWith('duplicate'));

    // Unknown id.
    check('unknown path rejected', gen.verifySolution(board, [999999, ...order.slice(1)]).reason.startsWith('unknown'));

    // Empty / missing order (the forged "I won instantly" claim).
    check('empty order rejected', gen.verifySolution(board, []).valid === false);
    check('missing order rejected', gen.verifySolution(board, undefined).reason === 'order-missing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
