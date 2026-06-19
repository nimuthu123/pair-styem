// index.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const crypto = require('crypto');

// Polyfill crypto for browser environment
if (!globalThis.crypto) {
    globalThis.crypto = crypto;
}

import express from 'express';
import { SessionManager } from './sessionManager.js';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import mongoose from 'mongoose';
import { Messages } from './message.js'; // නව එකතු කිරීම

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3000;

// Store session managers
const sessions = new Map();

app.use(express.static('public'));
app.use(express.json());

// MongoDB connection URI
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://nimuthu:200939nimuthu@ac-wgnvpo1-shard-00-00.gcqvqse.mongodb.net:27017,ac-wgnvpo1-shard-00-01.gcqvqse.mongodb.net:27017,ac-wgnvpo1-shard-00-02.gcqvqse.mongodb.net:27017/?ssl=true&replicaSet=atlas-11p6yd-shard-0&authSource=admin&appName=whatsappbot';

// Session Schema
const sessionSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    creds: { type: mongoose.Schema.Types.Mixed, default: null },
    sessionData: { type: mongoose.Schema.Types.Mixed, default: {} },
    connectionStatus: { type: String, default: 'disconnected' },
    connectedAt: { type: Date, default: null },
    pairingCode: { type: String, default: null },
    lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

// Connect to MongoDB on startup
async function connectDB() {
    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(MONGODB_URI);
            console.log('✅ MongoDB Connected');
        }
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
    }
}

// Check if session exists in MongoDB
async function checkExistingSession(phoneNumber) {
    try {
        const session = await Session.findOne({ phoneNumber });
        if (session && session.creds && Object.keys(session.creds).length > 0) {
            console.log(`✅ Found existing session in MongoDB for ${phoneNumber}`);
            console.log(`   Status: ${session.connectionStatus}`);
            console.log(`   Last Updated: ${session.lastUpdated}`);
            return session;
        }
        return null;
    } catch (err) {
        console.error('Error checking session:', err);
        return null;
    }
}

// Delete session from MongoDB
async function deleteSessionFromDB(phoneNumber) {
    try {
        const result = await Session.deleteOne({ phoneNumber });
        if (result.deletedCount > 0) {
            console.log(`✅ Session deleted from MongoDB for ${phoneNumber}`);
            return true;
        } else {
            console.log(`ℹ️ No session found to delete for ${phoneNumber}`);
            return false;
        }
    } catch (err) {
        console.error('❌ Error deleting session:', err);
        return false;
    }
}

// Root endpoint - serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to initialize connection and get pairing code
app.post('/init-connection', async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        const cleanNumber = phoneNumber.replace(/\D/g, '');

        console.log(`📱 Initializing connection for ${cleanNumber}...`);

        // Connect to MongoDB
        await connectDB();

        // Check if session already exists in MongoDB
        const existingSessionDoc = await checkExistingSession(cleanNumber);
        
        // If session exists in MongoDB with valid credentials, return already connected
        if (existingSessionDoc && existingSessionDoc.creds && Object.keys(existingSessionDoc.creds).length > 0) {
            console.log(`✅ Session already exists in MongoDB for ${cleanNumber}`);
            console.log(`📱 Returning "Already connected" without creating new connection`);
            
            return res.json({
                message: 'Already connected',
                status: 'connected',
                phoneNumber: cleanNumber,
                code: existingSessionDoc.pairingCode || null,
                connectedAt: existingSessionDoc.connectedAt,
                lastUpdated: existingSessionDoc.lastUpdated
            });
        }

        // Check if session exists in memory
        if (sessions.has(cleanNumber)) {
            const existingSession = sessions.get(cleanNumber);

            if (existingSession.isConnected()) {
                return res.json({
                    message: 'Connected',
                    status: 'connected',
                    phoneNumber: cleanNumber,
                    code: existingSession.getPairingCode() || null
                });
            }

            const existingCode = existingSession.getPairingCode();
            if (existingCode) {
                const qrCodeDataUrl = await QRCode.toDataURL(existingCode);
                return res.json({
                    qr: qrCodeDataUrl,
                    code: existingCode,
                    message: 'Existing pairing code',
                    status: existingSession.getConnectionStatus(),
                    phoneNumber: cleanNumber
                });
            }
        }

        // Create new session manager (fresh connection)
        console.log(`🆕 Creating new session for ${cleanNumber}...`);
        const sessionManager = new SessionManager(cleanNumber);
        
        // Set up session cleanup on disconnect/reconnect failure
        sessionManager.setConnectionStatusCallback(async (status) => {
            console.log(`📊 Status update for ${cleanNumber}: ${status}`);
            
            // If connection fails or disconnects after reconnection attempts
            if (status === 'disconnected' || status === 'error') {
                console.log(`🔄 Connection failed for ${cleanNumber}, checking if should delete session...`);
                
                // Check if session manager is still trying to reconnect
                if (sessionManager.reconnectAttempts >= sessionManager.maxReconnectAttempts) {
                    console.log(`❌ Max reconnection attempts reached for ${cleanNumber}`);
                    console.log(`🗑️ Deleting session from MongoDB...`);
                    
                    // Delete session from MongoDB
                    await deleteSessionFromDB(cleanNumber);
                    
                    // Remove from memory
                    if (sessions.has(cleanNumber)) {
                        sessions.delete(cleanNumber);
                    }
                    
                    console.log(`✅ Session cleaned up for ${cleanNumber}`);
                }
            }
        });
        
        sessions.set(cleanNumber, sessionManager);

        let pairingCodeResolved = false;
        let responseSent = false;

        // Set up the connected callback - Send welcome message
        sessionManager.setOnConnectedCallback(async (sock) => {
            try {
                console.log('🎯 Connected successfully!');
                sessionManager._notifyStatusChange('connected');
                
                // Send welcome message when connection opens
                try {
                    const jid = `${cleanNumber}@s.whatsapp.net`;
                    // පණිවිඩය message.js ගොනුවෙන් ලබා ගැනීම
                    const message = Messages.WELCOME_MESSAGE(cleanNumber);
                    
                    console.log(`📤 Sending welcome message to ${jid}...`);
                    await sessionManager.sendMessage(jid, message);
                    console.log('✅ Welcome message sent successfully!');
                    sessionManager._notifyStatusChange('message_sent');
                    
                } catch (msgErr) {
                    console.error('❌ Failed to send welcome message:', msgErr.message);
                }

            } catch (err) {
                console.error('❌ Failed during connected-callback:', err);
                sessionManager._notifyStatusChange('error');
            }
        });

        sessionManager.setPairingCodeCallback(async (code, error) => {
            if (error) {
                console.error('Pairing error:', error);
                if (!responseSent && !res.headersSent) {
                    responseSent = true;
                    res.status(500).json({ error: 'Failed to generate pairing code: ' + error.message });
                }
                return;
            }

            if (code && !pairingCodeResolved) {
                pairingCodeResolved = true;
                try {
                    const qrCodeDataUrl = await QRCode.toDataURL(code);
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.json({
                            qr: qrCodeDataUrl,
                            code: code,
                            message: 'Pairing code generated successfully',
                            status: sessionManager.getConnectionStatus(),
                            phoneNumber: cleanNumber
                        });
                    }
                } catch (qrError) {
                    console.error('QR generation error:', qrError);
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(500).json({ error: 'Failed to generate QR code' });
                    }
                }
            }
        });

        try {
            await sessionManager.initConnection();

            // Check if already registered
            if (sessionManager.isRegistered()) {
                console.log(`📱 ${cleanNumber} already registered`);
                
                if (!responseSent && !res.headersSent) {
                    responseSent = true;
                    return res.json({
                        message: 'Connected',
                        status: 'connected',
                        phoneNumber: cleanNumber,
                        code: sessionManager.getPairingCode() || null
                    });
                }
                return;
            }

            // Request pairing code
            await new Promise(resolve => setTimeout(resolve, 3000));
            await sessionManager.requestPairingCode();

            // Fallback timeout for pairing code
            setTimeout(async () => {
                if (!pairingCodeResolved && !responseSent && !res.headersSent) {
                    const code = sessionManager.getPairingCode();
                    if (code) {
                        pairingCodeResolved = true;
                        try {
                            const qrCodeDataUrl = await QRCode.toDataURL(code);
                            responseSent = true;
                            res.json({
                                qr: qrCodeDataUrl,
                                code: code,
                                message: 'Pairing code generated',
                                status: sessionManager.getConnectionStatus(),
                                phoneNumber: cleanNumber
                            });
                        } catch (err) {
                            if (!responseSent && !res.headersSent) {
                                responseSent = true;
                                res.status(500).json({ error: 'Failed to generate QR after timeout' });
                            }
                        }
                    } else {
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(504).json({ error: 'Timeout waiting for pairing code' });
                        }
                    }
                }
            }, 15000);

        } catch (err) {
            console.error('Init error:', err);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(500).json({ error: 'Failed to initialize connection: ' + err.message });
            }
        }

    } catch (err) {
        console.error('Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Server error: ' + err.message });
        }
    }
});

app.listen(PORT, async () => {
    await connectDB();
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser`);
});
