// End-to-end test of the raw-WS protocol against a running server.
// Simulates a 4-player room: create → 3 joins → 5th rejected → host start →
// synced reveal → finishes in order → placements + final standings.
//   node test-flow.js

const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:3001';

function client() {
    const ws = new WebSocket(URL);
    const pending = {}; let seq = 0; const handlers = {};
    ws.on('message', (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.type === 'ack') { const r = pending[m.reqId]; if (r) { delete pending[m.reqId]; r(m.payload); } return; }
        (handlers[m.type] || (() => {}))(m);
    });
    return {
        ready: new Promise((res) => ws.on('open', res)),
        request: (type, data = {}) => new Promise((res) => { const reqId = ++seq; pending[reqId] = res; ws.send(JSON.stringify({ type, reqId, ...data })); }),
        send: (type, data = {}) => ws.send(JSON.stringify({ type, ...data })),
        on: (type, fn) => { handlers[type] = fn; },
        once: (type) => new Promise((res) => { handlers[type] = (m) => { delete handlers[type]; res(m); }; }),
        close: () => ws.close(),
    };
}

(async () => {
    let pass = true;
    const A = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

    const host = client(); await host.ready;
    const created = await host.request('room:create', { name: 'Alice' });
    A(created && created.code && created.code.length === 6, `host created room ${created.code}`);
    const code = created.code;

    let hostBoard = null, finishResults = null;
    host.on('race:start', (m) => { hostBoard = m.board; });
    host.on('race:finished', (m) => { finishResults = m.results; });

    const guests = [client(), client(), client()];
    const names = ['Bob', 'Cara', 'Dan'];
    for (let i = 0; i < 3; i++) { await guests[i].ready; const r = await guests[i].request('room:join', { code, name: names[i] }); A(r && r.ok, `${names[i]} joined (${r.room?.players.length} players)`); }

    const fifth = client(); await fifth.ready;
    const full = await fifth.request('room:join', { code, name: 'Eve' });
    A(full && full.error === 'Room is full', `5th player rejected: "${full.error}"`);
    fifth.close();

    const badStart = await guests[0].request('room:start');
    A(badStart && badStart.error === 'Only the host can start', `non-host start blocked: "${badStart.error}"`);

    const all = [host, ...guests];
    const reveals = all.map((c) => c.once('race:start').then((m) => ({ board: m.board, at: Date.now(), endsAt: m.endsAt })));
    const countdownSeen = host.once('race:countdown');
    const t0 = Date.now();
    const startRes = await host.request('room:start');
    A(startRes && startRes.ok, 'host started the race');

    const cd = await countdownSeen;
    A(cd.startAt > Date.now(), 'countdown startAt in the future (board still hidden)');
    A(hostBoard === null, 'board NOT revealed during countdown');

    const revealed = await Promise.all(reveals);
    A(revealed.every((r) => r.board && r.board.paths.length > 0), 'all 4 players received the board at reveal');
    const b0 = JSON.stringify(revealed[0].board);
    A(revealed.every((r) => JSON.stringify(r.board) === b0), 'every player received the IDENTICAL board');
    A(revealed[0].endsAt && revealed[0].endsAt > Date.now(), 'race:start carries a future endsAt (timer)');
    A(revealed[0].at - t0 >= 1000, `reveal waited for the countdown (~${revealed[0].at - t0}ms)`);

    const p1 = await host.request('race:finished');     A(p1.placement === 1, `Alice → #${p1.placement}`);
    const p2 = await guests[0].request('race:finished'); A(p2.placement === 2, `Bob → #${p2.placement}`);
    const p3 = await guests[1].request('race:finished'); A(p3.placement === 3, `Cara → #${p3.placement}`);
    const p4 = await guests[2].request('race:finished'); A(p4.placement === 4, `Dan → #${p4.placement}`);

    await new Promise((r) => setTimeout(r, 300));
    A(finishResults && finishResults.length === 4, 'race:finished fired with 4 results (all finished)');
    if (finishResults) {
        console.log('   standings →', finishResults.map((r) => `${r.name}:#${r.placement}`).join('  '));
        A(finishResults.every((r) => r.solved === true), 'all marked solved');
    }

    all.forEach((c) => c.close());
    setTimeout(() => { console.log(`\n${pass ? '✅ ALL CHECKS PASSED (raw ws)' : '❌ FAILURES'}`); process.exit(pass ? 0 : 1); }, 300);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
