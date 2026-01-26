let socket = null;
if (typeof io !== 'undefined') {
    socket = io({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });
} else {
    console.error('Socket.IO library not loaded!');
}

let user = null;
try {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
        user = JSON.parse(storedUser);
        // Basic validation: ensure it's an object and has an id
        if (!user || typeof user !== 'object' || !user.id) {
            user = null;
        }
    }
} catch (e) {
    console.error('Error parsing user from localStorage:', e);
    user = null;
}

let activeId = null,
    allUsers = [],
    onlineUsers = [],
    unread = {},
    selectedMsg = null,
    currentReply = null,
    msgs = [],
    selectedUser = null,
    selectedUserElement = null;

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const chatLayout = document.getElementById('chat-layout');
const chatScreen = document.getElementById('chat-screen');

// Auth State
let currentAuthMode = 'login'; // 'login' or 'register'

function switchAuthTab(mode) {
    currentAuthMode = mode;
    const loginTab = document.getElementById('tab-login');
    const registerTab = document.getElementById('tab-register');
    const submitBtn = document.getElementById('auth-submit-btn');
    const errorMsg = document.getElementById('auth-error');

    errorMsg.classList.add('hidden'); // Hide errors on switch

    if (mode === 'login') {
        loginTab.classList.remove('text-gray-400', 'hover:text-white');
        loginTab.classList.add('text-white', 'bg-blue-600', 'shadow-md');

        registerTab.classList.remove('text-white', 'bg-blue-600', 'shadow-md');
        registerTab.classList.add('text-gray-400', 'hover:text-white');

        submitBtn.textContent = 'Войти в чат';
    } else {
        registerTab.classList.remove('text-gray-400', 'hover:text-white');
        registerTab.classList.add('text-white', 'bg-blue-600', 'shadow-md');

        loginTab.classList.remove('text-white', 'bg-blue-600', 'shadow-md');
        loginTab.classList.add('text-gray-400', 'hover:text-white');

        submitBtn.textContent = 'Зарегистрироваться';
    }
}

// XSS защита - экранирование HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Toast уведомления вместо alert
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    const colors = {
        success: 'bg-green-600',
        error: 'bg-red-600',
        warning: 'bg-yellow-600',
        info: 'bg-blue-600',
        'admin-alert': 'bg-red-800 border-2 border-yellow-500 shadow-[0_0_20px_rgba(220,38,38,0.5)]'
    };
    toast.className = `fixed top-4 right-4 ${colors[type] || colors.info} text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function fixPath(p) {
    return p ? p : '/img/default-avatar.png';
}

// Safety Timeout: Hide loading screen after 5 seconds NO MATTER WHAT
const safetyTimeout = setTimeout(() => {
    console.warn('Safety timeout reached! Forcing loader hide.');
    hideLoading();
}, 5000);

function hideLoading() {
    console.log('hideLoading: removing overlay');
    const loader = document.getElementById('loading-screen');
    if (loader) {
        loader.style.opacity = '0';
        loader.style.pointerEvents = 'none';
        setTimeout(() => {
            loader.style.display = 'none';
            loader.classList.add('hidden');
            // Clean up safety timeout
            clearTimeout(safetyTimeout);
        }, 500);
    }
}

async function initApp() {
    console.log('initApp: Starting initialization...');

    if (!user || !user.id) {
        console.log('initApp: No valid user, showing login screen.');
        // Показываем экран входа, скрываем чат
        if (loginScreen) loginScreen.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('hidden');
        if (chatScreen) chatScreen.classList.add('hidden');
        hideLoading();
        return;
    }

    try {
        console.log('initApp: User found, setting up chat...');
        // Скрываем экран входа, показываем чат
        if (loginScreen) loginScreen.classList.add('hidden');
        if (chatLayout) chatLayout.classList.remove('hidden');
        if (chatScreen) chatScreen.classList.remove('hidden');

        document.getElementById('my-ava').src = fixPath(user.avatar);
        document.getElementById('my-name').innerText = user.username;

        // Show admin panel button if user is admin
        if (user && (user.role === 'admin' || user.username === 'admin')) {
            const adminBtn = document.getElementById('admin-panel-btn');
            if (adminBtn) adminBtn.classList.remove('hidden');
        }

        try {
            await loadUsers();
        } catch (e) {
            console.error('Failed to load users:', e);
        }

        // Подключаемся к сокету только если пользователь авторизован
        if (socket) {
            try {
                if (socket.connected) {
                    socket.emit('register-online', user.id);
                } else {
                    socket.on('connect', () => {
                        socket.emit('register-online', user.id);
                    });
                }
            } catch (e) {
                console.error('Socket registration error:', e);
            }
        } else {
            console.warn('Socket not initialized, offline mode?');
        }

        try {
            setupSocketListeners();
        } catch (e) {
            console.error('Failed to setup socket listeners:', e);
        }

        try {
            openGlobal();
        } catch (e) {
            console.error('Failed to open global chat:', e);
        }
    } catch (err) {
        console.error('Error during initApp:', err);
        showToast('Ошибка при загрузке данных чата', 'error');
    } finally {
        hideLoading();
    }
}

async function handleAuth() {
    const usernameInput = document.getElementById('auth-username');
    const passwordInput = document.getElementById('auth-password');
    const errorMsg = document.getElementById('auth-error');

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        errorMsg.textContent = 'Введите имя пользователя и пароль';
        errorMsg.classList.remove('hidden');
        return;
    }

    const apiUrl = currentAuthMode === 'login' ? '/api/login' : '/api/register';

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (data.success) {
            user = data.user;
            localStorage.setItem('user', JSON.stringify(user));
            errorMsg.classList.add('hidden');
            initApp();
            showToast(currentAuthMode === 'login' ? 'С возвращением!' : 'Регистрация успешна!', 'success');
        } else {
            errorMsg.textContent = data.error || 'Ошибка авторизации';
            errorMsg.classList.remove('hidden');
        }
    } catch (err) {
        console.error(err);
        errorMsg.textContent = 'Ошибка соединения с сервером';
        errorMsg.classList.remove('hidden');
    }
}

function logout() {
    localStorage.removeItem('user');
    user = null;
    if (socket && typeof socket.disconnect === 'function') {
        socket.disconnect();
    }
    window.location.href = '/';
}

// Users & Sidebar
async function loadUsers() {
    if (!user) return; // Не загружать если нет юзера
    const res = await fetch('/api/users');
    allUsers = await res.json();
    renderSidebar();
    renderRightPanel();
}

// Debouncing для renderSidebar
let renderSidebarTimeout = null;

// Оптимизированный renderSidebar (Flicker Fix)
function renderSidebar() {
    if (renderSidebarTimeout) clearTimeout(renderSidebarTimeout);

    renderSidebarTimeout = setTimeout(() => {
        const cont = document.getElementById('user-list');
        const searchTerm = document.getElementById('user-search') ? document.getElementById('user-search').value.toLowerCase() : '';

        // Используем Fragment
        const fragment = document.createDocumentFragment();

        allUsers.forEach(u => {
            if (u._id === user.id) return;
            if (searchTerm && !u.username.toLowerCase().includes(searchTerm)) return; // Filter

            const isOnline = onlineUsers.includes(u._id);
            const isBanned = u.banned;
            const isActive = activeId === u._id;

            const div = document.createElement('div');
            // ID для обновлений
            div.id = `user-item-${u._id}`;
            div.className = `user-item group p-3 cursor-pointer flex items-center gap-3 rounded-xl mx-2 my-1 relative transition-colors duration-200 hover:bg-gray-700 ${isActive ? 'active-chat bg-blue-600 bg-opacity-20 border-l-4 border-blue-500 !important' : ''}`;
            div.setAttribute('data-user-id', u._id);

            if (isBanned) {
                div.innerHTML = `
                <div class="relative">
                    <img src="${fixPath(u.avatar)}" class="w-12 h-12 rounded-full object-cover opacity-50">
                    <div class="w-3 h-3 bg-red-500 rounded-full absolute bottom-0 right-0 border-2 border-gray-800"></div>
                </div>
                <div class="flex-grow min-w-0">
                    <div class="font-semibold text-gray-500 italic truncate">Забанен</div>
                    <div class="text-xs text-gray-600 truncate">Аккаунт заблокирован</div>
                </div>`;
                div.onclick = null;
                div.style.cursor = 'not-allowed';
            } else {
                div.innerHTML = `
                <div class="relative">
                    <img src="${fixPath(u.avatar)}" class="w-12 h-12 rounded-full object-cover border-2 ${isActive ? 'border-blue-400' : 'border-transparent'} group-hover:border-gray-500 transition-all duration-200">
                    <div class="status-indicator w-3 h-3 rounded-full absolute bottom-0 right-0 border-2 border-gray-800 ${isOnline ? 'bg-green-500 scale-110 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-gray-500'} transition-all duration-300"></div>
                </div>
                <div class="flex-grow min-w-0">
                    <div class="flex justify-between items-center">
                        <b class="text-gray-100 group-hover:text-white truncate ${isActive ? 'text-blue-200' : ''}">${u.username}</b>
                        <div class="unread-counter bg-blue-500 text-white text-xs font-bold w-5 h-5 flex items-center justify-center rounded-full shadow-lg ${unread[u._id] ? 'flex' : 'hidden'}">${unread[u._id] || ''}</div>
                    </div>
                </div>
                <button class="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-white transition-all duration-200 p-1" onclick="showUserContextMenu(event, '${u._id}', '${u.username}', '${u.role}')" title="Меню">
                    <i class="fas fa-ellipsis-v"></i>
                </button>`;

                div.onclick = () => {
                    if (activeId !== u._id) {
                        activeId = u._id;
                        unread[u._id] = 0;
                        document.getElementById('chat-with').innerText = u.username;

                        const avaImg = document.getElementById('chat-avatar');
                        const newSrc = fixPath(u.avatar);
                        // Fix flicker: не обновлять, если тот же source
                        if (!avaImg.src.endsWith(newSrc)) {
                            avaImg.src = newSrc;
                        }
                        avaImg.classList.remove('hidden');

                        document.getElementById('pinned-message').classList.add('hidden');
                        // Скрываем правую панель (ширина 0)
                        document.getElementById('right-panel').classList.remove('w-72');
                        document.getElementById('right-panel').classList.add('w-0');
                        document.getElementById('right-panel').classList.remove('p-4'); // убираем паддинг чтобы полностью скрылась
                        document.getElementById('right-panel').classList.add('p-0');

                        document.getElementById('members-list').innerHTML = '';
                        document.getElementById('members-count').innerText = '0';
                        loadMsgs();
                        renderSidebar();
                    }
                };
            }

            // Context Menu
            div.oncontextmenu = (e) => {
                e.preventDefault();
                selectedUser = u;
                selectedUserElement = div;
                if (typeof updateUserContextMenu === 'function') updateUserContextMenu(e);
            };

            fragment.appendChild(div);
        });

        cont.innerHTML = '';
        cont.appendChild(fragment);
    }, 50);
}

function renderRightPanel() {
    const list = document.getElementById('members-list');
    list.innerHTML = '';
    document.getElementById('members-count').innerText = onlineUsers.length;
    allUsers.forEach(u => {
        const isOnline = onlineUsers.includes(u._id);
        if (!isOnline) return; // Показывать только онлайн пользователей

        const div = document.createElement('div');
        div.className = 'flex items-center gap-3 mb-3 text-gray-200';
        div.innerHTML = `
            <img src="${fixPath(u.avatar)}" class="w-8 h-8 rounded-full object-cover">
            <span>${u.username}</span>
        `;
        list.appendChild(div);
    });
}

// Messages
async function loadMsgs() {
    if (!activeId) {
        console.log('loadMsgs: activeId is null, returning.'); // Лог
        return;
    }
    console.log('loadMsgs: Fetching messages for activeId:', activeId); // Лог
    const res = await fetch(`/api/messages/${user.id}/${activeId}`);
    msgs = await res.json(); // Обновляем глобальный массив msgs
    const cont = document.getElementById('messages');
    cont.innerHTML = '';
    msgs.forEach(renderMsg);
    cont.scrollTop = cont.scrollHeight; // Прокрутка вниз после загрузки
}

function renderMsg(m) {
    const isMe = m.senderId === user.id;
    const msgWrapper = document.createElement('div'); // Общий контейнер для выравнивания
    msgWrapper.className = `flex items-start gap-2 ${isMe ? 'justify-end' : 'justify-start'}`; // Выравнивание

    // Добавляем аватарку, если это не мое сообщение
    if (!isMe) {
        msgWrapper.innerHTML += `<img src="${fixPath(m.senderAva)}" class="w-8 h-8 rounded-full object-cover" title="${m.senderName}">`;
    }

    const messageContent = document.createElement('div'); // Контейнер для сообщения
    messageContent.className = `msg max-w-[75%] p-3 rounded-2xl text-sm relative shadow-md message-fade-in ${isMe ? 'bg-blue-600 text-white rounded-br-md' : 'bg-gray-700 text-gray-100 rounded-bl-md'}`;
    messageContent.dataset.msgId = m._id;

    let textHTML = (m.text || '').replace(/@(\w+)/g, '<span class="mention-link">@$1</span>');

    let replyHTML = '';
    if (m.replyTo) {
        replyHTML = `
            <div class="reply-box p-2 mb-2 bg-gray-600 bg-opacity-70 rounded-lg border-l-4 border-blue-400 text-xs">
                <div class="font-bold text-blue-300">Ответ на: ${m.replyTo.senderName || 'Неизвестный'}</div>
                <div class="text-gray-200 truncate">${m.replyTo.content || ''}</div>
            </div>
        `;
    }

    let fileHTML = '';
    if (m.file && m.file.path) {
        const fileExtension = m.file.path.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension)) {
            fileHTML = `<img src="${m.file.path}" class="max-w-full rounded-lg mt-2 cursor-pointer" onclick="window.open('${m.file.path}')">`;
        } else {
            fileHTML = `<a href="${m.file.path}" target="_blank" class="text-blue-300 underline mt-2 flex items-center gap-1"><i class="fas fa-file"></i> ${m.file.fileName || 'Файл'}</a>`;
        }
    } else if (m.file) {
        fileHTML = `<div class="text-xs text-red-400 mt-1 italic">[Файл поврежден (нет пути)]</div>`;
    }

    messageContent.innerHTML = `
        ${(activeId === 'GLOBAL' && !isMe) ? `<div class="font-bold text-sm mb-1">${m.senderName}</div>` : ''}
        ${replyHTML}
        ${m.text ? `<div class="whitespace-pre-wrap break-words">${textHTML}</div>` : ''}
        ${fileHTML}
        <div class="message-info text-right text-gray-400 text-xs mt-1">
            ${m.edited ? `<span class="text-xs text-gray-500 mr-1">изм.</span>` : ''}
            <span>${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            ${isMe ? `<i class="fas ${m.status === 'read' ? 'fa-check-double text-blue-500' : 'fa-check'}"></i>` : ''}
        </div>
    `;

    messageContent.oncontextmenu = (e) => {
        e.preventDefault();
        console.log('Right click on message', m._id);
        selectedMsg = m;
        updateContextMenu();
        const menu = document.getElementById('context-menu');
        // Use clientX/Y for fixed positioning
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.classList.remove('hidden');
    };

    msgWrapper.appendChild(messageContent); // Добавляем контент сообщения в обертку
    document.getElementById('messages').appendChild(msgWrapper); // Добавляем обертку в контейнер сообщений
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;

    if (!isMe && m.status !== 'read') {
        if (socket) {
            socket.emit('message-read', { msgId: m._id, readerId: user.id });
        }
    }
}

function sendMessage() {
    const inp = document.getElementById('msgInput');
    const text = inp.value.trim(); // preserve value first
    console.log('sendMessage called. Value:', text, 'ActiveID:', activeId); // Log input

    if (!text && !currentReply) {
        console.log('sendMessage blocked: empty text and no reply');
        return;
    }

    try {
        if (socket) {
            socket.emit('private-message', {
                senderId: user.id,
                receiverId: activeId,
                text: text, // use variable
                senderName: user.username,
                senderAva: user.avatar,
                replyTo: currentReply ? {
                    _id: currentReply._id,
                    senderName: currentReply.senderName,
                    content: currentReply.text || (currentReply.file ? currentReply.file.fileName : 'Файл')
                } : null
            });
        }
        console.log('socket emit success');
        inp.value = '';
        cancelReply();
    } catch (e) {
        console.error('sendMessage error:', e);
        showToast('Ошибка отправки сообщения: ' + e.message, 'error');
    }
}

// Emoji & Files
function toggleEmoji(event) { // Принимаем событие
    const p = document.getElementById('emoji-picker');
    p.classList.toggle('hidden');
    if (event) {
        event.stopPropagation(); // Останавливаем распространение события
    }
}
const emojis = ['😊', '😂', '❤️', '😍', '👍', '🔥', '🎉', '😎', '😭', '🤔', '😱', '😴', '👋', '🥳', '🤩', '👍', '🙏', '💯', '👏', '🚀', '🌈', '💡', '🎤', '🎧', '🎸', '🎹', '🥁', '🎷', '🎺', '🎻', '🎨', '🎬', '🎭', '📚', '🖊️', '🗒️', '📅', '⏰', '⏳', '💡', '💬', '💭', '🧡', '💜', '🤎', '🖤', '🤍', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎'];
emojis.forEach(e => {
    const d = document.createElement('div');
    d.className = 'emoji-item';
    d.innerText = e;
    d.onclick = () => {
        document.getElementById('msgInput').value += e;
        toggleEmoji();
        document.getElementById('msgInput').focus(); // Возвращаем фокус на поле ввода
    };
    document.getElementById('emoji-picker').appendChild(d);
});

async function uploadFile(input) {
    const fd = new FormData();
    fd.append('chatFile', input.files[0]);
    const res = await fetch('/api/upload', {
        method: 'POST',
        body: fd
    });
    const f = await res.json();

    if (!res.ok) {
        showToast(f.error || 'Ошибка загрузки файла', 'error');
        return;
    }

    if (socket) {
        socket.emit('private-message', {
            senderId: user.id,
            receiverId: activeId,
            senderName: user.username,
            text: '', // Fix crash
            file: {
                path: f.filePath,
                fileName: f.fileName,
                fileType: f.fileType
            }
        });
    }
    input.value = null; // Сброс выбранного файла
}

// Socket events

function setupSocketListeners() {
    if (!socket || !user) return;

    // Remove existing to avoid duplicates if re-initialized
    socket.off('update-online-list');
    socket.off('new-private-message');
    socket.off('notification');
    socket.off('message-edited');
    socket.off('message-deleted');
    socket.off('message-status-updated');
    socket.off('user-typing');
    socket.off('stop-typing');
    socket.off('user-banned');
    socket.off('user-unbanned');
    socket.off('user-deleted');

    socket.on('update-online-list', ids => {
        const currentOnline = onlineUsers.slice().sort();
        const newOnline = ids.slice().sort();
        if (JSON.stringify(currentOnline) !== JSON.stringify(newOnline)) {
            onlineUsers = ids;
            updateOnlineStatuses();
            updateRightPanel();
        }
    });

    socket.on('new-private-message', m => {
        const userIdToMove = m.senderId === user.id ? m.receiverId : m.senderId;
        if (userIdToMove && userIdToMove !== 'GLOBAL') {
            const userIndex = allUsers.findIndex(u => u._id === userIdToMove);
            if (userIndex > -1) {
                const [movedUser] = allUsers.splice(userIndex, 1);
                allUsers.unshift(movedUser);
                renderSidebar();
            }
        }
        if (m.receiverId === activeId || m.senderId === activeId || (m.receiverId === 'GLOBAL' && activeId === 'GLOBAL')) {
            renderMsg(m);
        } else {
            unread[m.senderId] = (unread[m.senderId] || 0) + 1;
            updateUnreadCounter(m.senderId);
        }
    });

    socket.on('notification', ({ type, message }) => {
        showToast(message, type === 'mention' ? 'info' : type);
    });

    socket.on('message-edited', ({ msgId, newContent }) => {
        const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgElement) {
            const contentDiv = msgElement.querySelector('div.whitespace-pre-wrap');
            if (contentDiv) {
                contentDiv.innerHTML = newContent;
                if (!msgElement.querySelector('.message-info .text-xs')) {
                    const infoSpan = msgElement.querySelector('.message-info');
                    if (infoSpan) infoSpan.insertAdjacentHTML('afterbegin', '<span class="text-xs text-gray-500 mr-1">изм.</span>');
                }
            }
        }
    });

    socket.on('message-deleted', (msgId) => {
        const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgElement) msgElement.remove();
    });

    socket.on('message-status-updated', ({ msgId, status }) => {
        const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgElement && status === 'read') {
            const checkIcon = msgElement.querySelector('.message-info .fas.fa-check');
            if (checkIcon) {
                checkIcon.classList.remove('fa-check', 'text-gray-400');
                checkIcon.classList.add('fa-check-double', 'text-blue-500');
            }
        }
    });

    socket.on('user-typing', ({ senderId, receiverId }) => {
        const listTyping = document.getElementById(`typing-list-${senderId}`);
        const listLastMsg = document.getElementById(`last-msg-${senderId}`);
        if (listTyping && listLastMsg) {
            listTyping.classList.remove('hidden');
            listLastMsg.classList.add('hidden');
            setTimeout(() => {
                listTyping.classList.add('hidden');
                listLastMsg.classList.remove('hidden');
            }, 3000);
        }
        if (activeId === senderId || (activeId === 'GLOBAL' && receiverId === 'GLOBAL')) {
            const typingIndicator = document.getElementById('typing-indicator');
            if (typingIndicator) typingIndicator.classList.remove('hidden');
            const mDiv = document.getElementById('messages');
            if (mDiv && mDiv.scrollHeight - mDiv.scrollTop === mDiv.clientHeight) {
                mDiv.scrollTop = mDiv.scrollHeight;
            }
        }
    });

    socket.on('stop-typing', ({ senderId, receiverId }) => {
        const listTyping = document.getElementById(`typing-list-${senderId}`);
        const listLastMsg = document.getElementById(`last-msg-${senderId}`);
        if (listTyping && listLastMsg) {
            listTyping.classList.add('hidden');
            listLastMsg.classList.remove('hidden');
        }
        if (activeId === senderId || (activeId === 'GLOBAL' && receiverId === 'GLOBAL')) {
            const typingIndicator = document.getElementById('typing-indicator');
            if (typingIndicator) typingIndicator.classList.add('hidden');
        }
    });

    socket.on("user-banned", (userId) => {
        if (userId === user.id) {
            alert("Вы были забанены администратором.");
            logout();
        } else {
            updateUserStatus(userId, 'banned');
        }
    });

    socket.on("user-unbanned", (userId) => {
        updateUserStatus(userId, 'unbanned');
    });

    socket.on("user-deleted", (userId) => {
        allUsers = allUsers.filter(u => u._id !== userId);
        onlineUsers = onlineUsers.filter(id => id !== userId);
        renderSidebar();
        if (activeId === userId) {
            activeId = null;
            openGlobal();
        }
    });
}

// Utils
function openGlobal() {
    activeId = 'GLOBAL';
    console.log('openGlobal: activeId set to', activeId);
    document.getElementById('chat-with').innerText = 'Общий чат';
    document.getElementById('chat-avatar').classList.add('hidden');
    document.getElementById('pinned-message').classList.remove('hidden');

    // Показываем правую панель (ширина 72)
    const rp = document.getElementById('right-panel');
    rp.classList.remove('hidden'); // на всякий случай
    rp.classList.remove('w-0', 'p-0');
    rp.classList.add('w-72');

    loadMsgs();
    renderSidebar();
    renderRightPanel();
}

// toggleRightPanel (first definition removed)

// Context Menu Utils
function isAdmin() {
    return user && user.role === 'admin';
}

function updateContextMenu() {
    if (!selectedMsg || !user) {
        console.warn('updateContextMenu: selectedMsg or user is missing');
        return;
    }

    const isMe = selectedMsg.senderId === user.id;
    const admin = isAdmin();
    console.log(`ContextMenu for msg: ${selectedMsg._id}, isMe: ${isMe}, isAdmin: ${admin}`);

    const editBtn = document.getElementById('ctx-edit');
    const delBtn = document.getElementById('ctx-delete');
    const replyBtn = document.getElementById('ctx-reply');

    if (replyBtn) {
        replyBtn.style.display = 'flex';
        console.log('Reply button -> flex');
    }

    if (isMe || admin) {
        if (editBtn) {
            editBtn.style.display = 'flex';
            console.log('Edit button -> flex');
        }
        if (delBtn) {
            delBtn.style.display = 'flex';
            console.log('Delete button -> flex');
        }
    } else {
        if (editBtn) {
            editBtn.style.display = 'none';
            console.log('Edit button -> none');
        }
        if (delBtn) {
            delBtn.style.display = 'none';
            console.log('Delete button -> none');
        }
    }
}

function handleReply() {
    currentReply = selectedMsg;
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('reply-original-sender').innerText = `Ответ на: ${selectedMsg.senderName}`;
    document.getElementById('reply-original-content').innerText = selectedMsg.text || (selectedMsg.file ? selectedMsg.file.fileName : 'Файл');
}

function handleEdit() {
    if (!isAdmin() && selectedMsg.senderId !== user.id) {
        alert("Вы можете редактировать только свои сообщения.");
        return;
    }
    document.getElementById('edit-message-modal').classList.remove('hidden');
    document.getElementById('edit-msg-input').value = selectedMsg.text || '';
}

function closeEditMessageModal() {
    document.getElementById('edit-message-modal').classList.add('hidden');
    document.getElementById('edit-msg-input').value = '';
}

function saveEditedMessage() {
    const newContent = document.getElementById('edit-msg-input').value;
    if (!newContent.trim()) return;

    socket.emit('edit-message', {
        msgId: selectedMsg._id,
        userId: user.id,
        newContent
    });
    closeEditMessageModal();
}

function handleDelete() {
    if (!isAdmin() && selectedMsg.senderId !== user.id) {
        alert("Вы можете удалять только свои сообщения.");
        return;
    }
    if (confirm("Удалить это сообщение?")) {
        socket.emit('delete-message', {
            msgId: selectedMsg._id,
            userId: user.id
        });
    }
}

function cancelReply() {
    currentReply = null;
    document.getElementById('reply-preview').classList.add('hidden');
}

// Redundant logout removed

function openPrivate(name) {
    const t = allUsers.find(u => u.username === name);
    if (t) {
        activeId = t._id;
        console.log('openPrivate: activeId set to', activeId, 'for user', name); // Лог
        document.getElementById('chat-with').innerText = t.username;
        document.getElementById('chat-avatar').src = fixPath(t.avatar);
        document.getElementById('chat-avatar').classList.remove('hidden');
        document.getElementById('pinned-message').classList.add('hidden');
        // document.getElementById('right-panel').classList.add('hidden'); // Убрал это
        document.getElementById('right-panel').classList.remove('hidden'); // Теперь она всегда видима
        document.getElementById('members-list').innerHTML = ''; // Очищаем список участников
        document.getElementById('members-count').innerText = '0'; // Сбрасываем счетчик
        loadMsgs();
        renderSidebar();
    }
}

function toggleRightPanel() {
    const panel = document.getElementById('right-panel');
    // Если есть класс translate-x-full, значит панель скрыта -> показываем (убираем класс)
    // Если нет, значит показана -> скрываем (добавляем класс)
    if (panel.classList.contains('translate-x-full') || panel.classList.contains('lg:translate-x-full')) {
        panel.classList.remove('translate-x-full', 'lg:translate-x-full');
    } else {
        panel.classList.add('translate-x-full');
    }
}

function openProfileSettings() {
    document.getElementById('profile-settings-modal').classList.remove('hidden');
    document.getElementById('profile-username').value = user.username;
    // Добавьте логику для отображения текущего аватара, если это необходимо
}

function closeProfileSettings() {
    document.getElementById('profile-settings-modal').classList.add('hidden');
}

async function saveProfileSettings() {
    const newUsername = document.getElementById('profile-username').value;
    const oldPassword = document.getElementById('profile-old-password').value;
    const newPassword = document.getElementById('profile-new-password').value;
    const avatarFile = document.getElementById('profile-avatar').files[0];

    if (newUsername !== user.username) {
        const res = await fetch('/api/profile/username', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userId: user.id,
                newUsername
            })
        });
        const data = await res.json();
        if (data.success) {
            user.username = newUsername;
            localStorage.setItem('user', JSON.stringify(user));
            document.getElementById('my-name').innerText = newUsername;
            loadUsers();
        } else {
            alert(data.error);
        }
    }

    if (oldPassword && newPassword) {
        const res = await fetch('/api/profile/password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                userId: user.id,
                oldPassword,
                newPassword
            })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            document.getElementById('profile-old-password').value = '';
            document.getElementById('profile-new-password').value = '';
        } else {
            alert(data.error);
        }
    }

    if (avatarFile) {
        const fd = new FormData();
        fd.append('avatar', avatarFile);
        fd.append('userId', user.id);
        const res = await fetch('/api/profile/avatar', {
            method: 'POST',
            body: fd
        });
        const data = await res.json();
        if (data.success) {
            user.avatar = data.avatar;
            localStorage.setItem('user', JSON.stringify(user));
            document.getElementById('my-ava').src = fixPath(data.avatar);
            alert(data.message);
        } else {
            alert(data.error);
        }
    }

    closeProfileSettings();
}

// Контекстное меню пользователя в сайдбаре
let userContextMenuTargetUser = null; // Для хранения пользователя, на котором был правый клик
function updateUserContextMenu(e) {
    const menu = document.getElementById('user-context-menu');
    menu.innerHTML = ''; // Очищаем меню

    if (isAdmin() && userContextMenuTargetUser && userContextMenuTargetUser._id !== user.id) { // Если админ и не сам админ
        // Кнопка бана
        const banBtn = document.createElement('button');
        banBtn.className = 'flex items-center gap-2 p-2 text-sm text-red-400 hover:bg-gray-700 rounded-md cursor-pointer';
        banBtn.onclick = () => { handleBanFromUserMenu(); menu.classList.add('hidden'); };
        banBtn.innerHTML = '<i class="fas fa-user-slash text-red-500"></i><span>Забанить</span>';
        menu.appendChild(banBtn);

        // Кнопка редактирования пользователя
        const editUserBtn = document.createElement('button');
        editUserBtn.className = 'flex items-center gap-2 p-2 text-sm text-yellow-400 hover:bg-gray-700 rounded-md cursor-pointer';
        editUserBtn.onclick = () => { handleEditUser(); menu.classList.add('hidden'); };
        editUserBtn.innerHTML = '<i class="fas fa-user-edit text-yellow-500"></i><span>Редактировать</span>';
        menu.appendChild(editUserBtn);
    }

    if (menu.children.length > 0) { // Показываем меню только если есть элементы
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.classList.remove('hidden');
    } else {
        menu.classList.add('hidden');
    }
}

function handleBan(userIdToBan) {
    if (confirm("Вы уверены, что хотите забанить этого пользователя?")) {
        socket.emit('ban-user', {
            adminId: user.id,
            userIdToBan
        });
        alert("Пользователь забанен (если был онлайн).");
    }
}

function handleBanFromUserMenu() {
    if (userContextMenuTargetUser) {
        handleBan(userContextMenuTargetUser._id);
    }
}

function handleEditUser() {
    if (userContextMenuTargetUser) {
        document.getElementById('edit-user-modal').classList.remove('hidden');
        document.getElementById('edit-user-username').value = userContextMenuTargetUser.username;
        document.getElementById('edit-user-role').value = userContextMenuTargetUser.role || 'user';
        // Здесь можно добавить логику для отображения текущего аватара пользователя
    }
}

function closeEditUserModal() {
    document.getElementById('edit-user-modal').classList.add('hidden');
    // Сброс полей формы
    document.getElementById('edit-user-username').value = '';
    document.getElementById('edit-user-avatar').value = '';
    document.getElementById('edit-user-role').value = 'user';
}

async function saveEditedUser() {
    if (!userContextMenuTargetUser) return;

    const newUsername = document.getElementById('edit-user-username').value;
    const newRole = document.getElementById('edit-user-role').value;
    const newAvatarFile = document.getElementById('edit-user-avatar').files[0];

    const userIdToEdit = userContextMenuTargetUser._id;

    if (newUsername !== userContextMenuTargetUser.username || newRole !== userContextMenuTargetUser.role || newAvatarFile) {
        const formData = new FormData();
        formData.append('userId', userIdToEdit);
        if (newUsername !== userContextMenuTargetUser.username) {
            formData.append('newUsername', newUsername);
        }
        if (newRole !== userContextMenuTargetUser.role) {
            formData.append('newRole', newRole);
        }
        if (newAvatarFile) {
            formData.append('avatar', newAvatarFile);
        }

        const res = await fetch('/api/admin/edit-user', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            alert(data.message);
            loadUsers(); // Перезагружаем пользователей, чтобы обновить сайдбар
            if (activeId === userIdToEdit) { // Если редактировали активный приватный чат
                document.getElementById('chat-with').innerText = newUsername;
                if (newAvatarFile) {
                    document.getElementById('chat-avatar').src = fixPath(data.avatar);
                }
            }
        } else {
            alert(data.error);
        }
    }
    closeEditUserModal();
}

socket.on('banned', () => {
    alert("Вы были забанены администратором.");
    logout();
});

// Event Listeners
document.getElementById('msgInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        if (e.ctrlKey) {
            // Ctrl + Enter: Вставить новую строку
            // Стандартное поведение textarea для Enter - новая строка, но мы хотим отправку по Enter
            // Поэтому для Ctrl+Enter мы ничего не делаем (позволяем стандартное поведение), 
            // или явно вставляем \n если нужно
            e.target.value += '\n';
        } else {
            // Enter без Ctrl: Отправить сообщение
            e.preventDefault();
            sendMessage();
        }
    }
});

// Search Listener
const userSearchInput = document.getElementById('user-search');
if (userSearchInput) {
    userSearchInput.addEventListener('input', () => {
        renderSidebar();
    });
}


let typingTimeout = null;
document.getElementById('msgInput').addEventListener('input', (e) => {
    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = (e.target.scrollHeight) + 'px';

    const inputVal = e.target.value;
    const lastAtIndex = inputVal.lastIndexOf('@');
    const autocompleteDiv = document.getElementById('mention-autocomplete');
    autocompleteDiv.classList.add('hidden'); // Скрываем по умолчанию

    if (lastAtIndex !== -1 && (inputVal.length - 1) > lastAtIndex) {
        const searchText = inputVal.substring(lastAtIndex + 1).toLowerCase();
        const filteredUsers = allUsers.filter(u => u.username.toLowerCase().startsWith(searchText) && u._id !== user.id);

        autocompleteDiv.innerHTML = '';
        if (filteredUsers.length > 0) {
            filteredUsers.forEach(u => {
                const item = document.createElement('div');
                item.className = 'p-2 hover:bg-gray-700 cursor-pointer rounded-md';
                item.innerText = `@${u.username}`;
                item.onclick = () => {
                    const beforeAt = inputVal.substring(0, lastAtIndex);
                    e.target.value = `${beforeAt}@${u.username} `;
                    autocompleteDiv.classList.add('hidden');
                    e.target.focus();
                };
                autocompleteDiv.appendChild(item);
            });
            autocompleteDiv.classList.remove('hidden');
        }
    }
});

document.getElementById('msgInput').addEventListener('blur', () => {
    if (socket) {
        socket.emit('stop-typing', {
            senderId: user.id,
            receiverId: activeId
        });
    }
});

// Polling Online Status (5 sec)
setInterval(() => {
    if (socket && socket.connected) {
        socket.emit('get-online-users');
    }
}, 5000);

document.addEventListener('click', e => {
    // Скрываем контекстное меню сообщения, если клик был вне его
    if (!e.target.closest('#context-menu')) {
        document.getElementById('context-menu').classList.add('hidden');
    }
    // Скрываем контекстное меню пользователя, если клик был вне его
    if (!e.target.closest('#user-context-menu')) {
        document.getElementById('user-context-menu').classList.add('hidden');
    }
    // Скрываем эмодзи-пикер, если клик был вне его и кнопки эмодзи
    if (!e.target.closest('#emoji-picker') && !e.target.closest('.input-icon-btn[title="Эмодзи"]')) {
        document.getElementById('emoji-picker').classList.add('hidden');
    }
    // Скрываем autocomplete, если клик был вне его и поля ввода
    if (!e.target.closest('#mention-autocomplete') && !e.target.closest('#msgInput')) {
        document.getElementById('mention-autocomplete').classList.add('hidden');
    }
});

// Typing Indicators
// Bottom level socket listeners moved to setupSocketListeners()

// Оптимизированные функции обновления интерфейса
function updateUnreadCounter(userId) {
    const userElement = document.querySelector(`[data-user-id="${userId}"]`);
    if (userElement) {
        const counter = userElement.querySelector('.unread-counter');
        const count = unread[userId] || 0;
        if (count > 0) {
            if (!counter) {
                const newCounter = document.createElement('div');
                newCounter.className = 'unread-counter bg-blue-500 text-white text-xs font-bold w-5 h-5 flex items-center justify-center rounded-full absolute right-3 top-1/2 -translate-y-1/2 shadow-lg';
                userElement.appendChild(newCounter);
            }
            const counterElement = userElement.querySelector('.unread-counter');
            counterElement.textContent = count;
            counterElement.style.display = 'flex';
        } else if (counter) {
            counter.style.display = 'none';
        }
    }
}

// Throttling для обновлений статуса онлайн
let onlineStatusUpdateTimeout = null;

function updateOnlineStatuses() {
    // Отменяем предыдущий вызов если он был
    if (onlineStatusUpdateTimeout) {
        clearTimeout(onlineStatusUpdateTimeout);
    }

    // Выполняем обновление через 100ms чтобы избежать слишком частых обновлений
    onlineStatusUpdateTimeout = setTimeout(() => {
        // Обновляем статусы онлайн только для видимых элементов
        allUsers.forEach(u => {
            if (u._id !== user.id) {
                const userElement = document.querySelector(`[data-user-id="${u._id}"]`);
                if (userElement) {
                    const statusIndicator = userElement.querySelector('.status-indicator');
                    const isOnline = onlineUsers.includes(u._id);
                    if (statusIndicator) {
                        const currentClass = statusIndicator.className;
                        const newClass = `status-indicator w-3 h-3 rounded-full absolute bottom-0 right-0 border-2 border-gray-800 ${isOnline ? 'bg-green-500' : 'bg-gray-500'}`;

                        // Обновляем только если статус действительно изменился
                        if (currentClass !== newClass) {
                            statusIndicator.className = newClass;
                        }
                    }
                }
            }
        });
    }, 100);
}

// Throttling для обновления правой панели
let rightPanelUpdateTimeout = null;

function updateRightPanel() {
    // Отменяем предыдущий вызов
    if (rightPanelUpdateTimeout) {
        clearTimeout(rightPanelUpdateTimeout);
    }

    // Выполняем обновление через 200ms
    rightPanelUpdateTimeout = setTimeout(() => {
        const onlineCount = onlineUsers.length;
        const counterElement = document.getElementById('members-count');
        if (counterElement && counterElement.textContent !== onlineCount.toString()) {
            counterElement.textContent = onlineCount;
        }
    }, 200);
}

function updateUserStatus(userId, action) {
    // Обновляем статус пользователя без полной перерисовки
    const user = allUsers.find(u => u._id === userId);
    if (user) {
        user.banned = (action === 'banned');
        // Обновляем соответствующий элемент в интерфейсе
        const userElement = document.querySelector(`[data-user-id="${userId}"]`);
        if (userElement) {
            if (action === 'banned') {
                userElement.classList.add('banned-user');
                userElement.style.opacity = '0.5';
            } else {
                userElement.classList.remove('banned-user');
                userElement.style.opacity = '1';
            }
        }
    }
}

if (socket) {
    socket.on('global-game-event', (data) => {
        showToast(data.message, 'success');
    });
}

// Final initialization
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});
