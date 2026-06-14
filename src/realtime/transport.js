// =============================================================================
// transport.js — minimal room/broadcast layer over raw `ws`.
//
// Replaces Socket.IO's rooms + emit. Tracks which WebSocket connections belong
// to which room code and sends JSON frames of the form { type, ...payload }.
// =============================================================================

const WebSocket = require('ws');

class Transport {
    constructor() {
        this.roomSockets = new Map(); // code → Set<ws>
    }

    // Send one JSON frame to a single connection.
    send(ws, type, payload = {}) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, ...payload }));
        }
    }

    // Membership — mirrors socket.io's join/leave.
    join(ws, code) {
        if (!this.roomSockets.has(code)) this.roomSockets.set(code, new Set());
        this.roomSockets.get(code).add(ws);
    }

    leave(ws, code) {
        const set = this.roomSockets.get(code);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) this.roomSockets.delete(code);
    }

    // Broadcast to every connection in a room.
    broadcast(code, type, payload = {}) {
        const set = this.roomSockets.get(code);
        if (!set) return;
        const frame = JSON.stringify({ type, ...payload });
        for (const ws of set) {
            if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        }
    }

    // Broadcast to everyone in a room except the originating connection.
    broadcastExcept(code, exceptWs, type, payload = {}) {
        const set = this.roomSockets.get(code);
        if (!set) return;
        const frame = JSON.stringify({ type, ...payload });
        for (const ws of set) {
            if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) ws.send(frame);
        }
    }
}

module.exports = Transport;
