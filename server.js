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
// Socket.IO с оптимизированными настройками для уменьшения нагрузки
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6,
    cors: {
        origin: true,
        methods: ["GET", "POST"]
    }
});

// --- GLOBAL GAME STATES (Moved to top for visibility) ---
const snakePlayers = {};
let snakeFood = [{ x: 200, y: 200, color: '#ef4444' }];
const seaQueue = [];
const seaGames = {};

// Game diagnostic heartbeat

// Директории
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });

const usersDb = Datastore.create({ filename: './data/users.db', autoload: true });
const msgsDb = Datastore.create({ filename: './data/messages.db', autoload: true });
const blockedIPsDb = Datastore.create({ filename: './data/blocked_ips.db', autoload: true });
const gamesDb = Datastore.create({ filename: './data/games.db', autoload: true });

// DATABASE OPTIMIZATION
// NeDB-promises uses ensureIndex directly
(async () => {
    try {
        await usersDb.ensureIndex({ fieldName: 'username', unique: true });
        await usersDb.ensureIndex({ fieldName: 'ips' });
        await msgsDb.ensureIndex({ fieldName: 'timestamp' });
        await msgsDb.ensureIndex({ fieldName: 'senderId' });
        await msgsDb.ensureIndex({ fieldName: 'receiverId' });
        console.log('✅ База данных оптимизирована (индексы созданы)');
    } catch (e) {
        console.error('Ошибка оптимизации БД:', e);
    }
})();

// Проверка и создание админ-пользователя (оптимизировано)
(async () => {
    const adminUser = await usersDb.findOne({ username: 'admin' });
    if (!adminUser) {
        const hashedPassword = await bcrypt.hash('adminpass', 10);
        await usersDb.insert({ username: 'admin', password: hashedPassword, avatar: '/img/default-avatar.png', lastMsgAt: new Date(), role: 'admin' });
        console.log('⚠️ Администратор "admin" создан с паролем по умолчанию. СМЕНИТЕ ПАРОЛЬ!');
    } else {
        // Только проверяем и устанавливаем роль если её нет
        if (!adminUser.role) {
            await usersDb.update({ username: 'admin' }, { $set: { role: 'admin' } });
            console.log('Роль администратора "admin" установлена');
        }
    }
})();

// Разрешённые типы файлов для безопасности
const ALLOWED_FILE_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/wav', 'audio/ogg',
    'application/pdf',
    'text/plain'
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Безопасное имя файла
function sanitizeFilename(filename) {
    return filename
        .replace(/[^a-zA-Z0-9._-]/g, '_') // Убираем опасные символы
        .replace(/\.{2,}/g, '.') // Убираем множественные точки
        .substring(0, 100); // Ограничиваем длину
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const safeName = sanitizeFilename(file.originalname);
        cb(null, Date.now() + '-' + safeName);
    }
});

// Фильтр файлов для безопасности
const fileFilter = (req, file, cb) => {
    if (ALLOWED_FILE_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Недопустимый тип файла'), false);
    }
};

const upload = multer({
    storage,
    // fileFilter, // Removed restriction
    limits: { fileSize: MAX_FILE_SIZE }
});

// Middleware для блокировки IP
app.use(async (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress ||
        (req.socket && req.socket.remoteAddress) ||
        (req.connection && req.connection.remoteAddress) ||
        'unknown';

    // Очищаем IP от ::ffff: префикса для IPv4
    const cleanIP = clientIP.replace(/^::ffff:/, '');

    try {
        const blockedIP = await blockedIPsDb.findOne({ ip: cleanIP });
        if (blockedIP) {
            return res.status(403).json({
                error: 'Ваш IP адрес заблокирован. Обратитесь к администратору.',
                blocked: true,
                reason: blockedIP.reason || 'Не указана',
                blockedAt: blockedIP.blockedAt
            });
        }
    } catch (error) {
        console.error('Error checking blocked IP:', error);
    }

    // Сохраняем IP в req для использования в других местах
    req.clientIP = cleanIP;
    next();
});

// Безопасность (минимальная для HTTP)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
}));

// Rate limiting (мягкий для чата)
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5000, // Увеличиваем лимит для активного использования
    message: 'Слишком много запросов, подождите немного.'
});
app.use(limiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Увеличиваем лимит попыток входа
    message: 'Слишком много попыток входа, попробуйте позже.'
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Middleware для запрета кэширования статических файлов
app.use((req, res, next) => {
    if (req.url.match(/\.(css|js|html|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

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

// API для управления заблокированными IP
app.get('/api/admin/blocked-ips', async (req, res) => {
    const adminUser = await usersDb.findOne({ _id: req.query.adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    try {
        const blockedIPs = await blockedIPsDb.find({}).sort({ blockedAt: -1 });
        res.json(blockedIPs);
    } catch (error) {
        console.error('Error getting blocked IPs:', error);
        res.status(500).json({ error: 'Ошибка получения списка заблокированных IP' });
    }
});

app.post('/api/admin/block-ip', async (req, res) => {
    const { adminId, ip, reason } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        return res.status(400).json({ error: 'Некорректный IP адрес.' });
    }

    try {
        const existingBlock = await blockedIPsDb.findOne({ ip });
        if (existingBlock) {
            return res.status(400).json({ error: 'Этот IP уже заблокирован.' });
        }

        const blockData = {
            ip,
            reason: reason || 'Заблокирован администратором',
            blockedAt: new Date(),
            blockedBy: adminId
        };

        await blockedIPsDb.insert(blockData);
        res.json({ success: true, message: `IP ${ip} успешно заблокирован.` });
    } catch (error) {
        console.error('Error blocking IP:', error);
        res.status(500).json({ error: 'Ошибка блокировки IP' });
    }
});

app.post('/api/admin/unblock-ip', async (req, res) => {
    const { adminId, ip } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    try {
        const result = await blockedIPsDb.remove({ ip });
        if (result > 0) {
            res.json({ success: true, message: `IP ${ip} успешно разблокирован.` });
        } else {
            res.status(404).json({ error: 'IP не найден в списке заблокированных.' });
        }
    } catch (error) {
        console.error('Error unblocking IP:', error);
        res.status(500).json({ error: 'Ошибка разблокировки IP' });
    }
});

app.post('/api/admin/unblock-all-ips', async (req, res) => {
    const { adminId } = req.body;
    const adminUser = await usersDb.findOne({ _id: adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для выполнения этой операции.' });
    }

    try {
        const result = await blockedIPsDb.remove({}, { multi: true });
        res.json({ success: true, message: `Все заблокированные IP разблокированы (${result} адресов).` });
    } catch (error) {
        console.error('Error unblocking all IPs:', error);
        res.status(500).json({ error: 'Ошибка разблокировки IP адресов' });
    }
});

// Новое API: Статистика по IP
app.get('/api/admin/ip-stats', async (req, res) => {
    const adminUser = await usersDb.findOne({ _id: req.query.adminId });
    if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав.' });
    }

    try {
        const users = await usersDb.find({});
        const blockedIPsList = await blockedIPsDb.find({});
        const blockedIPsSet = new Set(blockedIPsList.map(b => b.ip));

        const ipStats = {};

        users.forEach(u => {
            if (u.ips && Array.isArray(u.ips)) {
                u.ips.forEach(ip => {
                    if (!ipStats[ip]) {
                        ipStats[ip] = {
                            ip: ip,
                            count: 0,
                            users: [],
                            blocked: blockedIPsSet.has(ip)
                        };
                    }
                    ipStats[ip].count++;
                    if (!ipStats[ip].users.includes(u.username)) {
                        ipStats[ip].users.push(u.username);
                    }
                });
            }
        });

        // Преобразуем в массив и сортируем по количеству аккаунтов
        const sortedStats = Object.values(ipStats).sort((a, b) => b.count - a.count);
        res.json(sortedStats);
    } catch (error) {
        console.error('Error getting IP stats:', error);
        res.status(500).json({ error: 'Ошибка получения статистики IP' });
    }
});

const onlineUsers = new Map();

// Валидация входных данных
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim();
}

// API: Логин/Регистрация (Авто-создание если нет)
// API: Регистрация
app.post('/api/register', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    const cleanUsername = sanitizeInput(username);
    const cleanPassword = sanitizeInput(password);

    if (!cleanUsername || !cleanPassword) {
        return res.status(400).json({ error: 'Имя пользователя и пароль обязательны.' });
    }

    if (cleanUsername.length > 50 || cleanPassword.length > 100) {
        return res.status(400).json({ error: 'Имя пользователя или пароль слишком длинные.' });
    }

    const existingUser = await usersDb.findOne({ username: cleanUsername });
    if (existingUser) {
        return res.status(400).json({ error: 'Пользователь с таким именем уже существует.' });
    }

    const hashedPassword = await bcrypt.hash(cleanPassword, 10);

    // Получаем IP
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const cleanIP = clientIP.replace(/^::ffff:/, '');

    // AUTO-BAN LOGIC: Check if IP has too many accounts
    const accountsWithThisIP = await usersDb.find({ ips: cleanIP });
    if (accountsWithThisIP.length >= 5) {
        // Block IP
        await blockedIPsDb.insert({ ip: cleanIP, reason: 'Too many accounts (5+)', timestamp: new Date() });

        // Notify Admins
        const adminSockets = [];
        for (const [uid, sockets] of onlineUsers.entries()) {
            const uInfo = await usersDb.findOne({ _id: uid });
            if (uInfo && uInfo.role === 'admin') {
                sockets.forEach(sid => adminSockets.push(sid));
            }
        }

        adminSockets.forEach(sid => {
            io.to(sid).emit('notification', {
                type: 'admin-alert',
                message: `⚠️ AUTO-BAN: IP ${cleanIP} заблокирован (создано 5+ аккаунтов).`
            });
        });

        console.log(`[SECURITY] Auto-banned IP: ${cleanIP} due to account limit (5)`);
        return res.status(403).json({ error: 'Достигнут лимит регистраций для вашего IP. IP заблокирован.' });
    }

    const user = await usersDb.insert({
        username: cleanUsername,
        password: hashedPassword,
        avatar: '/img/default-avatar.png',
        lastMsgAt: new Date(),
        role: 'user',
        ips: [cleanIP]
    });

    res.json({ success: true, user: { id: user._id, username: user.username, avatar: user.avatar, role: user.role } });
});

// API: Вход
app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    const cleanUsername = sanitizeInput(username);
    const cleanPassword = sanitizeInput(password);

    if (!cleanUsername || !cleanPassword) {
        return res.status(400).json({ error: 'Имя пользователя и пароль обязательны.' });
    }

    const user = await usersDb.findOne({ username: cleanUsername });
    if (!user) {
        return res.status(400).json({ error: 'Пользователь не найден. Пожалуйста, зарегистрируйтесь.' });
    }

    const match = await bcrypt.compare(cleanPassword, user.password);
    if (!match) return res.status(400).json({ error: 'Неверный пароль' });

    if (user.banned) {
        return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Обратитесь к администратору.' });
    }

    // Получаем IP
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const cleanIP = clientIP.replace(/^::ffff:/, '');

    // Сохраняем IP адрес
    await usersDb.update(
        { _id: user._id },
        { $addToSet: { ips: cleanIP } }
    );

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
    const q = u2 === 'GLOBAL' ? { receiverId: 'GLOBAL' } : { $or: [{ senderId: u1, receiverId: u2 }, { senderId: u2, receiverId: u1 }] };
    res.json(await msgsDb.find(q).sort({ timestamp: 1 }));
});

// Загрузка файлов через API
app.post('/api/upload', upload.single('chatFile'), (req, res) => {
    if (!req.file) return res.status(400).send('No file');
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


// Throttling для update-online-list
let lastOnlineUpdate = 0;
const ONLINE_UPDATE_THROTTLE = 2000; // 2 секунды

function emitOnlineUpdate() {
    const now = Date.now();
    if (now - lastOnlineUpdate > ONLINE_UPDATE_THROTTLE) {
        lastOnlineUpdate = now;
        io.emit('update-online-list', Array.from(onlineUsers.keys()));
    }
}

io.on('connection', (socket) => {
    socket.on('register-online', (userId) => {
        socket.userId = userId;
        if (!onlineUsers.has(userId)) {
            onlineUsers.set(userId, new Set());
        }
        onlineUsers.get(userId).add(socket.id);
        emitOnlineUpdate();
    });

    socket.on('get-online-users', () => {
        socket.emit('update-online-list', Array.from(onlineUsers.keys()));
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
        const userMentions = (data.text || '').match(/@\w+/g);

        if (userMentions) {
            const allUsers = await usersDb.find({}, { username: 1 });
            userMentions.forEach(mention => {
                const username = mention.substring(1);
                const mentionedUser = allUsers.find(u => u.username === username);
                if (mentionedUser) {
                    mentionedUsers.push(mentionedUser._id);
                    // Отправляем уведомление упомянутому пользователю
                    const socketIds = onlineUsers.get(mentionedUser._id);
                    if (socketIds) {
                        socketIds.forEach(sid => {
                            io.to(sid).emit('notification', { type: 'mention', message: `${data.senderName} упомянул вас в чате: ${data.text}` });
                        });
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
        if (socket.userId && onlineUsers.get(socket.userId)) {
            const socketIds = onlineUsers.get(socket.userId);
            socketIds.delete(socket.id);
            if (socketIds.size === 0) onlineUsers.delete(socket.userId);
        }
        emitOnlineUpdate();

        // Cleanup Snake (uses socket.id)
        if (snakePlayers[socket.id]) delete snakePlayers[socket.id];

        // Cleanup Sea Battle
        handleSeaDisconnect(socket);
    });


    // --- SNAKE GAME LOGIC ---
    socket.on('snake-join', (player) => {
        const colors = ['#ef4444', '#3b82f6', '#10b981', '#fbbf24', '#f472b6', '#a78bfa', '#2dd4bf'];
        const startX = Math.floor(Math.random() * 20 + 5) * 20;
        const startY = Math.floor(Math.random() * 20 + 5) * 20;

        snakePlayers[socket.id] = {
            ...player,
            socketId: socket.id,
            body: [{ x: startX, y: startY }, { x: startX - 20, y: startY }, { x: startX - 40, y: startY }],
            dir: 'right',
            score: 0,
            color: colors[Math.floor(Math.random() * colors.length)]
        };
        console.log(`Snake Join: ${player.username} on socket ${socket.id}`);
        // Send state back immediately to verify communication
        io.emit('snake-update', { snakes: snakePlayers, food: snakeFood });
    });

    socket.on('snake-dir', (dir) => {
        if (snakePlayers[socket.id]) {
            const curDir = snakePlayers[socket.id].dir;
            const opposites = { 'up': 'down', 'down': 'up', 'left': 'right', 'right': 'left' };
            if (opposites[dir] !== curDir) snakePlayers[socket.id].dir = dir;
        }
    });

    // --- SEA BATTLE LOGIC ---
    socket.on('sea-find-match', (player) => {
        console.log(`SeaMatch Search: ${player.username} (${socket.id})`);

        // Remove old entries for THIS SOCKET
        const qIdx = seaQueue.findIndex(p => p.socketId === socket.id);
        if (qIdx > -1) seaQueue.splice(qIdx, 1);

        seaQueue.push({ ...player, socketId: socket.id });

        if (seaQueue.length >= 2) {
            const p1 = seaQueue.shift();
            const p2 = seaQueue.shift();
            const gameId = 'sea_' + Date.now();

            const placeShips = () => {
                const s = [];
                while (s.length < 10) {
                    const idx = Math.floor(Math.random() * 100);
                    if (!s.includes(idx)) s.push(idx);
                }
                return s;
            };

            const ships1 = placeShips();
            const ships2 = placeShips();

            seaGames[gameId] = {
                id: gameId,
                players: [p1, p2],
                ships: { [p1.socketId]: ships1, [p2.socketId]: ships2 },
                hits: { [p1.socketId]: [], [p2.socketId]: [] },
                turn: p1.socketId
            };

            io.to(p1.socketId).emit('sea-start', { gameId, players: [p1, p2], startingPlayer: p1.socketId, myShips: ships1 });
            io.to(p2.socketId).emit('sea-start', { gameId, players: [p1, p2], startingPlayer: p1.socketId, myShips: ships2 });
        }
    });

    socket.on('sea-shot', ({ gameId, index }) => {
        const game = seaGames[gameId];
        if (!game || game.turn !== socket.id) return;

        const opponent = game.players.find(p => p.socketId !== socket.id);
        const isHit = game.ships[opponent.socketId].includes(index);
        game.hits[socket.id].push(index);

        io.to(game.players[0].socketId).emit('sea-shot-result', { shooterId: socket.id, index, isHit });
        io.to(game.players[1].socketId).emit('sea-shot-result', { shooterId: socket.id, index, isHit });

        const totalHits = game.hits[socket.id].filter(h => game.ships[opponent.socketId].includes(h)).length;
        if (totalHits === 10) {
            io.to(game.players[0].socketId).emit('sea-win', socket.id);
            io.to(game.players[1].socketId).emit('sea-win', socket.id);

            // Log Result
            const winner = game.players.find(p => p.socketId === socket.id);
            saveGameResult('Морской Бой', winner.username,
                game.players.map(p => p.username),
                { score: totalHits, duration: Date.now() - parseInt(gameId.split('_')[1]) }
            );

            delete seaGames[gameId];
        } else if (!isHit) {
            game.turn = opponent.socketId;
        }
    });
});

function handleSeaDisconnect(socket) {
    const qIdx = seaQueue.findIndex(p => p.socketId === socket.id);
    if (qIdx > -1) seaQueue.splice(qIdx, 1);

    for (const id in seaGames) {
        const game = seaGames[id];
        if (game.players.some(p => p.socketId === socket.id)) {
            const other = game.players.find(p => p.socketId !== socket.id);
            if (other) io.to(other.socketId).emit('sea-opponent-disconnected');
            delete seaGames[id];
        }
    }
}

// Snake Engine
setInterval(() => {
    const GRID = 20;
    const SIZE = 600;

    Object.values(snakePlayers).forEach(s => {
        const head = { ...s.body[0] };
        if (s.dir === 'up') head.y -= GRID;
        if (s.dir === 'down') head.y += GRID;
        if (s.dir === 'left') head.x -= GRID;
        if (s.dir === 'right') head.x += GRID;

        // Wall Collision
        if (head.x < 0 || head.x >= SIZE || head.y < 0 || head.y >= SIZE) {
            io.to(s.socketId).emit('snake-dead', s.socketId);
            saveGameResult('Змейка', s.id, [s.username], { score: s.score, reason: 'wall' });
            delete snakePlayers[s.socketId];
            return;
        }

        // Self/Other Collision
        let collided = false;
        Object.values(snakePlayers).forEach(other => {
            other.body.forEach((part, index) => {
                if (s.socketId === other.socketId && index === 0) return;
                if (head.x === part.x && head.y === part.y) collided = true;
            });
        });

        if (collided) {
            io.to(s.socketId).emit('snake-dead', s.socketId);
            saveGameResult('Змейка', s.id, [s.username], { score: s.score, reason: 'collision' });
            delete snakePlayers[s.socketId];
            return;
        }

        s.body.unshift(head);

        // Food Collision
        const foodIdx = snakeFood.findIndex(f => f.x === head.x && f.y === head.y);
        if (foodIdx > -1) {
            s.score += 10;
            snakeFood.splice(foodIdx, 1);
            // Spawn new food
            snakeFood.push({
                x: Math.floor(Math.random() * (SIZE / GRID)) * GRID,
                y: Math.floor(Math.random() * (SIZE / GRID)) * GRID,
                color: ['#ef4444', '#fbbf24', '#10b981', '#3b82f6'][Math.floor(Math.random() * 4)]
            });
        } else {
            s.body.pop();
        }
    });

    if (Object.keys(snakePlayers).length > 0) {
        // Broadcast to everyone (could be optimized with a 'snake-room')
        io.emit('snake-update', { snakes: snakePlayers, food: snakeFood });
    }
}, 150);


// Game result logging helper
async function saveGameResult(gameName, winnerId, players, details) {
    try {
        const result = {
            game: gameName,
            winnerId,
            players,
            details,
            timestamp: new Date()
        };
        await gamesDb.insert(result);
        console.log(`[GAME LOG] ${gameName} ended. Result saved.`);

        // Broadcast a small event for global log (optional)
        io.emit('global-game-event', { message: `Игра ${gameName} завершена. Победил: ${winnerId === 'DRAW' ? 'Ничья' : winnerId}` });
    } catch (e) {
        console.error('Error saving game result:', e);
    }
}

// GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
    console.error('SERVER ERROR:', err.message);
    if (err.message === 'Недопустимый тип файла') {
        return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message, details: err.stack });
});

server.listen(3000, () => console.log('SERVER RUNNING: http://localhost:3000'));