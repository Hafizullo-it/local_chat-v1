"use strict";

(function () {
    document.addEventListener('DOMContentLoaded', () => {
        const socket = (typeof io !== 'undefined') ? io() : null;
        if (!socket) return;

        const userStr = localStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : null;
        if (!user) {
            window.location.href = '/';
            return;
        }

        const myBoardEl = document.getElementById('my-board');
        const enemyBoardEl = document.getElementById('enemy-board');
        const gameInfo = document.getElementById('game-info');
        const turnDisplay = document.getElementById('turn-display');
        const matchOverlay = document.getElementById('match-overlay');
        const findMatchBtn = document.getElementById('btn-find-match');


        let gameId = null;
        let isMyTurn = false;
        let myShips = [];

        function initBoards() {
            myBoardEl.innerHTML = '';
            enemyBoardEl.innerHTML = '';
            for (let i = 0; i < 100; i++) {
                const m = document.createElement('div');
                m.className = 'cell';
                m.dataset.index = i;
                myBoardEl.appendChild(m);

                const e = document.createElement('div');
                e.className = 'cell';
                e.dataset.index = i;
                e.addEventListener('click', () => makeShot(i));
                enemyBoardEl.appendChild(e);
            }
        }

        function renderShips() {
            const cells = myBoardEl.querySelectorAll('.cell');
            myShips.forEach(idx => {
                const p = document.createElement('div');
                p.className = 'ship-part';
                cells[idx].appendChild(p);
            });
        }

        function makeShot(index) {
            if (!isMyTurn || !gameId) return;
            const cell = enemyBoardEl.children[index];
            if (cell.classList.contains('hit') || cell.classList.contains('miss')) return;
            socket.emit('sea-shot', { gameId, index });
        }

        findMatchBtn.addEventListener('click', () => {
            console.log("Matchmaking search started...");
            findMatchBtn.disabled = true;
            findMatchBtn.textContent = 'ПОИСК...';
            socket.emit('sea-find-match', { id: user.id, username: user.username });
        });

        socket.on('sea-start', (data) => {
            console.log("SeaBattle Engine: START", data);
            matchOverlay.style.display = 'none';
            gameId = data.gameId;
            const opp = data.players.find(p => p.socketId !== socket.id);
            gameInfo.innerHTML = `ВРАГ: <span class="text-blue-400 font-bold">${opp.username}</span>`;
            isMyTurn = (data.startingPlayer === socket.id);
            updateTurnUI();
            initBoards();
            myShips = data.myShips;
            renderShips();
        });

        socket.on('sea-shot-result', (data) => {
            const isEnemyShooting = data.shooterId !== socket.id;
            const board = isEnemyShooting ? myBoardEl : enemyBoardEl;
            const cell = board.children[data.index];
            if (!cell) return;

            if (data.isHit) {
                cell.classList.add('hit');
            } else {
                cell.classList.add('miss');
                isMyTurn = !isMyTurn;
                updateTurnUI();
            }
        });

        socket.on('sea-win', (sid) => {
            const isWin = sid === socket.id;
            gameInfo.innerHTML = isWin ?
                '<span class="text-green-400 font-black">БЛЕСТЯЩАЯ ПОБЕДА!</span>' :
                '<span class="text-red-400 font-black">ВАШ ФЛОТ ПОТОПЛЕН...</span>';
            setTimeout(() => location.reload(), 5000);
        });

        socket.on('sea-opponent-disconnected', () => {
            gameInfo.innerHTML = '<span class="text-yellow-400 font-bold">ВРАГ БЕЖАЛ! ПОБЕДА.</span>';
            setTimeout(() => location.reload(), 3000);
        });

        function updateTurnUI() {
            turnDisplay.classList.remove('hidden');
            if (isMyTurn) {
                turnDisplay.textContent = 'ВАШ ХОД';
                turnDisplay.className = 'turn-indicator my-turn font-bold';
            } else {
                turnDisplay.textContent = 'ХОД ВРАГА';
                turnDisplay.className = 'turn-indicator enemy-turn font-bold';
            }
        }
    });
})();
