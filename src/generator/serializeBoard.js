// =============================================================================
// serializeBoard.js — convert a Generator.build() result into a portable,
// JSON-safe board document.
//
// The shape matches the browser's Persistence V5 format (gridRows/gridCols,
// hEdge[], vEdge[], paths[]) so the client can render it with its existing
// deserialize path — PLUS `mask`, so a shaped board renders identically
// without the client re-deriving it. This is the "share the board by id"
// artifact: everything needed to render, nothing that must be recomputed.
// =============================================================================

// Typed arrays from the vm sandbox are a different realm than Node's, but
// Array.from() works on any array-like / iterable across realms.
const toArray = (row) => Array.from(row);

function serializeResult(result, level) {
    const { grid, paths, difficulty } = result;

    return {
        version:         5,
        gridRows:        grid.rows,
        gridCols:        grid.cols,
        level,
        boardDifficulty: difficulty || 'NORMAL',
        mask:            grid.mask ? Array.from(grid.mask) : null,
        hEdge:           grid.hEdge.map(toArray),
        vEdge:           grid.vEdge.map(toArray),
        paths: paths.map((p) => ({
            id:            p.id,
            nodes:         p.nodes.map((n) => ({ r: n.r, c: n.c })),
            heading:       p.heading,
            state:         'IDLE',
            animProgress:  0,
            originalNodes: (p.originalNodes || p.nodes).map((n) => ({ r: n.r, c: n.c })),
        })),
    };
}

module.exports = { serializeResult };
