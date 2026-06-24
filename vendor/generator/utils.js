// Pure grid/random helpers shared across the game. Depends on constants.js (DIRS, DK).

// Cell id -> [col, row].
const cr = (id, C) => [id % C, Math.floor(id / C)];

// Random integer in [0, n).
const rnd = n => Math.floor(Math.random() * n);

// Random element of an array.
const pick = a => a[rnd(a.length)];

// Every cell id from `head` (exclusive) straight in `dir` to the board edge.
function lane(head, dir, C, R) {
    let [c, r] = cr(head, C);
    const [dc, dr] = DIRS[dir];
    const o = [];
    while (true) {
        c += dc; r += dr;
        if (c < 0 || c >= C || r < 0 || r >= R) break;
        o.push(r * C + c);
    }
    return o;
}

// (Board shape masks live in GridShape.js.)

// Number of occupied orthogonal neighbours of `id` (occ is a Uint8Array mask).
function occNbrs(occ, id, C, R) {
    const x = id % C, y = Math.floor(id / C); let n = 0;
    for (const d of DK) {
        const [dc, dr] = DIRS[d];
        const nx = x + dc, ny = y + dr;
        if (nx < 0 || nx >= C || ny < 0 || ny >= R) continue;
        if (occ[ny * C + nx]) n++;
    }
    return n;
}
