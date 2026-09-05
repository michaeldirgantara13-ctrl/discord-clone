const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

// ============================================================
// STATIC FILE
// ============================================================

// Jangan biarkan index.html tersimpan di cache browser/proxy
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            res.setHeader(
                'Cache-Control',
                'no-store, no-cache, must-revalidate, proxy-revalidate'
            );
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ============================================================
// HALAMAN UTAMA
// ============================================================

app.get('/', (req, res) => {
    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// TEST VERSI RAILWAY
// ============================================================

app.get('/test-version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.send('RAILWAY-TEST-123 - index.js versi terbaru aktif');
});

// ============================================================
// FILE DATABASE
// ============================================================

const DATA_FILE = path.join(__dirname, 'chat-data.json');

// ============================================================
// DEFAULT CHANNEL
// ============================================================

const DEFAULT_CHANNELS = {
    umum: [],
    gaming: [],
    musik: []
};

// ============================================================
// LOAD CHANNEL
// ============================================================

function loadChannels() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(DEFAULT_CHANNELS, null, 2)
            );

            console.log('chat-data.json dibuat.');

            return JSON.parse(JSON.stringify(DEFAULT_CHANNELS));
        }

        const data = fs.readFileSync(DATA_FILE, 'utf8');

        if (!data.trim()) {
            return JSON.parse(JSON.stringify(DEFAULT_CHANNELS));
        }

        const parsed = JSON.parse(data);

        // Pastikan channel default tetap ada
        if (!parsed.umum) parsed.umum = [];
        if (!parsed.gaming) parsed.gaming = [];
        if (!parsed.musik) parsed.musik = [];

        return parsed;

    } catch (error) {
        console.error('Gagal membaca chat-data.json:', error);

        return JSON.parse(JSON.stringify(DEFAULT_CHANNELS));
    }
}

// ============================================================
// SAVE CHANNEL
// ============================================================

function saveChannels() {
    try {
        const tempFile = DATA_FILE + '.tmp';

        fs.writeFileSync(
            tempFile,
            JSON.stringify(channels, null, 2)
        );

        fs.renameSync(tempFile, DATA_FILE);

    } catch (error) {
        console.error('Gagal menyimpan chat-data.json:', error);
    }
}

// ============================================================
// DATA AKTIF
// ============================================================

let channels = loadChannels();

// ============================================================
// USER ONLINE
// ============================================================

const onlineUsers = {};

// ============================================================
// ADMIN
// ============================================================

const ADMIN_USERNAME = 'Admin';

// ============================================================
// VALIDASI CHANNEL
// ============================================================

function validChannel(channel) {
    return Object.prototype.hasOwnProperty.call(channels, channel);
}

// ============================================================
// BROADCAST CHANNEL
// ============================================================

function broadcastChannel(channel) {
    if (!validChannel(channel)) return;

    io.to(`channel:${channel}`).emit(
        'receive_history',
        channels[channel]
    );
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', (socket) => {

    console.log('User terhubung:', socket.id);

    // --------------------------------------------------------
    // DATA USER
    // --------------------------------------------------------

    let currentChannel = 'umum';
    const userId = socket.id;

    // --------------------------------------------------------
    // MASUK CHANNEL DEFAULT
    // --------------------------------------------------------

    socket.join(`channel:${currentChannel}`);

    socket.emit(
        'receive_history',
        channels[currentChannel]
    );

    // --------------------------------------------------------
    // PROFILE DEFAULT
    // --------------------------------------------------------

    socket.emit('set_user_profile', {
        id: userId
    });

    // ========================================================
    // SWITCH CHANNEL
    // ========================================================

    socket.on('switch_channel', (channel) => {

        if (!validChannel(channel)) return;

        // keluar dari channel lama
        socket.leave(`channel:${currentChannel}`);

        // ganti channel
        currentChannel = channel;

        // masuk channel baru
        socket.join(`channel:${currentChannel}`);

        // kirim history channel
        socket.emit(
            'receive_history',
            channels[currentChannel]
        );

        console.log(
            'User',
            socket.id,
            'pindah ke channel',
            currentChannel
        );
    });

    // ========================================================
    // USER PROFILE
    // ========================================================

    socket.on('set_user_profile', (profile) => {

        if (!profile) return;

        const username =
            typeof profile.username === 'string'
                ? profile.username.trim()
                : '';

        const avatar =
            typeof profile.avatar === 'string'
                ? profile.avatar
                : '';

        onlineUsers[socket.id] = {
            username: username || 'User',
            avatar: avatar || ''
        };

        socket.username = username || 'User';
        socket.avatar = avatar || '';

        io.emit('update_users', onlineUsers);
    });

    // ========================================================
    // REGISTER USER
    // ========================================================

    socket.on('register_user', (profile) => {

        if (!profile) return;

        const username =
            typeof profile.username === 'string'
                ? profile.username.trim()
                : '';

        const avatar =
            typeof profile.avatar === 'string'
                ? profile.avatar
                : '';

        socket.username = username || 'User';
        socket.avatar = avatar || '';

        onlineUsers[socket.id] = {
            username: socket.username,
            avatar: socket.avatar
        };

        io.emit('update_users', onlineUsers);
    });

    // ========================================================
    // SEND MESSAGE
    // ========================================================

    socket.on('send_message', (message) => {

        if (!message) return;

        if (!validChannel(currentChannel)) return;

        // Pastikan object
        if (typeof message !== 'object') return;

        // ----------------------------------------------------
        // ID
        // ----------------------------------------------------

        if (!message.id) {
            message.id =
                Date.now().toString() +
                '-' +
                Math.random().toString(36).substring(2, 9);
        }

        // ----------------------------------------------------
        // DATA USER
        // ----------------------------------------------------

        if (!message.username) {
            message.username = socket.username || 'User';
        }

        if (!message.avatar) {
            message.avatar = socket.avatar || '';
        }

        // ----------------------------------------------------
        // TIMESTAMP
        // ----------------------------------------------------

        if (!message.timestamp) {
            message.timestamp = Date.now();
        }

        // ----------------------------------------------------
        // CHANNEL
        // ----------------------------------------------------

        message.channel = currentChannel;

        // ----------------------------------------------------
        // SIMPAN
        // ----------------------------------------------------

        channels[currentChannel].push(message);

        saveChannels();

        // ----------------------------------------------------
        // KIRIM KE CHANNEL
        // ----------------------------------------------------

        io.to(`channel:${currentChannel}`).emit(
            'receive_message',
            message
        );
    });

    // ========================================================
    // EDIT MESSAGE
    // ========================================================

    socket.on('edit_message', (data) => {

        if (!data) return;

        const {
            messageId,
            newText
        } = data;

        if (!messageId) return;

        if (typeof newText !== 'string') return;

        if (!validChannel(currentChannel)) return;

        const message =
            channels[currentChannel].find(
                msg => msg.id === messageId
            );

        if (!message) return;

        // ----------------------------------------------------
        // Hanya pemilik pesan yang boleh edit
        // ----------------------------------------------------

        if (
            message.username !==
            (socket.username || 'User')
        ) {
            return;
        }

        message.text = newText;
        message.edited = true;

        saveChannels();

        io.to(`channel:${currentChannel}`).emit(
            'message_edited',
            {
                messageId: messageId,
                newText: newText
            }
        );
    });

    // ========================================================
    // DELETE MESSAGE
    // ========================================================

    socket.on('delete_message', (messageId) => {

        if (!messageId) return;

        if (!validChannel(currentChannel)) return;

        const index =
            channels[currentChannel].findIndex(
                msg => msg.id === messageId
            );

        if (index === -1) return;

        const message =
            channels[currentChannel][index];

        // ----------------------------------------------------
        // Pemilik pesan atau Admin
        // ----------------------------------------------------

        const currentUsername =
            socket.username || 'User';

        if (
            message.username !== currentUsername &&
            currentUsername !== ADMIN_USERNAME
        ) {
            return;
        }

        channels[currentChannel].splice(index, 1);

        saveChannels();

        io.to(`channel:${currentChannel}`).emit(
            'message_deleted',
            messageId
        );
    });

    // ========================================================
    // CLEAR ALL CHAT
    // ========================================================

    socket.on('clear_all_chat', () => {

        const currentUsername =
            socket.username || 'User';

        // Hanya Admin
        if (currentUsername !== ADMIN_USERNAME) {
            return;
        }

        if (!validChannel(currentChannel)) return;

        channels[currentChannel] = [];

        saveChannels();

        io.to(`channel:${currentChannel}`).emit(
            'receive_history',
            []
        );
    });

    // ========================================================
    // REACTION
    // ========================================================

    socket.on('add_reaction', (data) => {

        if (!data) return;

        const {
            messageId,
            emoji
        } = data;

        if (!messageId || !emoji) return;

        if (!validChannel(currentChannel)) return;

        const message =
            channels[currentChannel].find(
                msg => msg.id === messageId
            );

        if (!message) return;

        // ----------------------------------------------------
        // Buat reactions jika belum ada
        // ----------------------------------------------------

        if (!message.reactions) {
            message.reactions = {};
        }

        if (!message.reactions[emoji]) {
            message.reactions[emoji] = [];
        }

        const username =
            socket.username || 'User';

        const users =
            message.reactions[emoji];

        // ----------------------------------------------------
        // Toggle reaction
        // ----------------------------------------------------

        const existingIndex =
            users.indexOf(username);

        if (existingIndex !== -1) {

            users.splice(existingIndex, 1);

        } else {

            users.push(username);
        }

        // ----------------------------------------------------
        // Hapus emoji kalau kosong
        // ----------------------------------------------------

        if (users.length === 0) {
            delete message.reactions[emoji];
        }

        saveChannels();

        io.to(`channel:${currentChannel}`).emit(
            'reaction_updated',
            {
                messageId: messageId,
                reactions: message.reactions || {}
            }
        );
    });

    // ========================================================
    // TYPING
    // ========================================================

    socket.on('typing', () => {

        socket.to(`channel:${currentChannel}`).emit(
            'display_typing',
            {
                username: socket.username || 'User'
            }
        );
    });

    // ========================================================
    // STOP TYPING
    // ========================================================

    socket.on('stop_typing', () => {

        socket.to(`channel:${currentChannel}`).emit(
            'hide_typing',
            {
                username: socket.username || 'User'
            }
        );
    });

    // ========================================================
    // DISCONNECT
    // ========================================================

    socket.on('disconnect', () => {

        console.log(
            'User terputus:',
            socket.id
        );

        delete onlineUsers[socket.id];

        io.emit(
            'update_users',
            onlineUsers
        );
    });
});

// ============================================================
// SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {

    console.log(
        `Server Node.js berjalan di port ${PORT}`
    );

    console.log(
        `Database chat: ${DATA_FILE}`
    );
});
