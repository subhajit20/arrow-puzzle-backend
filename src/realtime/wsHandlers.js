// =============================================================================
// wsHandlers.js — WebSocket connection + message routing (raw `ws`).
//
// Wire protocol — every frame is JSON: { type, ...fields }.
//
// Client → Server (requests carry a reqId; server replies with an `ack`):
//   { type:'room:create', reqId, name }
//   { type:'room:join',   reqId, code, name }
//   { type:'room:start',  reqId, rounds }          (host; number of rounds)
//   { type:'race:progress', cleared, total }      (no ack)
//   { type:'race:finished', reqId }
//   { type:'room:leave' }                          (no ack)
//
// Server → Client:
//   { type:'ack', reqId, payload }                 (request result)
//   { type:'room:update', room }
//   { type:'race:countdown', startAt, round, totalRounds }
//   { type:'race:start', startAt, endsAt, durationMs, round, totalRounds, board, room }
//   { type:'race:progress', playerId, cleared, total }
//   { type:'race:placement', playerId, placement }
//   { type:'round:result', round, totalRounds, roundResults, standings, nextRoundInMs }  (non-final)
//   { type:'game:over', round, totalRounds, roundResults, standings, champions }         (final)
// =============================================================================

const HEARTBEAT_MS = 30000;

function registerWs(wss, rooms, transport) {
    // Heartbeat — terminate connections that stop responding to pings.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) { ws.terminate(); continue; }
            ws.isAlive = false;
            ws.ping();
        }
    }, HEARTBEAT_MS);
    wss.on('close', () => clearInterval(heartbeat));

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws._code = null;
        ws._playerId = null;
        ws.on('pong', () => { ws.isAlive = true; });

        console.log('[ws] connected');

        ws.on('message', async (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

            const { type, reqId } = msg;
            const ack = (payload) => {
                if (reqId != null) transport.send(ws, 'ack', { reqId, payload });
            };

            try {
                switch (type) {
                    case 'room:create': {
                        const { room, playerId } = await rooms.createRoom(msg.name, ws);
                        ws._code = room.code; ws._playerId = playerId;
                        transport.join(ws, room.code);
                        ack({ code: room.code, playerId, room: rooms.publicRoom(room) });
                        break;
                    }

                    case 'room:join': {
                        const code = String(msg.code || '').trim().toUpperCase();
                        const { room, playerId } = await rooms.joinRoom(code, msg.name, ws);
                        ws._code = room.code; ws._playerId = playerId;
                        transport.join(ws, room.code);
                        ack({ ok: true, playerId, room: rooms.publicRoom(room) });
                        transport.broadcast(room.code, 'room:update', { room: rooms.publicRoom(room) });
                        break;
                    }

                    case 'room:start': {
                        await rooms.startGame(ws._code, ws._playerId, msg.rounds);
                        ack({ ok: true }); // startGame broadcasts countdown + room:update + (later) race:start
                        break;
                    }

                    case 'race:progress': {
                        const tick = rooms.markProgress(ws._code, ws._playerId, msg.cleared, msg.total);
                        if (tick) transport.broadcastExcept(ws._code, ws, 'race:progress', tick);
                        break;
                    }

                    case 'race:finished': {
                        const res = await rooms.playerFinished(ws._code, ws._playerId);
                        if (res) {
                            transport.broadcast(ws._code, 'race:placement', { playerId: ws._playerId, placement: res.placement });
                            const room = rooms.get(ws._code);
                            if (room) transport.broadcast(ws._code, 'room:update', { room: rooms.publicRoom(room) });
                            ack({ placement: res.placement });
                        } else {
                            ack({ error: 'Could not record finish' });
                        }
                        break;
                    }

                    case 'room:leave': {
                        await leave(ws, false);
                        break;
                    }

                    default:
                        ack({ error: `Unknown message type: ${type}` });
                }
            } catch (e) {
                ack({ error: e.message });
            }
        });

        ws.on('close', () => {
            console.log('[ws] disconnected');
            leave(ws, true).catch(() => {});
        });
    });

    // Shared leave/disconnect handling.
    async function leave(ws, disconnected) {
        const code = ws._code;
        const playerId = ws._playerId;
        if (!code) return;

        const r = await rooms.handleLeave(code, playerId);
        transport.leave(ws, code);
        if (!disconnected) { ws._code = null; ws._playerId = null; }

        if (r && !r.closed) {
            const room = rooms.get(code);
            if (room) transport.broadcast(code, 'room:update', { room: rooms.publicRoom(room) });
        }
    }
}

module.exports = registerWs;
