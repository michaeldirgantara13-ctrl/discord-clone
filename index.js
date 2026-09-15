const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push'); // <-- TAMBAHAN UNTUK PUSH NOTIFICATION

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// WEB PUSH CONFIGURATION
// ============================================================
const vapidKeys = webpush.generateVAPIDKeys();
const PUBLIC_VAPID_KEY = process.env.VAPID_PUBLIC_KEY || vapidKeys.publicKey;
const PRIVATE_VAPID_KEY = process.env.VAPID_PRIVATE_KEY || vapidKeys.privateKey;

webpush.setVapidDetails(
    'mailto:admin@example.com',
    PUBLIC_VAPID_KEY,
    PRIVATE_VAPID_KEY
);

const pushSubscriptions = {};

// ============================================================
// LOKASI DATA PERMANEN
// ============================================================
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
// FOLDER UPLOAD GAMBAR
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

const channels = loadChannels();
const onlineUsers = {};

// ============================================================
// VOICE CHANNEL
// ============================================================
const VOICE_CHANNEL_DEFS = [
    { id: 'voice-room', name: 'Voice Room', inviteOnly: true }
];

const INVITE_ONLY_VOICE_CHANNELS = new Set(
    VOICE_CHANNEL_DEFS
        .filter(def => def.inviteOnly)
        .map(def => def.id)
);

const voiceRoomInvites = new Set();
const VOICE_INVITE_EXPIRY_MS = 2 * 60 * 1000;
const voiceChannels = {};

VOICE_CHANNEL_DEFS.forEach(function(def) {
    voiceChannels[def.id] = {};
});

function isValidVoiceChannel(channelId) {
    return (
        typeof channelId === 'string' &&
        Object.prototype.hasOwnProperty.call(
            voiceChannels,
            channelId
        )
    );
}

function buildVoiceState() {
    const state = {};

    Object.keys(voiceChannels).forEach(
        function(channelId) {
            state[channelId] =
                Object.entries(
                    voiceChannels[channelId]
                ).map(
                    function([socketId, info]) {
                        return {
                            socketId: socketId,
                            userId: info.userId,
                            username: info.username,
                            avatar: info.avatar,
                            muted: Boolean(info.muted)
                        };
                    }
                );
        }
    );

    return state;
}

function broadcastVoiceState() {
    io.emit(
        'voice_state',
        buildVoiceState()
    );
}

function removeFromVoiceChannel(socket) {
    const channelId =
        socket.voiceChannel;

    if (
        !channelId ||
        !voiceChannels[channelId]
    ) {
        return;
    }

    delete voiceChannels[channelId][
        socket.id
    ];

    socket.leave(
        `voice:${channelId}`
    );

    socket
        .to(`voice:${channelId}`)
        .emit(
            'voice_peer_left',
            { socketId: socket.id }
        );

    socket.voiceChannel = null;
}

// ============================================================
// REGISTRY ANGGOTA
// ============================================================
const MEMBERS_FILE =
    path.join(
        DATA_DIR,
        'members.json'
    );

function loadMembers() {
    try {
        if (
            fs.existsSync(MEMBERS_FILE)
        ) {
            return JSON.parse(
                fs.readFileSync(
                    MEMBERS_FILE,
                    'utf8'
                )
            );
        }
    } catch (e) {
        console.error(
            'Gagal load members:',
            e
        );
    }

    return {};
}

function saveMembers() {
    try {
        fs.writeFileSync(
            MEMBERS_FILE,
            JSON.stringify(
                registeredMembers,
                null,
                2
            )
        );
    } catch (e) {
        console.error(
            'Gagal simpan members:',
            e
        );
    }
}

const registeredMembers =
    loadMembers();

// ============================================================
// DAFTAR BLOKIR
// ============================================================
const BLOCKED_FILE =
    path.join(
        DATA_DIR,
        'blocked-users.json'
    );

function loadBlocked() {
    try {
        if (
            fs.existsSync(BLOCKED_FILE)
        ) {
            const parsed =
                JSON.parse(
                    fs.readFileSync(
                        BLOCKED_FILE,
                        'utf8'
                    )
                );

            if (
                parsed &&
                !parsed.byClientId &&
                !parsed.byIp
            ) {
                return {
                    byClientId: parsed,
                    byIp: {}
                };
            }

            return {
                byClientId:
                    parsed.byClientId || {},
                byIp:
                    parsed.byIp || {}
            };
        }
    } catch (e) {
        console.error(
            'Gagal load blocked:',
            e
        );
    }

    return {
        byClientId: {},
        byIp: {}
    };
}

function saveBlocked() {
    try {
        fs.writeFileSync(
            BLOCKED_FILE,
            JSON.stringify(
                blockedData,
                null,
                2
            )
        );
    } catch (e) {
        console.error(
            'Gagal simpan blocked:',
            e
        );
    }
}

const blockedData =
    loadBlocked();

function isIdentityBlocked(
    clientId,
    ip
) {
    return Boolean(
        (
            clientId &&
            blockedData.byClientId[clientId]
        ) ||
        (
            ip &&
            blockedData.byIp[ip]
        )
    );
}

function blockIdentity(
    clientId,
    ip,
    username
) {
    blockedData.byClientId[clientId] = {
        username:
            username,

        ip:
            ip || null,

        blockedAt:
            Date.now()
    };

    if (ip) {
        blockedData.byIp[ip] = {
            username:
                username,

            clientId:
                clientId,

            blockedAt:
                Date.now()
        };
    }

    saveBlocked();
}

function unblockIdentity(clientId) {
    const entry =
        blockedData.byClientId[clientId];

    if (entry?.ip) {
        delete blockedData.byIp[
            entry.ip
        ];
    }

    delete blockedData.byClientId[
        clientId
    ];

    saveBlocked();
}

function buildFullMemberList() {
    const onlineByClientId = {};

    Object.values(onlineUsers).forEach(
        function(u) {
            onlineByClientId[u.userId] = u;
        }
    );

    const list =
        Object.entries(registeredMembers)
            .map(
                function([clientId, info]) {
                    const onlineInfo =
                        onlineByClientId[clientId];

                    return {
                        clientId:
                            clientId,

                        username:
                            onlineInfo?.username ||
                            info.username,

                        avatar:
                            onlineInfo?.avatar ||
                            info.avatar,

                        online:
                            Boolean(onlineInfo),

                        blocked:
                            Boolean(
                                blockedData.byClientId[
                                    clientId
                                ]
                            )
                    };
                }
            );

    list.sort(
        function(a, b) {
            if (a.online !== b.online) {
                return a.online ? -1 : 1;
            }

            return a.username.localeCompare(
                b.username
            );
        }
    );

    return list;
}

function broadcastMemberStats() {
    const onlineClientIds =
        new Set(
            Object.values(onlineUsers)
                .map(u => u.userId)
        );

    io.emit(
        'update_users',
        {
            list:
                buildFullMemberList(),

            onlineCount:
                onlineClientIds.size,

            totalCount:
                Math.max(
                    Object.keys(
                        registeredMembers
                    ).length,
                    onlineClientIds.size
                )
        }
    );
}

// ============================================================
// ADMIN
// ============================================================
const ADMIN_USERNAME =
    process.env.ADMIN_USERNAME ||
    'Admin';

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
    socket.userId = socket.id;

    const forwardedFor =
        socket.handshake.headers['x-forwarded-for'];

    const rawIp =
        (
            typeof forwardedFor === 'string' &&
            forwardedFor.split(',')[0].trim()
        ) ||
        socket.handshake.address ||
        '';

    socket.clientIp =
        rawIp.replace('::ffff:', '');

    socket.isBlocked =
        isIdentityBlocked(
            null,
            socket.clientIp
        );

    socket.join('channel:umum');

    // <-- TAMBAHAN KIRIM KUNCI VAPID & MENANGKAP SUBSCRIPTION PUSH
    socket.emit('vapid_public_key', PUBLIC_VAPID_KEY);

    socket.on('subscribe_push', (subscription) => {
        const userId = socket.clientId || socket.userId;
        if (userId && subscription) {
            pushSubscriptions[userId] = subscription;
        }
    });

    if (socket.isBlocked) {
        socket.emit(
            'you_are_blocked'
        );
    } else {
        socket.emit(
            'receive_history',
            channels.umum
        );
    }

    {
        const onlineClientIds =
            new Set(
                Object.values(onlineUsers)
                    .map(u => u.userId)
            );

        socket.emit(
            'update_users',
            {
                list:
                    buildFullMemberList(),

                onlineCount:
                    onlineClientIds.size,

                totalCount:
                    Math.max(
                        Object.keys(
                            registeredMembers
                        ).length,
                        onlineClientIds.size
                    )
            }
        );
    }

    socket.emit(
        'voice_state',
        buildVoiceState()
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

            const clientId =
                typeof profile.clientId === 'string' &&
                profile.clientId.trim()
                    ? profile.clientId.trim().slice(0, 100)
                    : socket.id;

            socket.clientId = clientId;
            socket.userId = clientId;

            if (
                isIdentityBlocked(
                    clientId,
                    socket.clientIp
                )
            ) {
                socket.isBlocked = true;

                socket.emit(
                    'you_are_blocked'
                );

                return;
            }

            socket.isBlocked = false;

            let avatar =
                'https://via.placeholder.com/40';

            if (
                typeof profile.avatar === 'string' &&
                profile.avatar.startsWith('data:')
            ) {
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
                avatar = profile.avatar;
            } else if (
                typeof profile.avatar === 'string' &&
                profile.avatar.startsWith('http')
            ) {
                avatar = profile.avatar;
            }

            onlineUsers[socket.id] = {
                userId:
                    clientId,

                username:
                    username,

                avatar:
                    avatar
            };

            registeredMembers[clientId] = {
                username:
                    username,

                avatar:
                    avatar,

                firstSeen:
                    registeredMembers[clientId]?.firstSeen ||
                    Date.now(),

                lastSeen:
                    Date.now(),

                lastIp:
                    socket.clientIp || null
            };

            saveMembers();

            socket.emit(
                'profile_registered',
                {
                    avatar: avatar,
                    isAdmin: username === ADMIN_USERNAME
                }
            );

            socket.emit(
                'receive_history',
                channels[socket.currentChannel] || []
            );

            broadcastMemberStats();
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

            if (socket.isBlocked) {
                socket.emit(
                    'you_are_blocked'
                );

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

            if (socket.isBlocked) {
                socket.emit(
                    'message_rejected',
                    { reason: 'blocked' }
                );

                return;
            }

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

            if (
                replyTo &&
                !channels[channel].some(
                    m => m.id === replyTo
                )
            ) {
                return;
            }

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

            saveChannels();

            broadcastChannel(
                channel
            );

            // <-- TAMBAHAN TRIGGER WEB PUSH KE USER LAIN
            Object.entries(onlineUsers).forEach(([sid, user]) => {
                if (user.userId !== (socket.clientId || socket.userId)) {
                    const sub = pushSubscriptions[user.userId];
                    if (sub) {
                        const payload = JSON.stringify({
                            title: `${sender} di #${channel}`,
                            body: newMessage.original || '[Mengirim Gambar]',
                            url: '/'
                        });
                        webpush.sendNotification(sub, payload).catch(() => {});
                    }
                }
            });
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

            if (
                msg.userId !==
                (socket.clientId || socket.userId)
            ) {
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

            if (
                msg.userId !==
                (socket.clientId || socket.userId)
            ) {
                return;
            }

            list.splice(
                index,
                1
            );

            list.forEach(
                m => {
                    if (
                        m.replyTo === id
                    ) {
                        m.replyTo = null;
                    }
                }
            );

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

            if (
                profile.username !==
                ADMIN_USERNAME
            ) {
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

            saveChannels();

            broadcastChannel(
                channel
            );
        }
    );

    // ========================================================
    // BLOKIR / BUKA BLOKIR USER
    // ========================================================
    socket.on(
        'block_user',
        (payload = {}) => {
            const profile =
                onlineUsers[socket.id];

            if (
                !profile ||
                profile.username !== ADMIN_USERNAME
            ) {
                socket.emit(
                    'clear_chat_denied'
                );

                return;
            }

            if (
                payload.password !==
                ADMIN_PASSWORD
            ) {
                socket.emit(
                    'clear_chat_denied'
                );

                return;
            }

            const targetUserId =
                String(
                    payload.targetUserId || ''
                );

            if (!targetUserId) {
                return;
            }

            if (
                targetUserId === socket.clientId
            ) {
                return;
            }

            const targetUsername =
                String(
                    payload.targetUsername || 'User'
                ).slice(0, 50);

            const targetIp =
                registeredMembers[targetUserId]?.lastIp ||
                null;

            blockIdentity(
                targetUserId,
                targetIp,
                targetUsername
            );

            for (
                const sid
                of Object.keys(onlineUsers)
            ) {
                if (
                    onlineUsers[sid].userId ===
                    targetUserId
                ) {
                    const targetSocket =
                        io.sockets.sockets.get(sid);

                    if (targetSocket) {
                        targetSocket.isBlocked = true;

                        targetSocket.emit(
                            'you_are_blocked'
                        );
                    }
                }
            }

            broadcastMemberStats();
        }
    );

    socket.on(
        'unblock_user',
        (payload = {}) => {
            const profile =
                onlineUsers[socket.id];

            if (
                !profile ||
                profile.username !== ADMIN_USERNAME
            ) {
                socket.emit(
                    'clear_chat_denied'
                );

                return;
            }

            if (
                payload.password !==
                ADMIN_PASSWORD
            ) {
                socket.emit(
                    'clear_chat_denied'
                );

                return;
            }

            const targetUserId =
                String(
                    payload.targetUserId || ''
                );

            unblockIdentity(
                targetUserId
            );

            for (
                const sid
                of Object.keys(onlineUsers)
            ) {
                if (
                    onlineUsers[sid].userId ===
                    targetUserId
                ) {
                    const targetSocket =
                        io.sockets.sockets.get(sid);

                    if (targetSocket) {
                        targetSocket.isBlocked = false;
                    }
                }
            }

            broadcastMemberStats();
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

            saveChannels();

            broadcastChannel(
                socket.currentChannel,
                'reaction_updated'
            );
        }
    );

    // ========================================================
    // VOICE CHANNEL
    // ========================================================
    socket.on(
        'voice_join',
        (channelId) => {
            if (socket.isBlocked) {
                return;
            }

            if (
                !isValidVoiceChannel(channelId)
            ) {
                return;
            }

            const profile =
                onlineUsers[socket.id];

            if (!profile) {
                return;
            }

            const userId =
                socket.clientId ||
                socket.userId;

            const isAdminUser =
                profile.username === ADMIN_USERNAME;

            if (
                INVITE_ONLY_VOICE_CHANNELS.has(channelId) &&
                !isAdminUser &&
                !voiceRoomInvites.has(userId)
            ) {
                socket.emit(
                    'voice_join_denied',
                    { channelId: channelId }
                );

                return;
            }

            if (
                INVITE_ONLY_VOICE_CHANNELS.has(channelId)
            ) {
                voiceRoomInvites.delete(userId);
            }

            if (socket.voiceChannel) {
                removeFromVoiceChannel(socket);
            }

            const existingPeers =
                Object.entries(
                    voiceChannels[channelId]
                ).map(
                    function([socketId, info]) {
                        return {
                            socketId: socketId,
                            userId: info.userId,
                            username: info.username,
                            avatar: info.avatar
                        };
                    }
                );

            voiceChannels[channelId][
                socket.id
            ] = {
                userId:
                    socket.clientId ||
                    socket.userId,
                username: profile.username,
                avatar: profile.avatar,
                muted: false
            };

            socket.voiceChannel = channelId;
            socket.join(`voice:${channelId}`);

            socket.emit(
                'voice_joined',
                {
                    channelId: channelId,
                    peers: existingPeers
                }
            );

            broadcastVoiceState();
        }
    );

    socket.on(
        'voice_leave',
        () => {
            if (!socket.voiceChannel) {
                return;
            }

            removeFromVoiceChannel(socket);
            broadcastVoiceState();
        }
    );

    socket.on(
        'voice_signal',
        (payload = {}) => {
            const targetSocketId =
                payload.to;

            if (
                typeof targetSocketId !== 'string'
            ) {
                return;
            }

            io.to(targetSocketId).emit(
                'voice_signal',
                {
                    from: socket.id,
                    data: payload.data
                }
            );
        }
    );

    socket.on(
        'voice_mute',
        (muted) => {
            const channelId =
                socket.voiceChannel;

            if (
                !channelId ||
                !voiceChannels[channelId] ||
                !voiceChannels[channelId][socket.id]
            ) {
                return;
            }

            voiceChannels[channelId][
                socket.id
            ].muted = Boolean(muted);

            broadcastVoiceState();
        }
    );

    socket.on(
        'voice_invite_user',
        (payload = {}) => {
            const profile =
                onlineUsers[socket.id];

            if (
                !profile ||
                profile.username !== ADMIN_USERNAME
            ) {
                socket.emit(
                    'voice_invite_denied'
                );
                return;
            }

            if (
                payload.password !== ADMIN_PASSWORD
            ) {
                socket.emit(
                    'voice_invite_denied'
                );
                return;
            }

            const channelId =
                typeof payload.channelId === 'string'
                    ? payload.channelId
                    : 'voice-room';

            if (
                !INVITE_ONLY_VOICE_CHANNELS.has(channelId)
            ) {
                return;
            }

            const targetUserId =
                String(payload.targetUserId || '');

            if (!targetUserId) {
                return;
            }

            const targetSocketId =
                Object.keys(onlineUsers).find(
                    sid =>
                        onlineUsers[sid].userId ===
                        targetUserId
                );

            if (!targetSocketId) {
                return;
            }

            voiceRoomInvites.add(targetUserId);

            setTimeout(
                function() {
                    voiceRoomInvites.delete(
                        targetUserId
                    );
                },
                VOICE_INVITE_EXPIRY_MS
            );

            const channelDef =
                VOICE_CHANNEL_DEFS.find(
                    def => def.id === channelId
                );

            io.to(targetSocketId).emit(
                'voice_invite',
                {
                    channelId: channelId,
                    channelName:
                        channelDef?.name || channelId,
                    by: profile.username
                }
            );
        }
    );

    socket.on(
        'voice_invite_decline',
        () => {
            const userId =
                socket.clientId ||
                socket.userId;

            voiceRoomInvites.delete(userId);
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
            delete onlineUsers[
                socket.id
            ];

            if (socket.voiceChannel) {
                removeFromVoiceChannel(socket);
                broadcastVoiceState();
            }

            broadcastMemberStats();
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
