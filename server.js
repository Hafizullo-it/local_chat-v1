const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Datastore = require('nedb-promises');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Директории
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });

const usersDb = Datastore.create({ filename: './data/users.db', autoload: true });
const msgsDb = Datastore.create({ filename: './data/messages.db', autoload: true });

// Проверка и создание админ-пользователя
(async () => {
    const adminUser = await usersDb.findOne({ username: 'admin' });
    if (!adminUser) {
        const hashedPassword = await bcrypt.hash('adminpass', 10); // Пароль по умолчанию для админа
        await usersDb.insert({ username: 'admin', password: hashedPassword, avatar: '', lastMsgAt: new Date(), role: 'admin' });
        console.log('Администратор "admin" создан с паролем по умолчанию');
    } else {
        // Если админ существует, но пароль не совпадает с adminpass, обновляем его
        const defaultPassword = await bcrypt.hash('adminpass', 10);
        const match = await bcrypt.compare('adminpass', adminUser.password);
        const updates = {};
        if (!match) {
            updates.password = defaultPassword;
            console.log('Пароль администратора "admin" сброшен на значение по умолчанию');
        }
        if (!adminUser.role) {
            updates.role = 'admin';
            console.log('Роль администратора "admin" установлена');
        }
        if (Object.keys(updates).length > 0) {
            await usersDb.update({ username: 'admin' }, { $set: updates });
        }
    }
})();

const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Безопасность
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "ws:", "wss:"],
            fontSrc: ["'self'"],
        },
    },
}));

// Rate limiting (более мягкий)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Увеличиваем лимит для тестирования
    message: 'Слишком много запросов с этого IP, попробуйте позже.'
});
app.use(limiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Увеличиваем лимит попыток входа
    message: 'Слишком много попыток входа, попробуйте позже.'
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use('/libs/webfonts', express.static(path.join(__dirname, 'public/libs/webfonts')));

// Корневой маршрут - перенаправление на чат
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Проверка доступа к админ-панели
app.get('/admin-access', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) {
        return res.redirect('/');
    }

    const user = await usersDb.findOne({ _id: userId });
    if (!user || (user.role !== 'admin' && user.username !== 'admin')) {
        return res.redirect('/');
    }

    // Если админ - перенаправляем на админ-панель
    // Передаем данные пользователя через query параметры для сохранения в localStorage
    res.redirect(`/admin.html?userId=${userId}&username=${encodeURIComponent(user.username)}&role=${user.role}&avatar=${encodeURIComponent(user.avatar || '')}`);
});

// Админ-панель API
app.get('/api/admin/users', async (req, res) => {
    const adminUser = await usersDb.findOne({ _id: req.query.adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    const users = await usersDb.find({});
    // Не возвращаем пароли в ответе
    const usersWithoutPasswords = users.map(u => ({
        id: u._id,
        username: u.username,
        avatar: u.avatar,
        role: u.role,
        banned: u.banned || false,
        lastMsgAt: u.lastMsgAt
    }));
    res.json(usersWithoutPasswords);
});

app.post('/api/admin/update-user', async (req, res) => {
    const { adminId, userId, newUsername, newPassword, newRole } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    const userToUpdate = await usersDb.findOne({ _id: userId });
    if (!userToUpdate) {
        return res.status(404).json({ error: 'Пользователь не найден.' });
    }

    const updateData = {};
    if (newUsername && newUsername !== userToUpdate.username) {
        // Проверяем, не занят ли новый username
        const existingUser = await usersDb.findOne({ username: newUsername });
        if (existingUser && existingUser._id !== userId) {
            return res.status(400).json({ error: 'Это имя пользователя уже занято.' });
        }
        updateData.username = newUsername;
    }
    if (newPassword) {
        updateData.password = await bcrypt.hash(newPassword, 10);
    }
    if (newRole && newRole !== userToUpdate.role) {
        updateData.role = newRole;
    }

    if (Object.keys(updateData).length > 0) {
        await usersDb.update({ _id: userId }, { $set: updateData });
        res.json({ success: true, message: 'Данные пользователя успешно обновлены.' });
    } else {
        res.json({ success: true, message: 'Нет изменений для сохранения.' });
    }
});

app.post('/api/admin/delete-user', async (req, res) => {
    const { adminId, userId } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    if (adminId === userId) {
        return res.status(400).json({ error: 'Нельзя удалить самого себя.' });
    }

    const userToDelete = await usersDb.findOne({ _id: userId });
    if (!userToDelete) {
        return res.status(404).json({ error: 'Пользователь не найден.' });
    }

    // Удаляем все сообщения пользователя
    await msgsDb.remove({ senderId: userId });
    await msgsDb.remove({ receiverId: userId });

    // Удаляем пользователя
    await usersDb.remove({ _id: userId });

    // Отправляем сигнал всем клиентам об удалении пользователя
    io.emit('user-deleted', userId);

    res.json({ success: true, message: 'Пользователь успешно удален.' });
});

app.post('/api/admin/ban-user', async (req, res) => {
    const { adminId, userId } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    if (adminId === userId) {
        return res.status(400).json({ error: 'Нельзя забанить самого себя.' });
    }

    const userToBan = await usersDb.findOne({ _id: userId });
    if (!userToBan) {
        return res.status(404).json({ error: 'Пользователь не найден.' });
    }

    // Удаляем все сообщения забаниваемого пользователя
    await msgsDb.remove({ senderId: userId });
    await msgsDb.remove({ receiverId: userId });

    // Помечаем пользователя как забаненного (добавляем поле banned)
    await usersDb.update({ _id: userId }, { $set: { banned: true } });

    // Отправляем сигнал всем клиентам о бане
    io.emit('user-banned', userId);

    res.json({ success: true, message: 'Пользователь успешно забанен.' });
});

app.post('/api/admin/unban-user', async (req, res) => {
    const { adminId, userId } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    const userToUnban = await usersDb.findOne({ _id: userId });
    if (!userToUnban) {
        return res.status(404).json({ error: 'Пользователь не найден.' });
    }

    // Снимаем бан с пользователя
    await usersDb.update({ _id: userId }, { $unset: { banned: true } });

    // Отправляем сигнал всем клиентам о разбане
    io.emit('user-unbanned', userId);

    res.json({ success: true, message: 'Пользователь успешно разбанен.' });
});

const onlineUsers = new Map();

// Валидация входных данных
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim();
}

// API: Логин/Регистрация (Авто-создание если нет)
app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    // Валидация входных данных
    const cleanUsername = sanitizeInput(username);
    const cleanPassword = sanitizeInput(password);

    if (!cleanUsername || !cleanPassword) {
        return res.status(400).json({ error: 'Имя пользователя и пароль обязательны.' });
    }

    if (cleanUsername.length > 50 || cleanPassword.length > 100) {
        return res.status(400).json({ error: 'Имя пользователя или пароль слишком длинные.' });
    }

    let user = await usersDb.findOne({ username: cleanUsername });
    if (!user) {
        const hashedPassword = await bcrypt.hash(cleanPassword, 10);
        user = await usersDb.insert({ username: cleanUsername, password: hashedPassword, avatar: '/img/default-avatar.png', lastMsgAt: new Date(), role: 'user' });

    } else {
        const match = await bcrypt.compare(cleanPassword, user.password);
        if (!match) return res.status(400).json({ error: 'Неверный пароль' });

        // Проверяем, не забанен ли пользователь
        if (user.banned) {
            return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Обратитесь к администратору.' });
        }
    }

    // Проверяем, не забанен ли новый пользователь
    if (user.banned) {
        return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Обратитесь к администратору.' });
    }

    res.json({ success: true, user: { id: user._id, username: user.username, avatar: user.avatar, role: user.role } });
});

// Получение списка юзеров (Новые сообщения поднимают юзера вверх)
app.get('/api/users', async (req, res) => {
    const users = await usersDb.find({}, { password: 0 }).sort({ lastMsgAt: -1 });
    res.json(users);
});

// История сообщений
app.get('/api/messages/:u1/:u2', async (req, res) => {
    const { u1, u2 } = req.params;
    const q = u2 === 'GLOBAL' ? { receiverId: 'GLOBAL' } : { $or: [{senderId:u1, receiverId:u2}, {senderId:u2, receiverId:u1}] };
    res.json(await msgsDb.find(q).sort({ timestamp: 1 }));
});

// Загрузка файлов через API
app.post('/api/upload', upload.single('chatFile'), (req, res) => {
    if(!req.file) return res.status(400).send('No file');
    res.json({ filePath: '/uploads/' + req.file.filename, fileName: req.file.originalname, fileType: req.file.mimetype });
});

// API: Обновление пароля
app.post('/api/profile/password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    const user = await usersDb.findOne({ _id: userId });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(400).json({ error: 'Старый пароль не совпадает' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await usersDb.update({ _id: userId }, { $set: { password: hashedPassword } });
    res.json({ success: true, message: 'Пароль успешно обновлен' });
});

// API: Обновление ника
app.post('/api/profile/username', async (req, res) => {
    const { userId, newUsername } = req.body;
    const user = await usersDb.findOne({ _id: userId });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    await usersDb.update({ _id: userId }, { $set: { username: newUsername } });
    res.json({ success: true, message: 'Имя пользователя успешно обновлено' });
});

// API: Обновление аватара
app.post('/api/profile/avatar', upload.single('avatar'), async (req, res) => {
    const { userId } = req.body;
    if (!req.file) return res.status(400).send('No file');

    const user = await usersDb.findOne({ _id: userId });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const avatarPath = '/uploads/' + req.file.filename;
    await usersDb.update({ _id: userId }, { $set: { avatar: avatarPath } });
    res.json({ success: true, message: 'Аватар успешно обновлен', avatar: avatarPath });
});

// API: Админ - редактирование пользователя
app.post('/api/admin/edit-user', upload.single('avatar'), async (req, res) => { // upload.single('avatar') для возможной смены аватара
    const { userId, newUsername, newRole } = req.body;
    const adminUser = await usersDb.findOne({ _id: req.body.adminId }); // Предполагаем, что adminId передается в теле запроса
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    const userToEdit = await usersDb.findOne({ _id: userId });
    if (!userToEdit) {
        return res.status(404).json({ error: 'Редактируемый пользователь не найден.' });
    }

    const updateData = {};
    if (newUsername && newUsername !== userToEdit.username) {
        updateData.username = newUsername;
    }
    if (newRole && newRole !== userToEdit.role) {
        updateData.role = newRole;
    }
    if (req.file) { // Если загружен новый аватар
        updateData.avatar = '/uploads/' + req.file.filename;
    }

    if (Object.keys(updateData).length > 0) {
        await usersDb.update({ _id: userId }, { $set: updateData });
        res.json({ success: true, message: 'Данные пользователя успешно обновлены', avatar: updateData.avatar || userToEdit.avatar });
    } else {
        res.json({ success: true, message: 'Нет изменений для сохранения.' });
    }
});


io.on('connection', (socket) => {
    socket.on('register-online', (userId) => {
        socket.userId = userId;
        onlineUsers.set(userId, socket.id);
        io.emit('update-online-list', Array.from(onlineUsers.keys()));
    });

    socket.on('private-message', async (data) => {
        const msg = await msgsDb.insert({ ...data, timestamp: new Date(), status: 'sent', replyTo: data.replyTo || null });
        // Обновляем "свежесть" чата для сортировки
        await usersDb.update({ _id: data.senderId }, { $set: { lastMsgAt: new Date() } });
        if (data.receiverId !== 'GLOBAL') {
            await usersDb.update({ _id: data.receiverId }, { $set: { lastMsgAt: new Date() } });
        }

        // Обработка упоминаний
        const mentionedUsers = [];
        const userMentions = data.text.match(/@\w+/g);
        if (userMentions) {
            const allUsers = await usersDb.find({}, { username: 1 });
            userMentions.forEach(mention => {
                const username = mention.substring(1);
                const mentionedUser = allUsers.find(u => u.username === username);
                if (mentionedUser) {
                    mentionedUsers.push(mentionedUser._id);
                    // Отправляем уведомление упомянутому пользователю
                    const mentionedUserSocketId = onlineUsers.get(mentionedUser._id);
                    if (mentionedUserSocketId) {
                        io.to(mentionedUserSocketId).emit('notification', { type: 'mention', message: `${data.senderName} упомянул вас в чате: ${data.text}` }); // Исправлено data.content на data.text
                    }
                }
            });
        }

        io.emit('new-private-message', msg);
    });

    socket.on('delete-message', async ({ msgId, userId }) => {
        const userRequestingDelete = await usersDb.findOne({ _id: userId }); // Пользователь, запросивший удаление
        if (!userRequestingDelete) return;

        const messageToDelete = await msgsDb.findOne({ _id: msgId });
        if (!messageToDelete) return;

        // Админ может удалять любые сообщения
        if (userRequestingDelete.role === 'admin') {
            await msgsDb.remove({ _id: msgId });
        } else if (messageToDelete.senderId === userId) { // Обычный пользователь может удалять только свои
            await msgsDb.remove({ _id: msgId, senderId: userId });
        } else {
            return; // Недостаточно прав
        }
        io.emit('message-deleted', msgId);
    });

    socket.on('ban-user', async ({ adminId, userIdToBan }) => {
        const admin = await usersDb.findOne({ _id: adminId });
        if (!admin || admin.role !== 'admin') return;

        const userToBanSocketId = onlineUsers.get(userIdToBan);
        if (userToBanSocketId) {
            const userSocket = io.sockets.sockets.get(userToBanSocketId);
            if (userSocket) {
                userSocket.emit('banned');
                userSocket.disconnect(true);
            }
        }
        // В реальном приложении здесь можно было бы пометить пользователя как забаненного в БД
        // для предотвращения повторной регистрации и входа.
    });

    socket.on('message-read', async ({ msgId, readerId }) => {
        await msgsDb.update({ _id: msgId }, { $set: { status: 'read' } });
        io.emit('message-status-updated', { msgId, status: 'read', readerId });
    });

    socket.on('edit-message', async ({ msgId, userId, newContent }) => {
        const userRequestingEdit = await usersDb.findOne({ _id: userId });
        if (!userRequestingEdit) return;

        const messageToEdit = await msgsDb.findOne({ _id: msgId });
        if (!messageToEdit) return;

        // Админ может редактировать любые сообщения, обычный пользователь - только свои
        if (userRequestingEdit.role === 'admin' || messageToEdit.senderId === userId) {
            await msgsDb.update({ _id: msgId }, { $set: { text: newContent, edited: true } });
            io.emit('message-edited', { msgId, newContent });
        }
    });

    socket.on('typing', ({ senderId, receiverId }) => {
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('user-typing', { senderId, receiverId });
        }
    });

    socket.on('stop-typing', ({ senderId, receiverId }) => {
        const receiverSocketId = onlineUsers.get(receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('user-stop-typing', { senderId, receiverId });
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.userId);
        io.emit('update-online-list', Array.from(onlineUsers.keys()));
    });
});

server.listen(3000, () => console.log('SERVER RUNNING: http://localhost:3000'));