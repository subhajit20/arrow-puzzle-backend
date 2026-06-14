// =============================================================================
// db.js — MongoDB connection lifecycle + collection accessors.
//
// Falls back to an in-memory store when Mongo is unreachable, so the server
// runs anywhere (local / LAN play) with zero external dependencies. Mongo is
// used for durability whenever it is available.
//
// Collections:
//   puzzles — { _id, boardJson, genParams, createdAt }   (the serialized board)
//   rooms   — { code, status, hostId, puzzleId, startAt, players[], ... }
// =============================================================================

const { MongoClient } = require('mongodb');
const config = require('./config');

let client = null;
let db = null;
let mem = null; // in-memory fallback store (Map of collectionName → MemCollection)

// ── In-memory collection (minimal subset used by the services) ──────────────

function hex24() {
    let s = '';
    for (let i = 0; i < 24; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return s;
}
function matches(doc, query) {
    return Object.keys(query).every((k) => String(doc[k]) === String(query[k]));
}

class MemCollection {
    constructor() { this.docs = []; }
    async createIndex() { return 'ok'; }
    async insertOne(doc) {
        const _id = doc._id || hex24();
        this.docs.push({ ...doc, _id });
        return { acknowledged: true, insertedId: _id };
    }
    async findOne(query) { return this.docs.find((d) => matches(d, query)) || null; }
    async updateOne(filter, update, opts = {}) {
        let doc = this.docs.find((d) => matches(d, filter));
        if (!doc && opts.upsert) { doc = { ...filter }; this.docs.push(doc); }
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { matchedCount: doc ? 1 : 0, upsertedCount: doc ? 1 : 0 };
    }
    async deleteOne(filter) {
        const i = this.docs.findIndex((d) => matches(d, filter));
        if (i >= 0) this.docs.splice(i, 1);
        return { deletedCount: i >= 0 ? 1 : 0 };
    }
}

function memCollection(name) {
    if (!mem) mem = new Map();
    if (!mem.has(name)) mem.set(name, new MemCollection());
    return mem.get(name);
}

// ── Connection ──────────────────────────────────────────────────────────────

async function connect() {
    try {
        client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 2000 });
        await client.connect();
        await client.db(config.dbName).command({ ping: 1 });
        db = client.db(config.dbName);
        await db.collection('rooms').createIndex({ code: 1 }, { unique: true });
        await db.collection('puzzles').createIndex({ createdAt: 1 });
        console.log(`[db] connected → ${config.mongoUri}/${config.dbName}`);
    } catch (e) {
        client = null;
        db = null;
        mem = new Map();
        console.warn(`[db] MongoDB unavailable (${e.message.split('\n')[0]}) — using IN-MEMORY store.`);
        console.warn('[db] Rooms/puzzles will NOT persist across restarts. Start MongoDB for durability.');
    }
    return db;
}

function isMemory() { return !db; }

function rooms()   { return db ? db.collection('rooms')   : memCollection('rooms'); }
function puzzles() { return db ? db.collection('puzzles') : memCollection('puzzles'); }

function getDb() {
    if (!db && !mem) throw new Error('[db] not connected — call connect() first');
    return db;
}

async function close() {
    if (client) await client.close();
    client = null;
    db = null;
    mem = null;
}

module.exports = { connect, getDb, rooms, puzzles, close, isMemory };
