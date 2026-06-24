// =============================================================================
// serializeBoard.js — convert a __build() result into a portable, JSON-safe
// board document for the new reverse-construction engine.
//
// The shape is exactly what the React client's GameState consumes:
//   { level, tier, COLS, ROWS, mask, arrows: [{ id, body:[cellId…], dir }] }
//   - cellId = r*COLS + c (single grid; no micro-grid / hEdge / vEdge)
//   - dir    = "N" | "S" | "E" | "W"
//   - mask   = Uint8Array flattened to a plain array (1 = in-board), or null
// This is the "share the board by id" artifact: everything needed to render,
// nothing the client must recompute.
//
// Note: the vm sandbox is given Node's own Array/Set/typed-array globals, so
// the build result is already Node-realm; Array.from is used only to flatten
// the mask Uint8Array and to defensively copy bodies.
// =============================================================================

function serializeBoard(board) {
    return {
        level: board.level,
        tier:  board.tier,
        COLS:  board.COLS,
        ROWS:  board.ROWS,
        mask:  board.mask ? Array.from(board.mask) : null,
        arrows: board.arrows.map((a) => ({
            id:   a.id,
            body: Array.from(a.body),
            dir:  a.dir,
        })),
    };
}

module.exports = { serializeBoard };
