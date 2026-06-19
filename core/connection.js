//connection.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const crypto = require('crypto');

// Polyfill crypto for browser environment
if (!globalThis.crypto) {
    globalThis.crypto = crypto;
}

import {
    makeWASocket,
    initAuthCreds,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { MongoManager } from '../database/mogo.js';
import { KeyStore } from '../utils/keyStore.js';
import { CredentialValidator } from '../utils/validator.js';
import { DataSerializer } from '../utils/serializer.js';
import { MemoryCleaner } from './memoryclear.js';
import { PairingHandler } from './paircode.js';
import { SessionManager } from './sessiondelete.js';
import { AlreadyRegisteredHandler } from './allredyregister.js';

export class ConnectionManager {
    // Configuration constants
    static CONFIG = {
        MAX_RECONNECT_ATTEMPTS: 3,
        MAX_CONNECTION_ATTEMPTS: 2,
        MAX_STALE_REPAIR_ATTEMPTS: 1,
        MAX_RECONNECTION_ATTEMPTS: 3,
        MAX_PAIRING_RETRIES: 2,
        CONNECTION_TIMEOUT: 60000,
        RECONNECT_DELAY: 5000,
        PAIRING_TIMEOUT: 180000,
        SESSION_DELETE_TIMEOUT: 180000,
        HEALTH_CHECK_INTERVAL: 30000,
        PAIRING_RECONNECT_DELAY: 3000,
        DEVICE_DISCONNECT_CHECK_INTERVAL: 5000,
        MAX_DEVICE_DISCONNECT_RETRIES: 2,
        SAVE_SESSION_INTERVAL: 60000 // Save session every minute
    };

    constructor(phoneNumber, mongoUri) {
        if (!mongoUri) {
            throw new Error('MongoDB URI is required');
        }

        this.phoneNumber = phoneNumber;
        this.sock = null;
        this.mongo = new MongoManager(mongoUri);
        this.keyStore = null;
        this.credsData = null;
        this.keyStoreData = {};
        
        // Connection state
        this.isConnected = false;
        this.isReconnecting = false;
        this.isPairing = false;
        this.pairingComplete = false;
        this.pairingRequested = false;
        this.intentionalDisconnect = false;
        this.connectionInitiated = false;
        this.isDeviceDisconnected = false;
        this.deviceDisconnectRetries = 0;
        this.deviceConnected = false;
        this.sessionSaved = false;
        
        // Counters
        this.reconnectAttempts = 0;
        this.connectionAttempts = 0;
        this.reconnectionAttempts = 0;
        this.pairingRetryCount = 0;
        this.staleSessionRepairAttempts = 0;
        
        // Timers and timeouts
        this.reconnectTimer = null;
        this.pairingTimeout = null;
        this.connectionTimeout = null;
        this.sessionDeleteTimer = null;
        this.healthCheckTimer = null;
        this.deviceCheckTimer = null;
        this.saveSessionTimer = null;
        
        // Timestamps
        this.connectedAt = null;
        this.connectionStartTime = null;
        this.lastHealthCheck = 0;
        this.lastDeviceCheck = 0;
        this.deviceDisconnectedAt = null;
        this.lastSessionSave = 0;
        
        // Status
        this.status = 'disconnected';
        this.pairingCode = null;
        this.deviceInfo = null;
        
        // Callbacks
        this.callbacks = {
            onPairingCode: null,
            onConnectionStatus: null,
            onConnected: null,
            onDisconnected: null,
            onError: null,
            onDeviceDisconnected: null,
            onDeviceConnected: null
        };

        // Promise resolvers
        this.connectionResolve = null;
        this.connectionReject = null;

        // Initialize handlers
        this.memoryCleaner = new MemoryCleaner(this);
        this.pairingHandler = new PairingHandler(this);
        this.sessionManager = new SessionManager(this);
        this.alreadyRegisteredHandler = new AlreadyRegisteredHandler(this);
    }

    // Public methods
    setCallbacks(callbacks) {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }

    async checkAndHandleSession() {
        return this.alreadyRegisteredHandler.checkAndHandleSession();
    }

    async forceRecreateSession() {
        return this.alreadyRegisteredHandler.forceRecreate();
    }

    getSessionInfo() {
        return this.alreadyRegisteredHandler.getSessionInfo();
    }

    async checkAndRepairSession() {
        return this.alreadyRegisteredHandler.checkAndRepair();
    }

    /**
     * Force disconnect from WhatsApp device without deleting session
     */
    async forceDeviceDisconnect() {
        console.log(`🔌 Force disconnecting device for ${this.phoneNumber}`);
        this.isDeviceDisconnected = true;
        this.deviceConnected = false;
        this.deviceDisconnectedAt = new Date();
        this.intentionalDisconnect = true;
        
        if (this.sock) {
            try {
                // Just end the connection without logging out
                await this.sock.end();
            } catch (e) {
                console.warn('⚠️ Error during force disconnect:', e.message);
            }
        }
        
        this.isConnected = false;
        this._cancelAllTimers();
        await this._notifyDeviceDisconnected();
        this.intentionalDisconnect = false;
        return true;
    }

    /**
     * Check if device is still connected - only checks socket state, doesn't modify session
     */
    async isDeviceConnected() {
        if (!this.sock || !this.isConnected) {
            return false;
        }
        
        try {
            const state = this.sock.connectionState;
            const isOpen = state === 'open';
            
            if (isOpen !== this.deviceConnected) {
                this.deviceConnected = isOpen;
                if (!isOpen) {
                    this.isDeviceDisconnected = true;
                    this.deviceDisconnectedAt = new Date();
                    await this._notifyDeviceDisconnected();
                } else {
                    this.isDeviceDisconnected = false;
                    this.deviceDisconnectRetries = 0;
                    await this._notifyDeviceConnected();
                }
            }
            
            return isOpen;
        } catch (e) {
            console.warn('⚠️ Device check error:', e.message);
            this.deviceConnected = false;
            this.isDeviceDisconnected = true;
            return false;
        }
    }

    /**
     * Send a message with device status tracking
     */
    async sendMessage(jid, content, options = {}) {
        if (!this.isConnected || !this.sock) {
            throw new Error('Not connected to WhatsApp');
        }
        
        // Check device status before sending
        const connected = await this.isDeviceConnected();
        if (!connected) {
            throw new Error('Device is disconnected');
        }
        
        try {
            const result = await this.sock.sendMessage(jid, content, options);
            
            // Update device info from result
            if (result?.deviceInfo) {
                this.deviceInfo = result.deviceInfo;
            }
            
            return result;
        } catch (err) {
            // Check if error indicates device disconnect
            if (this._isDeviceDisconnectError(err)) {
                this.isDeviceDisconnected = true;
                this.deviceConnected = false;
                this.deviceDisconnectedAt = new Date();
                await this._notifyDeviceDisconnected();
                throw new Error('Device disconnected during message send');
            }
            throw err;
        }
    }

    /**
     * Get device information
     */
    getDeviceInfo() {
        return {
            phoneNumber: this.phoneNumber,
            isConnected: this.isConnected,
            isDeviceConnected: this.deviceConnected,
            isDeviceDisconnected: this.isDeviceDisconnected,
            deviceDisconnectedAt: this.deviceDisconnectedAt,
            deviceInfo: this.deviceInfo,
            status: this.status,
            connectedAt: this.connectedAt
        };
    }

    /**
     * Get connection status with device details
     */
    getConnectionStatus() {
        return {
            status: this.status,
            isConnected: this.isConnected,
            isDeviceConnected: this.deviceConnected,
            isPairing: this.isPairing,
            phoneNumber: this.phoneNumber,
            connectedAt: this.connectedAt,
            deviceDisconnectedAt: this.deviceDisconnectedAt,
            reconnectAttempts: this.reconnectionAttempts,
            hasCredentials: !!this.credsData?.registered,
            sessionSaved: this.sessionSaved
        };
    }

    async init() {
        try {
            this.connectionStartTime = Date.now();
            this._resetCounters();

            if (this._shouldSkipInit()) {
                return this.sock;
            }

            await this._ensureMongoConnection();
            this.connectionInitiated = true;
            this.connectionAttempts++;

            // Load credentials from DB
            await this.loadCredentials();

            // Check if we have valid credentials and should connect
            if (this.credsData?.registered) {
                console.log(`✅ Found registered credentials for ${this.phoneNumber}`);
            } else {
                console.log(`🔄 No registered credentials found, will request pairing`);
            }

            const authState = this.createAuthState();
            const { version } = await fetchLatestBaileysVersion();

            this._closeExistingSocket();
            this.sock = this.createSocket(version, authState);
            this.setupEventHandlers();

            // Start session save timer (periodic save)
            this._startSessionSaveTimer();

            return this._createConnectionPromise();
        } catch (err) {
            this._handleError(err);
            throw err;
        }
    }

    createSocket(version, authState) {
        return makeWASocket({
            version,
            auth: authState,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Safari'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            shouldSyncHistory: () => false,
            connectTimeoutMs: ConnectionManager.CONFIG.CONNECTION_TIMEOUT,
            defaultQueryTimeoutMs: ConnectionManager.CONFIG.CONNECTION_TIMEOUT,
            keepAliveIntervalMs: 30000,
            generateHighQualityLinkPreview: false,
            shouldReconnect: () => {
                // 🛑 DON'T reconnect if device was disconnected
                if (this.isDeviceDisconnected) {
                    console.log('🚫 Device is disconnected, preventing auto-reconnect');
                    return false;
                }
                
                // Don't reconnect if intentionally disconnected
                if (this.intentionalDisconnect) {
                    return false;
                }
                
                // Only allow reconnection during pairing
                return this.isPairing;
            }
        });
    }

    createAuthState() {
        const creds = this.credsData || initAuthCreds();
        this.keyStore = new KeyStore(this.keyStoreData || {});
        return {
            creds: creds,
            keys: this.keyStore
        };
    }

    async loadCredentials() {
        try {
            const session = await this.mongo.getSession(this.phoneNumber);
            if (session?.creds && Object.keys(session.creds).length > 0) {
                const creds = DataSerializer.deserialize(session.creds);
                if (CredentialValidator.isValid(creds)) {
                    this.credsData = creds;
                    this.keyStoreData = DataSerializer.deserialize(session.sessionData?.keys || {});
                    this.deviceInfo = session.sessionData?.deviceInfo || null;
                    
                    // Load device connection state from DB but don't auto-disconnect
                    if (session.sessionData?.deviceConnected === false) {
                        this.isDeviceDisconnected = true;
                        this.deviceDisconnectedAt = session.sessionData?.deviceDisconnectedAt || null;
                        console.log(`⚠️ Device was previously disconnected for ${this.phoneNumber}`);
                    }
                    
                    this.sessionSaved = true;
                    console.log(`✅ Loaded valid credentials for ${this.phoneNumber}`);
                    return;
                }
            }
            console.log(`🔄 Starting with fresh credentials for ${this.phoneNumber}`);
            this.credsData = initAuthCreds();
            this.keyStoreData = {};
            this.isDeviceDisconnected = false;
            this.deviceConnected = false;
            this.sessionSaved = false;
        } catch (err) {
            console.error('❌ Error loading credentials:', err);
            this.credsData = initAuthCreds();
            this.keyStoreData = {};
            this.sessionSaved = false;
        }
    }

    setupEventHandlers() {
        if (this.sock) {
            // Remove all existing listeners to prevent memory leaks
            this.sock.ev.removeAllListeners('creds.update');
            this.sock.ev.removeAllListeners('connection.update');
            this.sock.ev.removeAllListeners('error');
            this.sock.ev.removeAllListeners('messaging-history.set');
            this.sock.ev.removeAllListeners('device.update');

            // Add new listeners
            this.sock.ev.on('creds.update', this.handleCredsUpdate.bind(this));
            this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
            this.sock.ev.on('error', this.handleError.bind(this));
            this.sock.ev.on('messaging-history.set', this._handleHistorySync.bind(this));
            
            // Device update listener
            this.sock.ev.on('device.update', this._handleDeviceUpdate.bind(this));
        }
    }

    async handleCredsUpdate(creds) {
        try {
            this.credsData = { ...this.credsData, ...creds };
            if (CredentialValidator.isValid(this.credsData)) {
                // Save immediately on creds update
                await this.saveSession();
            }
        } catch (err) {
            console.error('❌ Creds update error:', err);
        }
    }

    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;
        console.log(`📡 Connection update: ${connection || 'unknown'}`);

        if (qr && !this.isConnected && !this.pairingRequested) {
            await this._handleQRCode();
            return;
        }

        if (connection === 'connecting') {
            this.setStatus('connecting');
        }

        if (connection === 'open') {
            await this._handleConnectionOpen();
        }

        if (connection === 'close') {
            await this._handleConnectionClose(lastDisconnect);
        }
    }

    async handleConnected() {
        console.log('✅ Connected Successfully');
        this._cancelAllTimers();
        
        this.isConnected = true;
        this.isPairing = false;
        this.pairingComplete = true;
        this.pairingRequested = false;
        this.pairingRetryCount = 0;
        this.reconnectionAttempts = 0;
        this.connectedAt = new Date();
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.connectionInitiated = false;
        this.connectionAttempts = 0;
        this.pairingCode = null;
        
        // Reset device disconnect state on successful connection
        this.isDeviceDisconnected = false;
        this.deviceConnected = true;
        this.deviceDisconnectRetries = 0;
        this.deviceDisconnectedAt = null;
        
        this.setStatus('connected');
        
        // Save session immediately on connection
        await this.saveSession();
        this.sessionSaved = true;
        
        this._startHealthCheck();
        this._startDeviceCheckTimer();

        // Notify device connected
        await this._notifyDeviceConnected();

        if (this.callbacks.onConnected) {
            await this.callbacks.onConnected(this.sock);
        }

        this._resolveConnection(this.sock);
    }

    async handleDisconnect(lastDisconnect) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
        
        console.log(`❌ Connection Closed: ${errorMessage}`);
        console.log(`📱 Phone: ${this.phoneNumber}`);
        
        this.setStatus('disconnected');
        this.isConnected = false;
        this.deviceConnected = false;
        this._cancelReconnectTimer();

        // 🔴 CRITICAL: Check if it's a device disconnect - DON'T reconnect
        if (this._isDeviceDisconnectError(errorMessage)) {
            this.isDeviceDisconnected = true;
            this.deviceDisconnectedAt = new Date();
            this.deviceDisconnectRetries++;
            
            console.log(`⚠️ Device disconnected from ${this.phoneNumber}`);
            console.log(`🚫 Auto-reconnection disabled for device disconnect`);
            
            // Save device disconnected state but keep session
            await this.saveSession();
            await this._notifyDeviceDisconnected();
            
            // 🛑 IMPORTANT: Stop here, don't attempt any reconnection
            return;
        }

        // Check if it's a logged out event
        if (statusCode === DisconnectReason.loggedOut) {
            await this.handleLoggedOut();
            return;
        }

        // Check if session is bad and needs repair
        if (statusCode === DisconnectReason.badSession) {
            console.log('🔑 Bad session detected, trying to repair...');
            await this._repairSession();
            return;
        }

        // Intentional disconnect - don't reconnect
        if (this.intentionalDisconnect) {
            console.log('🔌 Intentional disconnect, not reconnecting');
            this._cancelSessionDeleteTimer();
            return;
        }

        // Handle pairing mode disconnects differently
        if (this.isPairing) {
            await this._handlePairingDisconnect();
            return;
        }

        // ⚠️ Only attempt reconnection for non-device disconnects
        if (!this.isPairing && this.reconnectionAttempts < ConnectionManager.CONFIG.MAX_RECONNECTION_ATTEMPTS) {
            this._scheduleReconnection();
        } else if (!this.isPairing) {
            console.log(`❌ Max reconnection attempts reached for ${this.phoneNumber}`);
            // Don't delete session, just stop
        }
    }

    async handleLoggedOut() {
        console.log('🚫 Logged Out - Clearing session...');
        this._cancelAllTimers();
        
        this.isDeviceDisconnected = true;
        this.deviceConnected = false;
        this.deviceDisconnectedAt = new Date();
        this.sessionSaved = false;
        
        // Only clear session data on explicit logout
        await this.sessionManager.clearSessionData();
        this.isReconnecting = false;
        this.isConnected = false;
        this.isPairing = false;
        this.pairingRequested = false;
        this.pairingRetryCount = 0;
        
        await this._notifyDeviceDisconnected();
        
        if (this.callbacks.onConnectionStatus) {
            this.callbacks.onConnectionStatus('logged_out');
        }
        if (this.callbacks.onDisconnected) {
            this.callbacks.onDisconnected('logged_out');
        }
    }

    async saveSession() {
        try {
            const sessionData = {
                creds: this.credsData,
                keys: this.keyStore?.getData() || {},
                connectionStatus: this.status,
                connectedAt: this.connectedAt,
                pairingCode: this.isConnected ? null : this.pairingCode,
                deviceConnected: this.deviceConnected,
                deviceDisconnectedAt: this.deviceDisconnectedAt,
                deviceInfo: this.deviceInfo,
                isDeviceDisconnected: this.isDeviceDisconnected,
                lastUpdated: new Date()
            };

            await this.mongo.saveSession(this.phoneNumber, sessionData);
            this.sessionSaved = true;
            this.lastSessionSave = Date.now();
            console.log(`✅ Session saved for ${this.phoneNumber}`);
        } catch (err) {
            console.error('❌ Failed to save session:', err);
            this.sessionSaved = false;
        }
    }

    async clearPairingCodeFromDB() {
        try {
            await this.mongo.updateSession(this.phoneNumber, { pairingCode: null });
            console.log(`✅ Pairing code cleared from database for ${this.phoneNumber}`);
        } catch (err) {
            console.error('❌ Failed to clear pairing code:', err);
        }
    }

    async clearSessionData() {
        this._cancelAllTimers();
        this.isPairing = false;
        this.pairingComplete = false;
        this.reconnectionAttempts = 0;
        this.pairingRequested = false;
        this.pairingCode = null;
        this.pairingRetryCount = 0;
        this.connectionStartTime = null;
        this.isDeviceDisconnected = false;
        this.deviceConnected = false;
        this.deviceDisconnectRetries = 0;
        this.sessionSaved = false;
        return this.sessionManager.clearSessionData();
    }

    async requestPairing() {
        if (this.pairingRequested) {
            console.log('📱 Pairing already requested. Waiting for user to enter code...');
            return this.pairingCode;
        }
        
        this.isPairing = true;
        this.pairingRequested = true;
        this.pairingRetryCount = 0;
        
        try {
            const code = await this.pairingHandler.requestPairing();
            if (code) {
                this.pairingCode = code;
                console.log('📱 PAIRING CODE GENERATED - Please enter this code in WhatsApp:');
                console.log(`📱 ${code}`);
                console.log('⏳ Waiting for you to enter the code in WhatsApp...');
                console.log('⏱️ Session will auto-delete in 3 minutes if not connected.');
                
                if (this.callbacks.onPairingCode) {
                    this.callbacks.onPairingCode(code);
                }
                return code;
            }
            
            this.isPairing = false;
            this.pairingRequested = false;
            return null;
        } catch (err) {
            this.isPairing = false;
            this.pairingRequested = false;
            console.error('❌ Error requesting pairing code:', err);
            throw err;
        }
    }

    setStatus(status) {
        this.status = status;
        console.log(`📊 Status update for ${this.phoneNumber}: ${status}`);
        
        // Don't save status changes to DB to reduce writes
        if (this.callbacks.onConnectionStatus) {
            this.callbacks.onConnectionStatus(status);
        }
    }

    async handleError(err) {
        console.error('⚠️ Error:', err.message);
        
        // Don't clear session on credential errors unless critical
        if (this._isCredentialError(err)) {
            console.log('🔑 Credential error detected, will try to recover...');
            // Try to repair instead of clearing
            await this._repairSession();
        }
        
        // Check if error indicates device disconnect - don't clear session
        if (this._isDeviceDisconnectError(err)) {
            this.isDeviceDisconnected = true;
            this.deviceConnected = false;
            this.deviceDisconnectedAt = new Date();
            await this._notifyDeviceDisconnected();
            // Save device state but keep session
            await this.saveSession();
        }
        
        if (this.callbacks.onError) {
            this.callbacks.onError(err);
        }
        
        if (!this.isConnected && !this.pairingCode && !this.isPairing && !this.pairingRequested) {
            console.log('🔄 Attempting to get pairing code after error...');
            await this.requestPairing().catch(() => {});
        }
    }

    async disconnect() {
        this.intentionalDisconnect = true;
        this.isPairing = false;
        this.pairingComplete = false;
        this.reconnectionAttempts = 0;
        this.pairingRequested = false;
        this.pairingRetryCount = 0;
        this.isDeviceDisconnected = true;
        
        this._cancelAllTimers();
        this.setStatus('disconnecting');
        
        if (this.sock) {
            try {
                await this.sock.end();
            } catch (e) {
                // Ignore
            }
        }
        
        this.isConnected = false;
        this.isReconnecting = false;
        this.connectionInitiated = false;
        this.deviceConnected = false;
        this.setStatus('disconnected');
        
        // Save disconnect state but keep session
        await this.saveSession();
        await this._notifyDeviceDisconnected();
        
        this.intentionalDisconnect = false;
    }

    async healthCheck() {
        const now = Date.now();
        if (now - this.lastHealthCheck < ConnectionManager.CONFIG.HEALTH_CHECK_INTERVAL) {
            return this.isConnected && this.deviceConnected;
        }
        
        this.lastHealthCheck = now;
        
        if (!this.sock || !this.isConnected) {
            this.deviceConnected = false;
            return false;
        }
        
        try {
            const state = this.sock.connectionState;
            const isOpen = state === 'open';
            this.deviceConnected = isOpen;
            
            if (!isOpen && !this.isDeviceDisconnected) {
                this.isDeviceDisconnected = true;
                this.deviceDisconnectedAt = new Date();
                await this._notifyDeviceDisconnected();
                // Save device state
                await this.saveSession();
            } else if (isOpen && this.isDeviceDisconnected) {
                this.isDeviceDisconnected = false;
                this.deviceDisconnectRetries = 0;
                await this._notifyDeviceConnected();
                // Save device state
                await this.saveSession();
            }
            
            return isOpen;
        } catch (e) {
            this.deviceConnected = false;
            return false;
        }
    }

    // Private helper methods
    _shouldSkipInit() {
        return this.connectionInitiated && !this.isReconnecting && !this.isPairing;
    }

    async _ensureMongoConnection() {
        if (!this.mongo.isConnected) {
            await this.mongo.connect();
        }
    }

    _resetCounters() {
        if (!this.isReconnecting) {
            this.connectionAttempts = 0;
            if (!this.isPairing) {
                this.pairingComplete = false;
                this.reconnectionAttempts = 0;
                this.pairingRequested = false;
                this.pairingRetryCount = 0;
            }
        }
    }

    _closeExistingSocket() {
        if (this.sock) {
            try {
                this.sock.end();
            } catch (e) {
                // Ignore
            }
            this.sock = null;
        }
    }

    async _repairSession() {
        console.log('🔧 Attempting to repair session...');
        try {
            // Try to reload credentials
            await this.loadCredentials();
            
            // If we have valid creds, try to reconnect
            if (this.credsData?.registered) {
                console.log('✅ Credentials valid, attempting to reconnect...');
                await this.init();
                return true;
            }
            
            // If no valid creds, clear and request new pairing
            console.log('🔄 No valid credentials, clearing session...');
            await this.clearSessionData();
            await this.requestPairing();
            return false;
        } catch (err) {
            console.error('❌ Session repair failed:', err);
            return false;
        }
    }

    _createConnectionPromise() {
        return new Promise((resolve, reject) => {
            this.connectionResolve = resolve;
            this.connectionReject = reject;
            
            this.connectionTimeout = setTimeout(async () => {
                console.log('⏰ Connection timeout reached');
                this.connectionTimeout = null;
                
                if (!this.isConnected) {
                    if (this.isPairing) {
                        console.log('🔄 Still in pairing mode, waiting for user to enter code in WhatsApp...');
                        console.log('📱 If you entered the code, please wait a moment for connection.');
                        return;
                    }
                    
                    if (this.credsData?.registered) {
                        console.log('⚠️ Connection timeout with registered creds; will retry...');
                        reject(new Error('Connection timeout with valid credentials'));
                    } else {
                        console.log('🔄 Connection timeout without a valid session, requesting pairing...');
                        this.isPairing = true;
                        await this.requestPairing().catch(err => {
                            this.isPairing = false;
                            reject(new Error('Connection timeout and pairing failed'));
                        });
                    }
                }
            }, ConnectionManager.CONFIG.CONNECTION_TIMEOUT);
        });
    }

    _startSessionDeleteTimer() {
        this._cancelSessionDeleteTimer();
        console.log('⏱️ Session auto-delete timer started (3 minutes)');
        
        this.sessionDeleteTimer = setTimeout(async () => {
            console.log('⏰ 3 minutes elapsed - Session not connected, deleting...');
            
            if (!this.isConnected) {
                console.log('🗑️ Auto-deleting session for', this.phoneNumber);
                await this.clearSessionData();
                if (this.callbacks.onConnectionStatus) {
                    this.callbacks.onConnectionStatus('session_deleted_timeout');
                }
                console.log('✅ Session auto-deleted after 3 minutes');
            } else {
                console.log('✅ Session connected, auto-delete timer cancelled');
            }
            
            this.sessionDeleteTimer = null;
        }, ConnectionManager.CONFIG.SESSION_DELETE_TIMEOUT);
    }

    _cancelSessionDeleteTimer() {
        if (this.sessionDeleteTimer) {
            clearTimeout(this.sessionDeleteTimer);
            this.sessionDeleteTimer = null;
            console.log('⏱️ Session auto-delete timer cancelled');
        }
    }

    _cancelReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    _cancelAllTimers() {
        this._cancelSessionDeleteTimer();
        this._cancelReconnectTimer();
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.pairingTimeout) {
            clearTimeout(this.pairingTimeout);
            this.pairingTimeout = null;
        }
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        if (this.deviceCheckTimer) {
            clearInterval(this.deviceCheckTimer);
            this.deviceCheckTimer = null;
        }
        if (this.saveSessionTimer) {
            clearInterval(this.saveSessionTimer);
            this.saveSessionTimer = null;
        }
    }

    _startHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        this.healthCheckTimer = setInterval(async () => {
            // 🛑 Stop health check if device is disconnected
            if (this.isDeviceDisconnected) {
                console.log('🛑 Health check stopped - device is disconnected');
                return;
            }
            
            const healthy = await this.healthCheck();
            if (!healthy && !this.intentionalDisconnect) {
                console.log('⚠️ Health check failed, attempting to reconnect...');
                await this.init().catch(err => {
                    console.error('Health check reconnection failed:', err);
                });
            }
        }, ConnectionManager.CONFIG.HEALTH_CHECK_INTERVAL);
    }

    _startDeviceCheckTimer() {
        if (this.deviceCheckTimer) {
            clearInterval(this.deviceCheckTimer);
        }
        this.deviceCheckTimer = setInterval(async () => {
            // 🛑 Stop device check if already disconnected
            if (this.isDeviceDisconnected) {
                return;
            }
            await this.isDeviceConnected();
        }, ConnectionManager.CONFIG.DEVICE_DISCONNECT_CHECK_INTERVAL);
    }

    _startSessionSaveTimer() {
        if (this.saveSessionTimer) {
            clearInterval(this.saveSessionTimer);
        }
        this.saveSessionTimer = setInterval(async () => {
            if (this.isConnected && this.credsData?.registered) {
                await this.saveSession();
            }
        }, ConnectionManager.CONFIG.SAVE_SESSION_INTERVAL);
    }

    _resolveConnection(sock) {
        if (this.connectionResolve) {
            this.connectionResolve(sock);
            this.connectionResolve = null;
            this.connectionReject = null;
            if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout);
                this.connectionTimeout = null;
            }
        }
    }

    async _handleQRCode() {
        console.log('📱 QR code generated, requesting pairing code...');
        this.isPairing = true;
        this.pairingRequested = true;
        
        try {
            const code = await this.pairingHandler.requestPairing();
            if (code) {
                this.pairingCode = code;
                console.log(`📱 PAIRING CODE: ${code}`);
                console.log('📱 Please enter this code in WhatsApp to connect.');
                console.log('⏱️ Session will auto-delete in 3 minutes if not connected.');
                if (this.callbacks.onPairingCode) {
                    this.callbacks.onPairingCode(code);
                }
            }
        } catch (err) {
            console.error('❌ Failed to get pairing code:', err);
            this.isPairing = false;
            this.pairingRequested = false;
        }
    }

    async _handleConnectionOpen() {
        console.log('✅ Connection opened successfully');
        this._cancelSessionDeleteTimer();
        await this.handleConnected();
    }

    async _handleConnectionClose(lastDisconnect) {
        console.log('🔌 Connection closed');
        
        if (this.isPairing && !this.isConnected) {
            await this._handlePairingClose();
            return;
        }
        
        if (this.connectionResolve) {
            console.log('⏳ Connection closed during initialization, but continuing...');
            return;
        }
        
        await this.handleDisconnect(lastDisconnect);
    }

    async _handlePairingClose() {
        console.log('🔄 Pairing mode: Connection closed, reconnecting to continue pairing...');
        
        if (this.pairingRetryCount >= ConnectionManager.CONFIG.MAX_PAIRING_RETRIES) {
            console.log('❌ Max pairing retries reached. Cleaning up...');
            this.pairingRetryCount = 0;
            this.isPairing = false;
            this.pairingRequested = false;
            await this.sessionManager.clearSessionData();
            if (this.callbacks.onConnectionStatus) {
                this.callbacks.onConnectionStatus('pairing_failed');
            }
            return;
        }
        
        this.pairingRetryCount++;
        console.log(`🔄 Retry ${this.pairingRetryCount}/${ConnectionManager.CONFIG.MAX_PAIRING_RETRIES} - Recreating socket...`);
        
        setTimeout(async () => {
            if (!this.isConnected && this.isPairing) {
                try {
                    this._closeExistingSocket();
                    const authState = this.createAuthState();
                    const { version } = await fetchLatestBaileysVersion();
                    this.sock = this.createSocket(version, authState);
                    this.setupEventHandlers();
                    console.log('🔄 Socket recreated for pairing. Waiting for connection...');
                    console.log(`📱 Pairing code: ${this.pairingCode}`);
                    console.log('📱 Please enter the code in WhatsApp if you haven\'t already.');
                } catch (err) {
                    console.error('❌ Failed to recreate socket:', err);
                    this.isPairing = false;
                    this.pairingRequested = false;
                }
            }
        }, ConnectionManager.CONFIG.PAIRING_RECONNECT_DELAY);
    }

    async _handlePairingDisconnect() {
        console.log('⏳ In pairing mode - reconnecting to continue...');
        console.log(`📱 Pairing code: ${this.pairingCode}`);
        console.log('📱 Please enter the code in WhatsApp if you haven\'t already.');
        
        if (this.pairingRetryCount < ConnectionManager.CONFIG.MAX_PAIRING_RETRIES) {
            setTimeout(async () => {
                if (!this.isConnected && this.isPairing) {
                    try {
                        this._closeExistingSocket();
                        const authState = this.createAuthState();
                        const { version } = await fetchLatestBaileysVersion();
                        this.sock = this.createSocket(version, authState);
                        this.setupEventHandlers();
                        console.log('🔄 Socket recreated for pairing');
                    } catch (err) {
                        console.error('❌ Failed to recreate socket:', err);
                    }
                }
            }, ConnectionManager.CONFIG.PAIRING_RECONNECT_DELAY);
        }
    }

    async _handleSpecificDisconnect(statusCode, errorMessage) {
        const lowerMessage = errorMessage.toLowerCase();

        if (!this.sock?.authState?.creds?.registered && !this.pairingRequested) {
            console.log('🔄 Not registered, requesting pairing code...');
            this.isPairing = true;
            this.pairingRequested = true;
            await this.requestPairing().catch(err => {
                console.error('Failed to get pairing code:', err);
                this.isPairing = false;
                this.pairingRequested = false;
            });
            return true;
        }

        if (lowerMessage.includes('qr refs attempts ended') && !this.isPairing) {
            console.log('🔑 QR failure detected, repairing session...');
            await this._repairSession();
            return true;
        }

        if (lowerMessage.includes('pairing') || lowerMessage.includes('linked')) {
            console.log('🔑 Pairing failure detected, repairing session...');
            await this._repairSession();
            return true;
        }

        if (statusCode === DisconnectReason.loggedOut) {
            await this.handleLoggedOut();
            return true;
        }

        if (statusCode === DisconnectReason.badSession) {
            console.log('🔑 Bad session detected, repairing...');
            await this._repairSession();
            return true;
        }

        return false;
    }

    _scheduleReconnection() {
        this.reconnectionAttempts++;
        console.log(`🔁 Reconnecting in 5s... (${this.reconnectionAttempts}/${ConnectionManager.CONFIG.MAX_RECONNECTION_ATTEMPTS})`);
        this.setStatus('reconnecting');
        this.isReconnecting = true;
        
        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            // Reset device disconnect retries on reconnection attempt
            this.deviceDisconnectRetries = 0;
            this.init().catch(err => {
                console.error('Reconnection failed:', err);
            });
        }, ConnectionManager.CONFIG.RECONNECT_DELAY);
    }

    async _cleanupAndClearSession() {
        this._cancelSessionDeleteTimer();
        this.isDeviceDisconnected = true;
        this.deviceConnected = false;
        this.sessionSaved = false;
        await this.sessionManager.clearSessionData().catch(() => {});
        await this._notifyDeviceDisconnected();
        
        if (this.callbacks.onConnectionStatus) {
            this.callbacks.onConnectionStatus('session_deleted');
        }
        if (this.callbacks.onDisconnected) {
            this.callbacks.onDisconnected('max_reconnection_attempts');
        }
    }

    _isCredentialError(err) {
        return err.message?.includes('public') || err.message?.includes('undefined');
    }

    _isDeviceDisconnectError(err) {
        const message = typeof err === 'string' ? err : err.message || '';
        const lower = message.toLowerCase();
        return lower.includes('device') || 
               lower.includes('disconnected') || 
               lower.includes('logout') ||
               lower.includes('unlink');
    }

    async _notifyDeviceConnected() {
        console.log(`✅ Device connected for ${this.phoneNumber}`);
        if (this.callbacks.onDeviceConnected) {
            await this.callbacks.onDeviceConnected(this.phoneNumber, this.deviceInfo);
        }
    }

    async _notifyDeviceDisconnected() {
        console.log(`⚠️ Device disconnected for ${this.phoneNumber}`);
        if (this.callbacks.onDeviceDisconnected) {
            await this.callbacks.onDeviceDisconnected(
                this.phoneNumber, 
                this.deviceDisconnectedAt,
                this.deviceDisconnectRetries
            );
        }
    }

    async _handleDeviceUpdate(update) {
        console.log(`📱 Device update for ${this.phoneNumber}:`, update);
        if (update.deviceInfo) {
            this.deviceInfo = {
                ...this.deviceInfo,
                ...update.deviceInfo
            };
            await this.saveSession();
        }
    }

    _handleHistorySync() {
        if (!this.isConnected) {
            console.log('📚 History sync received - connection established');
            this.handleConnected();
        }
    }
}
