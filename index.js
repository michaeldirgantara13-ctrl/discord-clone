const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// LOKASI DATA PERMANEN
// ============================================================
//
// Kalau kamu sudah pasang Railway Volume, Railway otomatis
// menyediakan environment variable RAILWAY_VOLUME_MOUNT_PATH
// yang menunjuk ke folder permanen tersebut. Kalau belum ada
// Volume, data akan tetap tersimpan di folder project seperti
// biasa, tapi BISA HILANG setiap kali Railway redeploy/restart.

const DATA_DIR =
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    __dirname;

function ensureDir(dir) {

    if (!fs.existsSync(dir)) {

        fs.mkdirSync(
            dir,
            { recursive: true }
        );
    }
}

ensureDir(DATA_DIR);

const DATA_FILE =
    path.join(
        DATA_DIR,
        'chat-data.json'
    );

// ============================================================
// FOLDER UPLOAD GAMBAR (terpisah dari chat-data.json,
// supaya file data tidak membengkak oleh base64)
// ============================================================

const UPLOAD_DIR =
    path.join(DATA_DIR, 'uploads');

const AVATAR_DIR =
    path.join(UPLOAD_DIR, 'avatars');

const IMAGE_DIR =
    path.join(UPLOAD_DIR, 'images');

ensureDir(UPLOAD_DIR);
ensureDir(AVATAR_DIR);
ensureDir(IMAGE_DIR);

app.use(
    '/uploads',
    express.static(UPLOAD_DIR)
);

const MAX_AVATAR_BYTES = 1 * 1024 * 1024;   // 1MB
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;    // 4MB

// Simpan data URL base64 (data:image/...;base64,....) sebagai
// file di disk. Nama file dari hash isinya, jadi gambar yang
// sama tidak disimpan berkali-kali (hemat tempat).
function saveBase64File(
    dataUrl,
    dir,
    urlPrefix,
    maxBytes
) {

    if (typeof dataUrl !== 'string') {
        return null;
    }

    const match =
        dataUrl.match(
            /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i
        );

    if (!match) {
        return null;
    }

    const ext =
        match[1].toLowerCase() === 'jpg'
            ? 'jpeg'
            : match[1].toLowerCase();

    let buffer;

    try {

        buffer =
            Buffer.from(
                match[2],
                'base64'
            );

    } catch (e) {

        return null;
    }

    if (buffer.length > maxBytes) {

        return { error: 'too_large' };
    }

    const hash =
        crypto
            .createHash('sha1')
            .update(buffer)
            .digest('hex');

    const filename =
        `${hash}.${ext}`;

    const filePath =
        path.join(dir, filename);

    if (!fs.existsSync(filePath)) {

        fs.writeFileSync(
            filePath,
            buffer
        );
    }

    return {
        url: `${urlPrefix}/${filename}`
    };
}

// ============================================================
// DEFAULT DATA
// ============================================================

const DEFAULT_CHANNELS = {
    umum: [],
    gaming: [],
    musik: []
};

// ============================================================
// LOAD DATA
// ============================================================

function loadChannels() {

    try {

        if (!fs.existsSync(DATA_FILE)) {

            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(
                    DEFAULT_CHANNELS,
                    null,
                    2
                ),
                'utf8'
            );

            console.log(
                'chat-data.json dibuat.'
            );

            return {
                umum: [],
                gaming: [],
                musik: []
            };
        }

        const raw =
            fs.readFileSync(
                DATA_FILE,
                'utf8'
            );

        const data =
            JSON.parse(raw);

        // Pastikan semua channel tetap ada
        return {
            umum: Array.isArray(data.umum)
                ? data.umum
                : [],

            gaming: Array.isArray(data.gaming)
                ? data.gaming
                : [],

            musik: Array.isArray(data.musik)
                ? data.musik
                : []
        };

    } catch (error) {

        console.error(
            'Gagal membaca chat-data.json:',
            error
        );

        return {
            umum: [],
            gaming: [],
            musik: []
        };
    }
}

// ============================================================
// SAVE DATA
// ============================================================

function saveChannels() {

    try {

        const tempFile =
            DATA_FILE + '.tmp';

        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                channels,
                null,
                2
            ),
            'utf8'
        );

        fs.renameSync(
            tempFile,
            DATA_FILE
        );

    } catch (error) {

        console.error(
            'Gagal menyimpan chat:',
            error
        );
    }
}

// ============================================================
// CHANNEL DATA
// ============================================================

const channels = loadChannels();

// ============================================================
// ONLINE USERS
// ============================================================

const onlineUsers = {};

// ============================================================
// ADMIN
// ============================================================

const ADMIN_USERNAME = 'Admin';

// PENTING: ganti ini lewat environment variable ADMIN_PASSWORD
// di Railway (tab Variables), jangan andalkan nilai default ini.
const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    'ganti-password-ini';

// ============================================================
// HELPER
// ============================================================

function validChannel(channel) {

    return (
        typeof channel === 'string' &&
        Object.prototype.hasOwnProperty.call(
            channels,
            channel
        )
    );
}

function broadcastChannel(
    channel,
    event = 'receive_history'
) {

    if (!validChannel(channel)) {
        return;
    }

    io
        .to(`channel:${channel}`)
        .emit(
            event,
            channels[channel]
        );
}

// ============================================================
// SOCKET CONNECTION
// ============================================================

io.on('connection', (socket) => {

    socket.currentChannel = 'umum';

    // ID sementara (fallback sebelum clientId permanen diterima)
    socket.userId = socket.id;

    socket.join('channel:umum');

    console.log(
        'User terhubung:',
        socket.id
    );

    // Kirim history channel umum
    socket.emit(
        'receive_history',
        channels.umum
    );

    // Kirim juga daftar user online saat ini,
    // supaya tidak sempat kelihatan 0 kalau
    // ada delay saat registrasi profil.
    socket.emit(
        'update_users',
        Object.values(
            onlineUsers
        )
    );

    // ========================================================
    // SET USER PROFILE
    // ========================================================

    socket.on(
        'set_user_profile',
        (profile = {}) => {

            const username =
                String(
                    profile.username || 'User'
                )
                .trim()
                .slice(0, 50);

            let avatar =
                'https://via.placeholder.com/40';

            if (
                typeof profile.avatar === 'string' &&
                profile.avatar.startsWith('data:')
            ) {

                // Foto baru diunggah (base64) -> simpan
                // sebagai file, bukan disimpan mentah.
                const saved =
                    saveBase64File(
                        profile.avatar,
                        AVATAR_DIR,
                        '/uploads/avatars',
                        MAX_AVATAR_BYTES
                    );

                if (saved?.url) {

                    avatar = saved.url;

                } else if (
                    saved?.error === 'too_large'
                ) {

                    socket.emit(
                        'avatar_rejected',
                        { reason: 'too_large' }
                    );
                }

            } else if (
                typeof profile.avatar === 'string' &&
                profile.avatar.startsWith('/uploads/')
            ) {

                // Sudah berupa URL dari sesi sebelumnya
                // (disimpan di localStorage browser).
                avatar = profile.avatar;

            } else if (
                typeof profile.avatar === 'string' &&
                profile.avatar.startsWith('http')
            ) {

                avatar = profile.avatar;
            }

            // clientId permanen dari localStorage browser.
            // Ini yang dipakai untuk kepemilikan pesan,
            // supaya tetap valid walau socket reconnect
            // dan mendapat socket.id baru.
            const clientId =
                typeof profile.clientId === 'string' &&
                profile.clientId.trim()
                    ? profile.clientId.trim().slice(0, 100)
                    : socket.id;

            socket.clientId = clientId;
            socket.userId = clientId;

            onlineUsers[socket.id] = {

                userId:
                    clientId,

                username:
                    username,

                avatar:
                    avatar
            };

            // Beritahu pengirim URL avatar final-nya,
            // supaya browser bisa simpan URL itu (bukan
            // base64) untuk sesi berikutnya.
            socket.emit(
                'profile_registered',
                { avatar: avatar }
            );

            io.emit(
                'update_users',
                Object.values(
                    onlineUsers
                )
            );

            console.log(
                'Profile:',
                username,
                '| clientId:',
                clientId
            );
        }
    );

    // ========================================================
    // SWITCH CHANNEL
    // ========================================================

    socket.on(
        'switch_channel',
        (channel) => {

            if (
                !validChannel(channel)
            ) {
                return;
            }

            if (
                socket.currentChannel ===
                channel
            ) {

                socket.emit(
                    'receive_history',
                    channels[channel]
                );

                return;
            }

            socket.leave(
                `channel:${socket.currentChannel}`
            );

            socket.currentChannel =
                channel;

            socket.join(
                `channel:${channel}`
            );

            socket.emit(
                'receive_history',
                channels[channel]
            );
        }
    );

    // ========================================================
    // SEND MESSAGE
    // ========================================================

    socket.on(
        'send_message',
        (data = {}) => {

            const channel =
                socket.currentChannel;

            if (
                !validChannel(channel)
            ) {
                return;
            }

            // ANTI-SPAM: batasi 1 pesan per 400ms per koneksi.
            const now = Date.now();

            if (
                socket.lastMessageAt &&
                now - socket.lastMessageAt < 400
            ) {

                return;
            }

            socket.lastMessageAt = now;

            const profile =
                onlineUsers[socket.id];

            const sender =
                profile?.username ||
                'User';

            const avatar =
                profile?.avatar ||
                'https://via.placeholder.com/40';

            const replyTo =
                data.replyTo ||
                null;

            // Pastikan reply memang ada
            if (
                replyTo &&
                !channels[channel].some(
                    m => m.id === replyTo
                )
            ) {
                return;
            }

            // Simpan gambar sebagai file terpisah,
            // bukan base64 mentah di chat-data.json.
            let imageUrl = null;

            if (
                typeof data.image === 'string' &&
                data.image.startsWith('data:')
            ) {

                const saved =
                    saveBase64File(
                        data.image,
                        IMAGE_DIR,
                        '/uploads/images',
                        MAX_IMAGE_BYTES
                    );

                if (saved?.url) {

                    imageUrl = saved.url;

                } else if (
                    saved?.error === 'too_large'
                ) {

                    socket.emit(
                        'message_rejected',
                        { reason: 'image_too_large' }
                    );

                    return;

                } else {

                    socket.emit(
                        'message_rejected',
                        { reason: 'invalid_image' }
                    );

                    return;
                }
            }

            const newMessage = {

                id:
                    `${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 10)}`,

                userId:
                    socket.clientId || socket.userId,

                sender:
                    sender,

                avatar:
                    avatar,

                original:
                    String(
                        data.original || ''
                    ).slice(0, 5000),

                image:
                    imageUrl,

                replyTo:
                    replyTo,

                reactions:
                    {},

                edited:
                    false
            };

            if (
                !newMessage.original &&
                !newMessage.image
            ) {
                return;
            }

            channels[channel].push(
                newMessage
            );

            // SIMPAN
            saveChannels();

            broadcastChannel(
                channel
            );
        }
    );

    // ========================================================
    // EDIT MESSAGE
    // ========================================================

    socket.on(
        'edit_message',
        (data = {}) => {

            const list =
                channels[
                    socket.currentChannel
                ];

            const msg =
                list?.find(
                    m => m.id === data.id
                );

            if (!msg) {
                return;
            }

            // Hanya pemilik
            if (
                msg.userId !==
                (socket.clientId || socket.userId)
            ) {

                console.log(
                    'Edit ditolak:',
                    socket.id
                );

                return;
            }

            const newText =
                String(
                    data.newText || ''
                )
                .trim()
                .slice(0, 5000);

            if (!newText) {
                return;
            }

            msg.original =
                newText;

            msg.edited =
                true;

            // SIMPAN
            saveChannels();

            broadcastChannel(
                socket.currentChannel,
                'message_edited'
            );
        }
    );

    // ========================================================
    // DELETE MESSAGE
    // ========================================================

    socket.on(
        'delete_message',
        (id) => {

            const list =
                channels[
                    socket.currentChannel
                ];

            if (!list) {
                return;
            }

            const index =
                list.findIndex(
                    m => m.id === id
                );

            if (index < 0) {
                return;
            }

            const msg =
                list[index];

            // Hanya pemilik
            if (
                msg.userId !==
                (socket.clientId || socket.userId)
            ) {

                console.log(
                    'Delete ditolak:',
                    socket.id
                );

                return;
            }

            list.splice(
                index,
                1
            );

            // Hapus reply yang menunjuk
            // ke pesan yang sudah dihapus
            list.forEach(
                m => {

                    if (
                        m.replyTo === id
                    ) {
                        m.replyTo = null;
                    }

                }
            );

            // SIMPAN
            saveChannels();

            broadcastChannel(
                socket.currentChannel,
                'message_deleted'
            );
        }
    );

    // ========================================================
    // CLEAR ALL CHAT
    // ========================================================

    socket.on(
        'clear_all_chat',
        (payload = {}) => {

            const profile =
                onlineUsers[socket.id];

            if (!profile) {
                return;
            }

            // Hanya admin
            if (
                profile.username !==
                ADMIN_USERNAME
            ) {

                console.log(
                    'Clear chat ditolak (bukan admin):',
                    profile.username
                );

                socket.emit(
                    'clear_chat_denied'
                );

                return;
            }

            const passwordGiven =
                typeof payload === 'string'
                    ? payload
                    : payload?.password;

            if (
                passwordGiven !==
                ADMIN_PASSWORD
            ) {

                console.log(
                    'Clear chat ditolak (password salah):',
                    profile.username
                );

                socket.emit(
                    'clear_chat_denied'
                );

                return;
            }

            const channel =
                socket.currentChannel;

            if (
                !validChannel(channel)
            ) {
                return;
            }

            channels[channel] =
                [];

            // SIMPAN
            saveChannels();

            broadcastChannel(
                channel
            );

            console.log(
                'CHAT DIHAPUS ADMIN:',
                profile.username,
                channel
            );
        }
    );

    // ========================================================
    // REACTION
    // ========================================================

    socket.on(
        'add_reaction',
        ({ id, emoji } = {}) => {

            const list =
                channels[
                    socket.currentChannel
                ];

            const msg =
                list?.find(
                    m => m.id === id
                );

            const user =
                onlineUsers[socket.id];

            if (
                !msg ||
                !user ||
                typeof emoji !== 'string' ||
                emoji.length > 10
            ) {
                return;
            }

            if (!msg.reactions) {
                msg.reactions = {};
            }

            if (
                !msg.reactions[emoji]
            ) {
                msg.reactions[emoji] =
                    [];
            }

            const users =
                msg.reactions[emoji];

            const pos =
                users.indexOf(
                    user.username
                );

            if (pos >= 0) {

                users.splice(
                    pos,
                    1
                );

            } else {

                users.push(
                    user.username
                );
            }

            if (
                users.length === 0
            ) {

                delete msg.reactions[
                    emoji
                ];
            }

            // SIMPAN
            saveChannels();

            broadcastChannel(
                socket.currentChannel,
                'reaction_updated'
            );
        }
    );

    // ========================================================
    // TYPING
    // ========================================================

    socket.on(
        'typing',
        (username) => {

            socket
                .to(
                    `channel:${socket.currentChannel}`
                )
                .emit(
                    'display_typing',
                    username
                );
        }
    );

    socket.on(
        'stop_typing',
        () => {

            socket
                .to(
                    `channel:${socket.currentChannel}`
                )
                .emit(
                    'hide_typing'
                );
        }
    );

    // ========================================================
    // DISCONNECT
    // ========================================================

    socket.on(
        'disconnect',
        () => {

            const profile =
                onlineUsers[socket.id];

            if (profile) {

                console.log(
                    'User terputus:',
                    profile.username
                );
            }

            delete onlineUsers[
                socket.id
            ];

            io.emit(
                'update_users',
                Object.values(
                    onlineUsers
                )
            );
        }
    );
});

// ============================================================
// START SERVER
// ============================================================

const PORT =
    process.env.PORT || 3000;

http.listen(
    PORT,
    () => {

        console.log(
            `Server Node.js berjalan di port ${PORT}`
        );

        console.log(
            'Database chat:',
            DATA_FILE
        );
    }
);
