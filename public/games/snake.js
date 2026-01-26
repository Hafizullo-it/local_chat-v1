"use strict";

(function () {
    document.addEventListener('DOMContentLoaded', () => {
        const socket = (typeof io !== 'undefined') ? io() : null;
        if (!socket) return;

        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        const scoreEl = document.getElementById('my-score');
        const leaderboardEl = document.getElementById('leaderboard-list');
        const startOverlay = document.getElementById('start-overlay');
        const startBtn = document.getElementById('btn-start');

        if (!startBtn) return;

        const userStr = localStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : null;
        if (!user) {
            window.location.href = '/';
            return;
        }

        document.getElementById('player-name').textContent = user.username;

        const GRID_SIZE = 20;
        canvas.width = 600;
        canvas.height = 600;

        let gameState = { snakes: {}, food: [] };
        let myDirection = 'right';
        let isPlaying = false;

        const directions = {
            'ArrowUp': 'up', 'w': 'up', 'ArrowDown': 'down', 's': 'down',
            'ArrowLeft': 'left', 'a': 'left', 'ArrowRight': 'right', 'd': 'right'
        };

        document.addEventListener('keydown', (e) => {
            const newDir = directions[e.key];
            if (!newDir) return;
            const opposites = { 'up': 'down', 'down': 'up', 'left': 'right', 'right': 'left' };
            if (opposites[newDir] !== myDirection) {
                myDirection = newDir;
                if (isPlaying) socket.emit('snake-dir', newDir);
            }
        });

        startBtn.addEventListener('click', () => {
            startOverlay.style.display = 'none';
            isPlaying = true;
            socket.emit('snake-join', {
                id: user.id,
                username: user.username,
                avatar: user.avatar
            });
        });

        socket.on('snake-update', (state) => {
            gameState = state;
            render();
            updateLeaderboard();
        });

        socket.on('snake-dead', (sid) => {
            if (sid === socket.id) {
                isPlaying = false;
                document.querySelector('#start-overlay h2').textContent = 'ВЫ ПРОИГРАЛИ!';
                document.querySelector('#start-overlay p').textContent = 'Ваш результат: ' + (gameState.snakes[socket.id]?.score || 0);
                document.querySelector('#btn-start').textContent = 'ПОПРОБОВАТЬ СНОВА';
                startOverlay.style.display = 'flex';
            }
        });

        function updateLeaderboard() {
            const list = Object.values(gameState.snakes).sort((a, b) => b.score - a.score).slice(0, 5);
            leaderboardEl.innerHTML = list.map(s => `
                <div class="leaderboard-item ${s.socketId === socket.id ? 'text-blue-400 font-bold' : ''}">
                    <span class="truncate pr-2">${s.username}</span>
                    <span>${s.score}</span>
                </div>
            `).join('');

            if (gameState.snakes[socket.id]) {
                scoreEl.textContent = gameState.snakes[socket.id].score;
            }
        }

        function render() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Grid
            ctx.strokeStyle = '#1e304a';
            ctx.lineWidth = 0.5;
            for (let x = 0; x <= canvas.width; x += GRID_SIZE) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
            for (let y = 0; y <= canvas.height; y += GRID_SIZE) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }

            // Food
            gameState.food.forEach(f => {
                ctx.fillStyle = f.color || '#ef4444';
                ctx.beginPath();
                ctx.arc(f.x + GRID_SIZE / 2, f.y + GRID_SIZE / 2, GRID_SIZE / 3, 0, Math.PI * 2);
                ctx.fill();
            });

            // Snakes
            Object.values(gameState.snakes).forEach(snake => {
                snake.body.forEach((part, index) => {
                    const isHead = index === 0;
                    ctx.fillStyle = snake.color || '#3b82f6';
                    if (!isHead) ctx.globalAlpha = 0.6;

                    ctx.beginPath();
                    // Simplified rects for maximum compatibility
                    ctx.rect(part.x + 2, part.y + 2, GRID_SIZE - 4, GRID_SIZE - 4);
                    ctx.fill();
                    ctx.globalAlpha = 1.0;
                });
            });
        }
    });
})();
