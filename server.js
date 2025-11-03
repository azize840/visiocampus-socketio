require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ==================== CONFIGURATION CORS POUR RENDER ====================
const corsOptions = {
    origin: [
        'https://pandurate-squatly-hae.ngrok-free.dev',
        'https://visio-sfu-server-6.onrender.com',
        'https://visio-peerjs-server-4.onrender.com',
        'https://visiocampus-socketio-2.onrender.com',
        'http://localhost:3000',
        'http://localhost:8000',
        'http://localhost:5173'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS']
};

app.use(cors(corsOptions));
app.use(express.json());

// ==================== SOCKET.IO CONFIGURATION ====================
const io = new Server(server, {
    cors: corsOptions,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8,
    perMessageDeflate: false
});

// ==================== STOCKAGE EN MÉMOIRE ====================
const rooms = new Map();
const participants = new Map();

// ==================== FONCTIONS UTILITAIRES ====================

// Vérifier la santé du SFU - VERSION CORRIGÉE
async function checkSFUHealth() {
    try {
        const sfuUrl = process.env.SFU_SERVER_URL || 'https://visio-sfu-server-6.onrender.com';
        console.log('🔍 Vérification santé SFU:', sfuUrl);

        const response = await fetch(`${sfuUrl}/health`, {
            method: 'GET',
            timeout: 5000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        console.log('✅ SFU santé:', data.status);
        return data.status === 'ok' || data.status === 'healthy';

    } catch (error) {
        console.error('❌ SFU health check failed:', error.message);
        return false;
    }
}

// Vérifier la santé du P2P - VERSION CORRIGÉE
async function checkP2PHealth() {
    try {
        const p2pUrl = process.env.PEERJS_SERVER_URL || 'https://visio-peerjs-server-4.onrender.com';
        console.log('🔍 Vérification santé PeerJS:', p2pUrl);

        // ✅ CORRECTION : Utiliser le bon endpoint (racine au lieu de /health)
        const response = await fetch(`${p2pUrl}/`, {
            method: 'GET',
            timeout: 5000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        console.log('✅ PeerJS santé:', data.status);
        return data.status === 'OK' || data.status === 'running';

    } catch (error) {
        console.error('❌ P2P health check failed:', error.message);
        return false;
    }
}

// Déterminer le mode optimal - VERSION AMÉLIORÉE
async function determineOptimalMode(roomId, participantCount) {
    try {
        const [sfuAvailable, p2pAvailable] = await Promise.all([
            checkSFUHealth(),
            checkP2PHealth()
        ]);

        console.log(`🔍 Disponibilité - SFU: ${sfuAvailable}, P2P: ${p2pAvailable}, Participants: ${participantCount}`);

        // ✅ LOGIQUE AMÉLIORÉE
        if (!sfuAvailable && !p2pAvailable) {
            console.log('🚨 Aucun service disponible, forcer P2P local');
            return 'p2p';
        }

        // Si SFU indisponible, forcer P2P
        if (!sfuAvailable) {
            console.log('🔄 SFU indisponible, fallback vers P2P');
            return 'p2p';
        }

        // Si P2P indisponible, forcer SFU
        if (!p2pAvailable) {
            console.log('🔄 P2P indisponible, utilisation SFU');
            return 'sfu';
        }

        // Logique de basculement basée sur le nombre de participants
        if (participantCount >= 10) {
            console.log(`🎯 ${participantCount}+ participants, mode SFU optimal`);
            return 'sfu';
        } else {
            console.log(`🎯 ${participantCount} participants, mode P2P optimal`);
            return 'p2p';
        }

    } catch (error) {
        console.error('❌ Erreur détermination mode:', error);
        // Fallback vers P2P en cas d'erreur
        return 'p2p';
    }
}

// ==================== ROUTES HTTP ====================

// Health check principal
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        service: 'VisioCampus Socket.IO Signaling Server',
        version: '1.0.0',
        system: 'Hybrid P2P/SFU',
        timestamp: new Date().toISOString(),
        rooms: rooms.size,
        participants: participants.size,
        transports: ['websocket', 'polling']
    });
});

// Health check pour Render - VERSION AMÉLIORÉE
app.get('/health', async (req, res) => {
    try {
        const [sfuHealth, p2pHealth] = await Promise.all([
            checkSFUHealth(),
            checkP2PHealth()
        ]);

        res.json({
            status: 'OK',
            service: 'Socket.IO Signaling - VisioCampus',
            timestamp: new Date().toISOString(),
            sfu_available: sfuHealth,
            p2p_available: p2pHealth,
            rooms: rooms.size,
            participants: participants.size,
            connected_sockets: io.sockets.sockets.size
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Status détaillé
app.get('/status', (req, res) => {
    const roomsData = Array.from(rooms.entries()).map(([roomId, room]) => ({
        roomId,
        participants: room.participants.size,
        mode: room.mode,
        createdAt: new Date(room.createdAt).toISOString(),
        participantIds: Array.from(room.participants)
    }));

    const participantsData = Array.from(participants.entries()).map(([socketId, participant]) => ({
        socketId,
        userId: participant.userId,
        userName: participant.userName,
        roomId: participant.roomId,
        joinedAt: new Date(participant.joinedAt).toISOString()
    }));

    res.json({
        status: 'ok',
        server: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            connections: io.sockets.sockets.size
        },
        rooms: roomsData,
        participants: participantsData,
        totals: {
            rooms: rooms.size,
            participants: participants.size,
            connectedSockets: io.sockets.sockets.size
        }
    });
});

// Obtenir les infos SFU pour une room - VERSION AMÉLIORÉE
app.post('/sfu-token', async (req, res) => {
    try {
        const { room_id, participant_id } = req.body;

        if (!room_id || !participant_id) {
            return res.status(400).json({
                success: false,
                error: 'room_id et participant_id requis'
            });
        }

        const sfuUrl = process.env.SFU_SERVER_URL || 'https://visio-sfu-server-6.onrender.com';

        // Vérifier d'abord que le SFU est disponible
        const sfuHealth = await checkSFUHealth();
        if (!sfuHealth) {
            return res.status(503).json({
                success: false,
                error: 'Service SFU temporairement indisponible'
            });
        }

        // Créer la room SFU si elle n'existe pas
        const createRoomResponse = await fetch(`${sfuUrl}/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                room_id,
                max_participants: 50
            })
        });

        if (!createRoomResponse.ok) {
            const errorText = await createRoomResponse.text();
            throw new Error(`Erreur création room SFU: ${createRoomResponse.status} - ${errorText}`);
        }

        // Générer le token
        const tokenResponse = await fetch(`${sfuUrl}/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                room_id,
                participant_id
            })
        });

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            throw new Error(`Erreur génération token SFU: ${tokenResponse.status} - ${errorText}`);
        }

        const tokenData = await tokenResponse.json();

        res.json({
            success: true,
            ...tokenData
        });

    } catch (error) {
        console.error('❌ Erreur SFU token:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
    console.log('✅ Client connecté:', socket.id, 'Transport:', socket.conn.transport.name);

    // Monitor transport upgrades
    socket.conn.on('upgrade', (transport) => {
        console.log('⬆️ Transport upgradé vers:', transport.name, 'pour', socket.id);
    });

    // ========== REJOINDRE UNE ROOM ==========
    socket.on('join-room', async (data) => {
        try {
            const { roomId, userId, userName, userRole = 'participant' } = data;

            if (!roomId || !userId || !userName) {
                socket.emit('error', {
                    event: 'join-room',
                    message: 'roomId, userId et userName sont requis'
                });
                return;
            }

            console.log('👤 join-room:', { roomId, userId, userName, userRole, socketId: socket.id });

            // Rejoindre la room Socket.IO
            socket.join(roomId);

            // Stocker les infos du participant
            participants.set(socket.id, {
                socketId: socket.id,
                userId,
                userName,
                userRole,
                roomId,
                joinedAt: Date.now(),
                mediaState: { audio: true, video: true }
            });

            // Créer ou récupérer la room
            if (!rooms.has(roomId)) {
                rooms.set(roomId, {
                    roomId,
                    participants: new Set(),
                    mode: 'p2p',
                    createdAt: Date.now()
                });
                console.log(`🏠 Nouvelle room créée: ${roomId}`);
            }

            const room = rooms.get(roomId);
            room.participants.add(socket.id);

            // ⚡ DÉTERMINER LE MODE OPTIMAL
            const participantCount = room.participants.size;
            const optimalMode = await determineOptimalMode(roomId, participantCount);

            let modeChanged = false;
            if (optimalMode !== room.mode) {
                room.mode = optimalMode;
                modeChanged = true;
                console.log(`🔄 Basculement vers ${optimalMode} pour room ${roomId} (${participantCount} participants)`);
            }

            // Récupérer la liste des participants existants
            const existingParticipants = Array.from(room.participants)
                .filter(id => id !== socket.id)
                .map(id => participants.get(id))
                .filter(p => p !== undefined);

            // Si mode SFU, générer un token
            let sfuToken = null;
            if (room.mode === 'sfu') {
                try {
                    const sfuUrl = process.env.SFU_SERVER_URL || 'https://visio-sfu-server-6.onrender.com';
                    const tokenResponse = await fetch(`${sfuUrl}/tokens`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            room_id: roomId,
                            participant_id: userId
                        })
                    });

                    if (tokenResponse.ok) {
                        sfuToken = await tokenResponse.json();
                        console.log('✅ Token SFU généré pour:', userId);
                    } else {
                        console.warn('⚠️ Impossible de générer token SFU');
                    }
                } catch (error) {
                    console.error('❌ Erreur génération token SFU:', error);
                }
            }

            // Envoyer la confirmation au nouveau participant
            socket.emit('room-joined', {
                roomId,
                socketId: socket.id,
                participants: existingParticipants,
                mode: room.mode,
                sfuToken: sfuToken,
                participantsCount: room.participants.size,
                success: true,
                timestamp: Date.now()
            });

            // Notifier les autres de l'arrivée
            socket.to(roomId).emit('user-joined', {
                socketId: socket.id,
                userId,
                userName,
                userRole,
                participantsCount: room.participants.size,
                mode: room.mode,
                timestamp: Date.now()
            });

            // Notifier du changement de mode si nécessaire
            if (modeChanged) {
                io.to(roomId).emit('mode-switched', {
                    mode: room.mode,
                    participantsCount: participantCount,
                    reason: participantCount >= 10 ? 'trop de participants' : 'changement optimal',
                    timestamp: Date.now()
                });
            }

            console.log(`📊 Room ${roomId}: ${room.participants.size} participants (Mode: ${room.mode})`);

        } catch (error) {
            console.error('❌ Erreur join-room:', error);
            socket.emit('error', {
                event: 'join-room',
                message: error.message,
                timestamp: Date.now()
            });
        }
    });

    // ========== OFFRE WEBRTC ==========
    socket.on('webrtc-offer', (data) => {
        try {
            const { to: targetSocketId, offer, roomId } = data;
            console.log('📤 Offre WebRTC:', socket.id, '→', targetSocketId);

            const participant = participants.get(socket.id);

            socket.to(targetSocketId).emit('webrtc-offer', {
                offer: offer,
                from: socket.id,
                participant: participant,
                roomId: roomId,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('❌ Erreur webrtc-offer:', error);
        }
    });

    // ========== RÉPONSE WEBRTC ==========
    socket.on('webrtc-answer', (data) => {
        try {
            const { to: targetSocketId, answer, roomId } = data;
            console.log('📥 Réponse WebRTC:', socket.id, '→', targetSocketId);

            socket.to(targetSocketId).emit('webrtc-answer', {
                answer: answer,
                from: socket.id,
                roomId: roomId,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('❌ Erreur webrtc-answer:', error);
        }
    });

    // ========== CANDIDAT ICE ==========
    socket.on('ice-candidate', (data) => {
        try {
            const { to: targetSocketId, candidate, roomId } = data;

            socket.to(targetSocketId).emit('ice-candidate', {
                candidate: candidate,
                from: socket.id,
                roomId: roomId,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('❌ Erreur ice-candidate:', error);
        }
    });

    // ========== ÉTAT MÉDIA ==========
    socket.on('media-state-change', (data) => {
        try {
            const participant = participants.get(socket.id);

            if (participant) {
                participant.mediaState = data;
                console.log('🎤📹 État média changé:', socket.id, data);

                socket.to(participant.roomId).emit('participant-media-state', {
                    socketId: socket.id,
                    mediaState: data,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error('❌ Erreur media-state-change:', error);
        }
    });

    // ========== MESSAGE DE CHAT ==========
    socket.on('chat-message', (data) => {
        try {
            const participant = participants.get(socket.id);

            if (participant) {
                const messageData = {
                    ...data,
                    socketId: socket.id,
                    userId: participant.userId,
                    userName: participant.userName,
                    timestamp: Date.now()
                };

                console.log('💬 Message chat:', messageData);

                // Diffuser à tous les participants de la room
                io.to(participant.roomId).emit('chat-message', messageData);
            }
        } catch (error) {
            console.error('❌ Erreur chat-message:', error);
        }
    });

    // ========== DEMANDE TOKEN SFU ==========
    socket.on('request-sfu-token', async (data) => {
        try {
            const { roomId, userId } = data;
            const participant = participants.get(socket.id);

            if (!participant || participant.roomId !== roomId) {
                socket.emit('sfu-token-error', {
                    error: 'Participant non trouvé ou mauvaise room',
                    timestamp: Date.now()
                });
                return;
            }

            const sfuUrl = process.env.SFU_SERVER_URL || 'https://visio-sfu-server-6.onrender.com';
            const tokenResponse = await fetch(`${sfuUrl}/tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room_id: roomId,
                    participant_id: userId
                })
            });

            if (tokenResponse.ok) {
                const tokenData = await tokenResponse.json();
                socket.emit('sfu-token', {
                    ...tokenData,
                    timestamp: Date.now()
                });
            } else {
                throw new Error(`Erreur HTTP ${tokenResponse.status}`);
            }

        } catch (error) {
            console.error('❌ Erreur request-sfu-token:', error);
            socket.emit('sfu-token-error', {
                error: error.message,
                timestamp: Date.now()
            });
        }
    });

    // ========== QUITTER UNE ROOM ==========
    socket.on('leave-room', (data = {}) => {
        try {
            const { roomId, userId, userName } = data;
            console.log('👋 Leave-room:', { socketId: socket.id, roomId, userId, userName });
            handleParticipantLeaving(socket);
        } catch (error) {
            console.error('❌ Erreur leave-room:', error);
        }
    });

    // ========== DÉCONNEXION ==========
    socket.on('disconnect', (reason) => {
        console.log('❌ Client déconnecté:', socket.id, 'Raison:', reason);
        handleParticipantLeaving(socket);
    });

    // ========== HEARTBEAT ==========
    socket.on('ping', () => {
        socket.emit('pong', {
            timestamp: Date.now(),
            serverTime: Date.now()
        });
    });

    // ========== STATISTIQUES ==========
    socket.on('get-stats', () => {
        const participant = participants.get(socket.id);
        const room = participant ? rooms.get(participant.roomId) : null;

        socket.emit('stats', {
            socketId: socket.id,
            room: room ? {
                roomId: room.roomId,
                participantsCount: room.participants.size,
                mode: room.mode
            } : null,
            server: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                timestamp: Date.now()
            }
        });
    });
});

// ==================== FONCTION DE NETTOYAGE ====================
function handleParticipantLeaving(socket) {
    const participant = participants.get(socket.id);

    if (participant) {
        const { roomId, userId, userName } = participant;

        console.log('🧹 Nettoyage participant:', { socketId: socket.id, roomId, userId, userName });

        // Retirer de la room
        if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.participants.delete(socket.id);

            const participantCount = room.participants.size;

            // Notifier les autres participants
            socket.to(roomId).emit('user-left', {
                socketId: socket.id,
                userId: userId,
                userName: userName,
                participantsCount: participantCount,
                timestamp: Date.now()
            });

            // Vérifier si basculement nécessaire
            if (participantCount < 10 && room.mode === 'sfu') {
                room.mode = 'p2p';
                console.log(`🔄 Basculement SFU → P2P pour room ${roomId} (${participantCount} participants)`);

                io.to(roomId).emit('mode-switched', {
                    mode: 'p2p',
                    participantsCount: participantCount,
                    reason: 'peu de participants',
                    timestamp: Date.now()
                });
            }

            // Supprimer la room si vide
            if (room.participants.size === 0) {
                rooms.delete(roomId);
                console.log(`🗑️ Room ${roomId} supprimée (vide)`);
            } else {
                console.log(`📊 Room ${roomId}: ${room.participants.size} participants (Mode: ${room.mode})`);
            }
        }

        participants.delete(socket.id);
    }
}

// ==================== NETTOYAGE PÉRIODIQUE ====================
setInterval(() => {
    let cleanedRooms = 0;
    let cleanedParticipants = 0;

    const now = Date.now();
    const MAX_INACTIVE_TIME = 30 * 60 * 1000; // 30 minutes

    // Nettoyer les rooms vides
    rooms.forEach((room, roomId) => {
        if (room.participants.size === 0 && (now - room.createdAt > MAX_INACTIVE_TIME)) {
            rooms.delete(roomId);
            cleanedRooms++;
        }
    });

    // Nettoyer les participants orphelins
    participants.forEach((participant, socketId) => {
        if (!rooms.has(participant.roomId)) {
            participants.delete(socketId);
            cleanedParticipants++;
        }
    });

    if (cleanedRooms > 0 || cleanedParticipants > 0) {
        console.log(`🧹 Nettoyage: ${cleanedRooms} rooms et ${cleanedParticipants} participants supprimés`);
    }
}, 300000); // Toutes les 5 minutes

// ==================== DÉMARRAGE DU SERVEUR ====================
const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log('='.repeat(70));
    console.log('🚀 VISIOCAMPUS SOCKET.IO SIGNALING SERVER');
    console.log('='.repeat(70));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🖥️  Host: ${HOST}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔄 System: Hybrid P2P/SFU (auto-switch at 10 participants)`);
    console.log(`⚡ Transports: websocket, polling`);
    console.log('='.repeat(70));
    console.log('✅ Routes disponibles:');
    console.log(`   🏠 Home: /`);
    console.log(`   ❤️  Health: /health`);
    console.log(`   📊 Status: /status`);
    console.log(`   🎫 SFU Token: POST /sfu-token`);
    console.log('='.repeat(70));
    console.log(`✅ Serveur Socket.IO prêt sur Render`);
    console.log('='.repeat(70));
});

// ==================== GESTION PROPRE DE L'ARRÊT ====================
const gracefulShutdown = () => {
    console.log('\n🛑 Arrêt du serveur Socket.IO...');

    // Notifier tous les clients
    io.emit('server-shutdown', {
        message: 'Le serveur va redémarrer',
        timestamp: Date.now()
    });

    // Fermer toutes les connexions
    io.close(() => {
        console.log('✅ Socket.IO fermé');
    });

    // Fermer le serveur HTTP
    server.close(() => {
        console.log('✅ Serveur HTTP fermé');
        process.exit(0);
    });

    // Force l'arrêt après 10 secondes
    setTimeout(() => {
        console.error('⚠️  Arrêt forcé après timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Gestion des erreurs
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejetée:', reason);
});
