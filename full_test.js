const assert = require('assert').strict;

// -- MOCK SERVER STATE --
let onlineUsers = new Map();
let snakePlayers = {};
let snakeFood = [{ x: 200, y: 200 }];
let seaQueue = [];
let seaGames = {};

// Helper: simulate register
function register(userId, socketId) {
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socketId);
}

// Helper: simulate disconnect
function disconnect(userId, socketId) {
    if (onlineUsers.has(userId)) {
        onlineUsers.get(userId).delete(socketId);
        if (onlineUsers.get(userId).size === 0) onlineUsers.delete(userId);
    }
    // Snake cleanup
    if (snakePlayers[userId] && snakePlayers[userId].socketId === socketId) {
        delete snakePlayers[userId];
    }
}

// -- TEST 1: Online status persistence --
console.log('Running Test 1: Multi-tab Online Status...');
register('u1', 'sid1'); // Chat tab
assert.equal(onlineUsers.has('u1'), true);
register('u1', 'sid2'); // Game tab
assert.equal(onlineUsers.get('u1').size, 2);

disconnect('u1', 'sid1'); // Close chat tab
assert.equal(onlineUsers.has('u1'), true, 'User should still be online if one tab is left');
assert.equal(onlineUsers.get('u1').size, 1);

disconnect('u1', 'sid2'); // Close last tab
assert.equal(onlineUsers.has('u1'), false, 'User should be offline when all tabs closed');
console.log('✅ Passed');

// -- TEST 2: Snake Cleanup logic --
console.log('Running Test 2: Snake Tab Cleanup...');
snakePlayers['u1'] = { socketId: 'sid_snake' };
disconnect('u1', 'sid_chat');
assert.ok(snakePlayers['u1'], 'Snake player should NOT be removed if a different tab disconnected');

disconnect('u1', 'sid_snake');
assert.ok(!snakePlayers['u1'], 'Snake player SHOULD be removed if the game tab disconnected');
console.log('✅ Passed');

// -- TEST 3: Sea Battle Matchmaking and Turns --
console.log('Running Test 3: Sea Battle matchmaking...');
const p1 = { id: 'p1', socketId: 's1', username: 'Player 1' };
const p2 = { id: 'p2', socketId: 's2', username: 'Player 2' };

seaQueue.push(p1);
assert.equal(seaQueue.length, 1);
seaQueue.push(p2);
if (seaQueue.length >= 2) {
    const start1 = seaQueue.shift();
    const start2 = seaQueue.shift();
    const gid = 'g1';
    seaGames[gid] = {
        players: [start1, start2],
        turn: start1.id,
        ships: { 'p1': [0, 1], 'p2': [10, 11] },
        hits: { 'p1': [], 'p2': [] }
    };
}
assert.equal(Object.keys(seaGames).length, 1);
assert.equal(seaQueue.length, 0);

function shoot(gid, shooterId, index) {
    const g = seaGames[gid];
    if (g.turn !== shooterId) return 'not_your_turn';
    const opponentId = g.players.find(p => p.id !== shooterId).id;
    const isHit = g.ships[opponentId].includes(index);
    g.hits[shooterId].push(index);
    if (!isHit) g.turn = opponentId;
    return isHit ? 'hit' : 'miss';
}

assert.equal(shoot('g1', 'p1', 0), 'hit');
assert.equal(seaGames['g1'].turn, 'p1', 'Still p1 turn after hit');
assert.equal(shoot('g1', 'p1', 5), 'miss');
assert.equal(seaGames['g1'].turn, 'p2', 'Now p2 turn after miss');
console.log('✅ Passed');

console.log('\n--- ALL LOGIC TESTS PASSED ---');
