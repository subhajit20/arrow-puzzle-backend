// =============================================================================
// roomCode.js — short, human-friendly room codes
//
// Uses an unambiguous alphabet (no I/O/0/1) so codes are easy to read aloud
// and type. Uniqueness against live rooms is enforced by the caller.
// =============================================================================

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(len = 6) {
    let s = '';
    for (let i = 0; i < len; i++) {
        s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return s;
}

module.exports = { generateCode };
