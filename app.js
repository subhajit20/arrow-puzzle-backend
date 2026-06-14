// =============================================================================
// app.js — entry point (backend root). Wires MongoDB + the headless generator
// + a raw WebSocket (ws) server over Node's http server.
//
//   HTTP:   GET /health        → liveness probe
//           GET /debug/board   → generate+return one board (dev sanity check)
//   WS:     realtime room / race protocol (see src/realtime/wsHandlers.js)
// =============================================================================

const http = require('http');
const { WebSocketServer } = require('ws');

const config = require('./src/config');
const db = require('./src/db');
const { createGenerator } = require('./src/generator/loadGenerator');
const PuzzleService = require('./src/services/PuzzleService');
const RoomService = require('./src/services/RoomService');
const Transport = require('./src/realtime/transport');
const registerWs = require('./src/realtime/wsHandlers');

async function main() {
    // 1. Database
    await db.connect();

    // 2. Generator — load the existing browser generator headlessly + warm up.
    const generator = createGenerator();
    try {
        const t0 = Date.now();
        const sample = generator.build(config.race.pick());
        console.log(`[generator] ready — sample ${sample.gridRows}x${sample.gridCols}, ` +
            `${sample.paths.length} paths in ${Date.now() - t0}ms`);
    } catch (e) {
        console.error('[generator] FAILED to produce a board:', e.message);
        process.exit(1);
    }

    const puzzles = new PuzzleService(generator);

    // 3. Realtime room service (needs the transport for broadcasts).
    const transport = new Transport();
    const rooms = new RoomService(transport, puzzles);

    // 4. HTTP server (health + dev board preview)
    const server = http.createServer((req, res) => {
        const url = (req.url || '').split('?')[0];
        res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);

        if (url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, rooms: rooms.rooms.size }));
        }
        if (url === '/debug/board') {
            try {
                const board = generator.build(config.race.pick());
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(board));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    // 5. WebSocket server (attached to the same http server / port)
    const wss = new WebSocketServer({ server });
    registerWs(wss, rooms, transport);

    // 6. Listen
    server.listen(config.port, () => {
        console.log(`[server] listening on :${config.port} (ws + http)`);
    });

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\n[server] shutting down…');
        wss.close();
        server.close();
        await db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('[server] fatal:', err);
    process.exit(1);
});
