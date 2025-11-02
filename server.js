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

// Vérifier la santé du SFU
async function checkSFUHealth() {
    try {
        const sfuUrl = process.env.SFU_SERVER_URL || 'https://visio-sfu-server-6.onrender.com';
        const response = await fetch(`${sfuUrl}/health`);
        return response.ok;
    } catch (error) {
        console.error('❌ SFU health check failed:', error.message);
        return false;
    }
}

// Vérifier la santé du P2P
async function checkP2PHealth() {
    try {
        const p2pUrl = process.env.PEERJS_SERVER_URL || 'https://visio-peerjs-server-4.onrender.com';
        const response = await fetch(`${p2pUrl}/health`);
        return response.ok;
    } catch (error) {
        console.error('❌ P2P health check failed:', error.message);
        return false;
    }
}

// Déterminer le mode optimal
async function determineOptimalMode(roomId, participantCount) {
    const sfuAvailable = await checkSFUHealth();
    const p2pAvailable = await checkP2PHealth();

    console.log(`🔍 Disponibilité - SFU: ${sfuAvailable}, P2P: ${p2pAvailable}`);

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
        return 'sfu';
    } else {
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

// Health check pour Render
app.get('/health', async (req, res) => {
    const sfuHealth = await checkSFUHealth();
    const p2pHealth = await checkP2PHealth();

    res.json({
        status: 'OK',
        service: 'Socket.IO Signaling - VisioCampus',
        timestamp: new Date().toISOString(),
        sfu_available: sfuHealth,
        p2p_available: p2pHealth,
        rooms: rooms.size,
        participants: participants.size
    });
});

// Status détaillé
app.get('/status', (req, res) => {
    const roomsData = Array.from(rooms.entries()).map(([roomId, room]) => ({
        roomId,
        participants: room.participants.size,
        mode: room.mode,
        createdAt: room.createdAt
    }));

    res.json({
        status: 'ok',
        rooms: roomsData,
        totalParticipants: participants.size,
        connectedSockets: io.sockets.sockets.size
    });
});

// Obtenir les infos SFU pour une room
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

        // Créer la room SFU si elle n'existe pas
        const createRoomResponse = await fetch(`${sfuUrl}/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room_id, max_participants: 50 })
        });

        if (!createRoomResponse.ok) {
            throw new Error('Erreur création room SFU');
        }

        // Générer le token
        const tokenResponse = await fetch(`${sfuUrl}/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room_id, participant_id })
        });

        if (!tokenResponse.ok) {
            throw new Error('Erreur génération token SFU');
        }

        const tokenData = await tokenResponse.json();
        res.json(tokenData);

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
            const { roomId, userId, userName, userRole } = data;
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
                    }
                } catch (error) {
                    console.error('❌ Erreur génération token SFU:', error);
                }
            }

            // Envoyer la liste au nouveau participant
            socket.emit('joined-room', {
                roomId,
                socketId: socket.id,
                participants: existingParticipants,
                mode: room.mode,
                sfuToken: sfuToken,
                participantsCount: room.participants.size,
                success: true
            });

            // Notifier les autres de l'arrivée
            socket.to(roomId).emit('participant-joined', {
                socketId: socket.id,
                userId,
                userName,
                userRole,
                participantsCount: room.participants.size,
                mode: room.mode
            });

            // Notifier du changement de mode si nécessaire
            if (modeChanged) {
                io.to(roomId).emit('mode-switch', {
                    mode: room.mode,
                    participantsCount: participantCount,
                    reason: participantCount >= 10 ? 'trop de participants' : 'changement optimal'
                });
            }

            console.log(`📊 Room ${roomId}: ${room.participants.size} participants (Mode: ${room.mode})`);

        } catch (error) {
            console.error('❌ Erreur join-room:', error);
            socket.emit('error', {
                event: 'join-room',
                message: error.message
            });
        }
    });

    // ========== OFFRE WEBRTC ==========
    socket.on('webrtc-offer', (data) => {
        try {
            console.log('📤 Offre WebRTC:', socket.id, '→', data.targetSocketId);

            const participant = participants.get(socket.id);

            socket.to(data.targetSocketId).emit('webrtc-offer', {
                offer: data.offer,
                fromSocketId: socket.id,
                participant: participant
            });
        } catch (error) {
            console.error('❌ Erreur webrtc-offer:', error);
        }
    });

    // ========== RÉPONSE WEBRTC ==========
    socket.on('webrtc-answer', (data) => {
        try {
            console.log('📥 Réponse WebRTC:', socket.id, '→', data.targetSocketId);

            socket.to(data.targetSocketId).emit('webrtc-answer', {
                answer: data.answer,
                fromSocketId: socket.id
            });
        } catch (error) {
            console.error('❌ Erreur webrtc-answer:', error);
        }
    });

    // ========== CANDIDAT ICE ==========
    socket.on('ice-candidate', (data) => {
        try {
            socket.to(data.targetSocketId).emit('ice-candidate', {
                candidate: data.candidate,
                fromSocketId: socket.id
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
                    mediaState: data
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
                io.to(participant.roomId).emit('chat-message', {
                    ...data,
                    socketId: socket.id,
                    userName: participant.userName,
                    timestamp: Date.now()
                });
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
                socket.emit('sfu-token-error', { error: 'Participant non trouvé' });
                return;
            }

            const sfuUrl = process.env.SFU_SERVER_URL || 'https://visio-sfu-server-6.onrender.com';
            const tokenResponse = await fetch(`${sfuUrl}/tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room_id: roomId, participant_id: userId })
            });

            if (tokenResponse.ok) {
                const tokenData = await tokenResponse.json();
                socket.emit('sfu-token', tokenData);
            } else {
                throw new Error('Erreur génération token SFU');
            }

        } catch (error) {
            console.error('❌ Erreur request-sfu-token:', error);
            socket.emit('sfu-token-error', { error: error.message });
        }
    });

    // ========== QUITTER UNE ROOM ==========
    socket.on('leave-room', () => {
        try {
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
        socket.emit('pong', { timestamp: Date.now() });
    });
});

// ==================== FONCTION DE NETTOYAGE ====================
function handleParticipantLeaving(socket) {
    const participant = participants.get(socket.id);

    if (participant) {
        const { roomId } = participant;

        // Retirer de la room
        if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.participants.delete(socket.id);

            const participantCount = room.participants.size;

            // Notifier les autres
            socket.to(roomId).emit('participant-left', {
                socketId: socket.id,
                userId: participant.userId,
                userName: participant.userName,
                participantsCount: participantCount
            });

            // Vérifier si basculement nécessaire
            if (participantCount < 10 && room.mode === 'sfu') {
                room.mode = 'p2p';
                console.log(`🔄 Basculement SFU → P2P pour room ${roomId} (${participantCount} participants)`);

                io.to(roomId).emit('mode-switch', {
                    mode: 'p2p',
                    participantsCount: participantCount,
                    reason: 'peu de participants'
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
    let cleaned = 0;

    rooms.forEach((room, roomId) => {
        if (room.participants.size === 0) {
            rooms.delete(roomId);
            cleaned++;
        }
    });

    if (cleaned > 0) {
        console.log(`🧹 Nettoyage: ${cleaned} rooms vides supprimées`);
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
