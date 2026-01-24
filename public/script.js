const socket = io();
const user = JSON.parse(localStorage.getItem('user'));
if (!user) window.location.href = '/';

// Регистрируем пользователя как онлайн
socket.emit('register-online', user.id);

let activeId = null,
    allUsers = [],
    onlineUsers = [],
    unread = {},
    selectedMsg = null,
    currentReply = null,
    msgs = [],
    selectedUser = null, // Добавлено для хранения выбранного пользователя для контекстного меню
    selectedUserElement = null; // Добавлено для хранения элемента пользователя для контекстного меню

function fixPath(p) {
    return p ? p : '/img/default-avatar.png';
}

// Init
document.getElementById('my-ava').src = fixPath(user.avatar);
document.getElementById('my-name').innerText = user.username;

// Show admin panel button if user is admin
if (user && (user.role === 'admin' || user.username === 'admin')) {
    document.getElementById('admin-panel-btn').classList.remove('hidden');
}

// Users & Sidebar
async function loadUsers() {
    const res = await fetch('/api/users');
    allUsers = await res.json();
    renderSidebar();
    renderRightPanel();
}

function renderSidebar() {
    const cont = document.getElementById('user-list');
    cont.innerHTML = '';
    allUsers.forEach(u => {
        if (u._id === user.id) return;
        const isOnline = onlineUsers.includes(u._id);
        const isBanned = u.banned;

        const div = document.createElement('div');
        div.className = `user-item group p-3 cursor-pointer flex items-center gap-3 rounded-xl mx-2 my-1 relative transition-colors duration-200 hover:bg-gray-700 ${activeId === u._id ? 'active-chat bg-blue-600 bg-opacity-20 border-l-4 border-blue-500 !important' : ''}`;

        if (isBanned) {
            // Для забаненных пользователей показываем только аватар
            div.innerHTML = `
                <div class="relative">
                    <img src="${fixPath(u.avatar)}" class="w-12 h-12 rounded-full object-cover opacity-50">
                    <div class="w-3 h-3 bg-red-500 rounded-full absolute bottom-0 right-0 border-2 border-gray-800"></div>
                </div>
                <div class="flex-grow">
                    <div class="font-semibold text-gray-500 italic">Забанен</div>
                    <div class="text-xs text-gray-600">Аккаунт заблокирован</div>
                </div>
            `;
            // Забаненных пользователей нельзя выбрать для чата
            div.onclick = null;
            div.style.cursor = 'not-allowed';
        } else {
        div.innerHTML = `
                <div class="relative">
                    <img src="${fixPath(u.avatar)}" class="w-12 h-12 rounded-full object-cover">
                    ${isOnline ? '<div class="w-3 h-3 bg-green-500 rounded-full absolute bottom-0 right-0 border-2 border-gray-800"></div>' : ''}
                </div>
                <div class="flex-grow">
                    <div class="font-semibold text-white">${u.username}</div>
                    <div class="text-xs text-gray-400">${isOnline ? 'В сети' : 'Не в сети'}</div>
                </div>
                ${unread[u._id] ? `<div class="bg-blue-500 text-white text-xs font-bold w-5 h-5 flex items-center justify-center rounded-full absolute right-3 top-1/2 -translate-y-1/2 shadow-lg">${unread[u._id]}</div>` : ''}
                <!-- Кнопка бана удалена отсюда, теперь она будет в контекстном меню -->
            `;
            div.onclick = () => {
                activeId = u._id;
                unread[u._id] = 0;
                document.getElementById('chat-with').innerText = u.username;
                document.getElementById('chat-avatar').src = fixPath(u.avatar);
                document.getElementById('chat-avatar').classList.remove('hidden');
                document.getElementById('pinned-message').classList.add('hidden'); // Скрываем закрепленное сообщение
                document.getElementById('right-panel').classList.remove('hidden'); // Теперь она всегда видима
                document.getElementById('members-list').innerHTML = ''; // Очищаем список участников
                document.getElementById('members-count').innerText = '0'; // Сбрасываем счетчик
                loadMsgs();
                renderSidebar();
            };
        }
        div.onclick = () => { 
            activeId = u._id; 
            unread[u._id] = 0; 
            document.getElementById('chat-with').innerText = u.username;
            document.getElementById('chat-avatar').src = fixPath(u.avatar);
            document.getElementById('chat-avatar').classList.remove('hidden');
            document.getElementById('pinned-message').classList.add('hidden'); // Скрываем закрепленное сообщение
            document.getElementById('right-panel').classList.remove('hidden'); // Теперь она всегда видима
            document.getElementById('members-list').innerHTML = ''; // Очищаем список участников
            document.getElementById('members-count').innerText = '0'; // Сбрасываем счетчик
            loadMsgs();
            renderSidebar();
        };

        // Добавляем обработчик правого клика для открытия контекстного меню пользователя
        div.oncontextmenu = (e) => {
            e.preventDefault();
            selectedUser = u; // Сохраняем выбранного пользователя
            selectedUserElement = div; // Сохраняем элемент пользователя
            updateUserContextMenu(e); // Обновляем и показываем контекстное меню пользователя
        };

        cont.appendChild(div);
    });
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
    if (m.file) {
        const fileExtension = m.file.path.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension)) {
            fileHTML = `<img src="${m.file.path}" class="max-w-full rounded-lg mt-2 cursor-pointer" onclick="window.open('${m.file.path}')">`;
        } else {
            fileHTML = `<a href="${m.file.path}" target="_blank" class="text-blue-300 underline mt-2 flex items-center gap-1"><i class="fas fa-file"></i> ${m.file.fileName || 'Файл'}</a>`;
        }
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
        selectedMsg = m;
        updateContextMenu();
        const menu = document.getElementById('context-menu');
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.classList.remove('hidden');
    };

    msgWrapper.appendChild(messageContent); // Добавляем контент сообщения в обертку
    document.getElementById('messages').appendChild(msgWrapper); // Добавляем обертку в контейнер сообщений
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;

    if (!isMe && m.status !== 'read') {
        socket.emit('message-read', { msgId: m._id, readerId: user.id });
    }
}

function sendMessage() {
    const inp = document.getElementById('msgInput');
    if (!inp.value.trim() && !currentReply) return;

    socket.emit('private-message', {
        senderId: user.id,
        receiverId: activeId,
        text: inp.value,
        senderName: user.username,
        senderAva: user.avatar,
        replyTo: currentReply ? {
            _id: currentReply._id,
            senderName: currentReply.senderName,
            content: currentReply.text || (currentReply.file ? currentReply.file.fileName : 'Файл')
        } : null
    });
    inp.value = '';
    cancelReply();
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
    socket.emit('private-message', {
        senderId: user.id,
        receiverId: activeId,
        senderName: user.username,
        file: {
            path: f.filePath,
            fileName: f.fileName,
            fileType: f.fileType
        }
    });
    input.value = null; // Сброс выбранного файла
}

// Socket events
socket.emit('register-online', user.id);
socket.on('update-online-list', ids => {
    onlineUsers = ids;
    renderSidebar();
    renderRightPanel();
});
socket.on('new-private-message', m => {
    if (m.receiverId === activeId || m.senderId === activeId || (m.receiverId === 'GLOBAL' && activeId === 'GLOBAL')) {
        renderMsg(m);
        if (m.senderId === activeId) {
            document.getElementById('typing-indicator').classList.add('hidden');
        }
    } else {
        unread[m.senderId] = (unread[m.senderId] || 0) + 1;
    }
    loadUsers();
});

socket.on('user-typing', ({
    senderId,
    receiverId
}) => {
    if (senderId === activeId) {
        document.getElementById('typing-indicator').classList.remove('hidden');
    }
});

socket.on('user-stop-typing', ({
    senderId,
    receiverId
}) => {
    if (senderId === activeId) {
        document.getElementById('typing-indicator').classList.add('hidden');
    }
});

socket.on('notification', ({
    type,
    message
}) => {
    // Можно использовать более красивое уведомление (Toast)
    alert(`Уведомление: ${message}`);
});

socket.on('message-edited', ({
    msgId,
    newContent
}) => {
    const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (msgElement) {
        const contentDiv = msgElement.querySelector('div.whitespace-pre-wrap'); // Обновлено
        if (contentDiv) {
            contentDiv.innerHTML = newContent;
            if (!msgElement.querySelector('.message-info .text-xs')) {
                const infoSpan = msgElement.querySelector('.message-info');
                if (infoSpan) {
                    infoSpan.insertAdjacentHTML('afterbegin', '<span class="text-xs text-gray-500 mr-1">изм.</span>');
                }
            }
        }
    }
});

socket.on('message-deleted', (msgId) => {
    const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (msgElement) {
        msgElement.remove();
    }
});

socket.on('message-status-updated', ({
    msgId,
    status
}) => {
    const msgElement = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (msgElement && status === 'read') {
        const checkIcon = msgElement.querySelector('.message-info .fas.fa-check');
        if (checkIcon) {
            checkIcon.classList.remove('fa-check', 'text-gray-400');
            checkIcon.classList.add('fa-check-double', 'text-blue-500');
        }
    }
});

// Utils
function openGlobal() {
    activeId = 'GLOBAL';
    console.log('openGlobal: activeId set to', activeId); // Лог
    document.getElementById('chat-with').innerText = 'Общий чат';
    document.getElementById('chat-avatar').classList.add('hidden');
    document.getElementById('pinned-message').classList.remove('hidden');
    document.getElementById('right-panel').classList.remove('hidden'); // Показываем правую панель
    loadMsgs();
    renderSidebar();
    renderRightPanel(); // Обновляем правую панель для глобального чата
}

function handleReply() {
    currentReply = selectedMsg;
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('reply-original-sender').innerText = `Ответ на: ${selectedMsg.senderName}`;
    document.getElementById('reply-original-content').innerText = selectedMsg.text || (selectedMsg.file ? selectedMsg.file.fileName : 'Файл');
}

function handleEdit() {
    if (!isAdmin() && selectedMsg.senderId !== user.id) { // Изменено
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
    if (confirm("Удалить?")) {
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

function logout() {
    localStorage.removeItem('user');
    window.location.href = '/';
}

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
    document.getElementById('right-panel').classList.toggle('hidden');
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

// Проверка, является ли текущий пользователь админом
function isAdmin() {
    return user && (user.role === 'admin' || user.username === 'admin');
}

// Обновление контекстного меню сообщения в зависимости от роли пользователя
function updateContextMenu() {
    const contextMenu = document.getElementById('context-menu');
    contextMenu.innerHTML = ''; // Очищаем меню перед заполнением

    const replyBtn = document.createElement('button');
    replyBtn.className = 'flex items-center gap-2 p-2 text-sm text-gray-200 hover:bg-gray-700 rounded-md cursor-pointer'; // Обновленный класс
    replyBtn.onclick = () => { handleReply(); contextMenu.classList.add('hidden'); };
    replyBtn.innerHTML = '<i class="fas fa-reply text-blue-400"></i><span>Ответить</span>';
    contextMenu.appendChild(replyBtn);

    // Только отправитель или админ может редактировать сообщение
    if (isAdmin() || selectedMsg.senderId === user.id) {
        const editBtn = document.createElement('button');
        editBtn.className = 'flex items-center gap-2 p-2 text-sm text-gray-200 hover:bg-gray-700 rounded-md cursor-pointer'; // Обновленный класс
        editBtn.onclick = () => { handleEdit(); contextMenu.classList.add('hidden'); };
        editBtn.innerHTML = '<i class="fas fa-edit text-yellow-400"></i><span>Изменить</span>';
        contextMenu.appendChild(editBtn);
    }

    // Админ может удалять любые сообщения, обычный пользователь - только свои
    if (isAdmin() || selectedMsg.senderId === user.id) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'flex items-center gap-2 p-2 text-sm text-red-400 hover:bg-gray-700 rounded-md cursor-pointer'; // Обновленный класс
        deleteBtn.onclick = () => { handleDelete(); contextMenu.classList.add('hidden'); };
        deleteBtn.innerHTML = '<i class="fas fa-trash text-red-500"></i><span>Удалить</span>';
        contextMenu.appendChild(deleteBtn);
    }
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
        if (e.ctrlKey) { // Если Ctrl + Enter
            e.preventDefault(); // Предотвращаем стандартное поведение Enter (отправку формы)
            e.target.value += '\n'; // Вставляем новую строку
        } else { // Если просто Enter
            e.preventDefault(); // Предотвращаем стандартное поведение Enter (перенос строки)
            sendMessage();
        }
    }
});

let typingTimeout = null;
document.getElementById('msgInput').addEventListener('input', (e) => {
    socket.emit('typing', {
        senderId: user.id,
        receiverId: activeId
    });
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop-typing', {
            senderId: user.id,
            receiverId: activeId
        });
    }, 1000);

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
    // Не скрываем autocomplete на blur, чтобы можно было выбрать пользователя
    // if (typingTimeout) clearTimeout(typingTimeout);
    socket.emit('stop-typing', {
        senderId: user.id,
        receiverId: activeId
    });
});

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

// Инициализация
loadUsers();
function openGlobal() {
    activeId = "GLOBAL";
    console.log("openGlobal: activeId set to GLOBAL"); // Р›РѕРі
    document.getElementById("chat-with").innerText = "РћР±С‰РёР№ С‡Р°С‚";
    document.getElementById("chat-avatar").classList.add("hidden");
    document.getElementById("pinned-message").classList.add("hidden");
    // document.getElementById("right-panel").classList.add("hidden"); // РЈР±СЂР°Р» СЌС‚Рѕ
    document.getElementById("right-panel").classList.remove("hidden"); // РўРµРїРµСЂСЊ РѕРЅР° РІСЃРµРіРґР° РІРёРґРёРјР°
    loadMsgs();
    renderSidebar();
    renderRightPanel(); // Р”РѕР±Р°РІР»РµРЅРѕ РґР»СЏ РѕР±РЅРѕРІР»РµРЅРёСЏ РїСЂР°РІРѕР№ РїР°РЅРµР»Рё
}

socket.on("user-banned", (userId) => {
    if (userId === user.id) {
        alert("Р’С‹ Р±С‹Р»Рё Р·Р°Р±Р°РЅРµРЅС‹ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂРѕРј.");
        logout();
    } else {
        renderSidebar();
    }
});

socket.on("user-unbanned", (userId) => {
    renderSidebar();
});

socket.on("user-deleted", (userId) => {
    // Удаляем пользователя из списка
    allUsers = allUsers.filter(u => u._id !== userId);
    // Удаляем из онлайн пользователей
    onlineUsers = onlineUsers.filter(id => id !== userId);
    // Перерисовываем интерфейс
    renderSidebar();

    // Если удаленный пользователь был в активном чате, закрываем чат
    if (activeId === userId) {
        activeId = null;
        openGlobal();
    }
});

// РРЅРёС†РёР°Р»РёР·Р°С†РёСЏ
loadUsers();
openGlobal(); // РћС‚РєСЂС‹РІР°РµРј РіР»РѕР±Р°Р»СЊРЅС‹Р№ С‡Р°С‚ РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ РїСЂРё Р·Р°РіСЂСѓР·РєРµ
