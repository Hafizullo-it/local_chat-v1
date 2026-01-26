const assert = require('assert').strict;

// Mocking some environment for logic check
const snakePlayers = {};
const seaQueue = [];
const seaGames = {};

function handleDisconnect(userId, socketId) {
    // Current buggy logic:
    // if (snakePlayers[userId]) delete snakePlayers[userId];

    // Fixed logic proposal:
    if (snakePlayers[userId] && snakePlayers[userId].socketId === socketId) {
        delete snakePlayers[userId];
    }
}

// Test Case 1: Multi-tab disconnect
snakePlayers['user1'] = { id: 'user1', socketId: 'socket_snake' };
console.log('Test 1: Multi-tab disconnect protection');
// User closes chat tab (socket_chat), not snake tab
handleDisconnect('user1', 'socket_chat');
assert.ok(snakePlayers['user1'], 'Player should still be in snakePlayers if a different tab disconnected');
console.log('✅ Passed: Multi-tab protection working');

// User closes snake tab (socket_snake)
handleDisconnect('user1', 'socket_snake');
assert.ok(!snakePlayers['user1'], 'Player should be removed if the snake socket disconnected');
console.log('✅ Passed: Correct cleanup working');

// Test Case 2: Sea Battle Turn Logic
const game = {
    turn: 'p1',
    players: [{ id: 'p1' }, { id: 'p2' }]
};
function processShot(shooterId, isHit) {
    if (game.turn !== shooterId) return false;
    if (!isHit) {
        game.turn = game.players.find(p => p.id !== shooterId).id;
    }
    return true;
}

console.log('Test 2: Sea Battle turn sequence');
processShot('p1', true);
assert.equal(game.turn, 'p1', 'Should still be p1 turn after hit');
processShot('p1', false);
assert.equal(game.turn, 'p2', 'Should be p2 turn after miss');
console.log('✅ Passed: Turn logic working');
