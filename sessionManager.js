// sessionManager.js
import { ConnectionManager } from './core/connection.js';

export class SessionManager {
    constructor(phoneNumber, mongoUri = null) {
        this.phoneNumber = phoneNumber;
        
        // Get MongoDB URI from multiple sources
        this.mongoUri = mongoUri || 
                       process.env.MONGODB_URI || 
                       'mongodb://nimuthu:200939nimuthu@ac-wgnvpo1-shard-00-00.gcqvqse.mongodb.net:27017,ac-wgnvpo1-shard-00-01.gcqvqse.mongodb.net:27017,ac-wgnvpo1-shard-00-02.gcqvqse.mongodb.net:27017/?ssl=true&replicaSet=atlas-11p6yd-shard-0&authSource=admin&appName=whatsappbot';
        
        if (!this.mongoUri || this.mongoUri === 'undefined') {
            console.error('❌ MongoDB URI is not set!');
            throw new Error('MongoDB URI is required');
        }
        
        console.log('📱 Initializing SessionManager for:', phoneNumber);
        
        this.connectionManager = new ConnectionManager(phoneNumber, this.mongoUri);
        this.lastBotStatus = null;
        
        // Bind callbacks
        this.connectionManager.setCallbacks({
            onPairingCode: this._onPairingCode.bind(this),
            onConnectionStatus: this._onConnectionStatus.bind(this),
            onConnected: this._onConnected.bind(this)
        });
    }

    // Public methods
    async initConnection() {
        try {
            return await this.connectionManager.init();
        } catch (err) {
            console.error('Init error:', err);
            throw err;
        }
    }

    async requestPairingCode() {
        return this.connectionManager.requestPairing();
    }

    async sendMessage(jid, text) {
        if (!this.connectionManager.isConnected || !this.connectionManager.sock) {
            throw new Error('Socket not connected');
        }
        return this.connectionManager.sock.sendMessage(jid, { text });
    }

    async softDisconnect() {
        this.connectionManager.intentionalDisconnect = true;
        if (this.connectionManager.sock) {
            this.connectionManager.sock.ev.removeAllListeners();
            this.connectionManager.sock.end();
        }
        await this.connectionManager.clearSessionData();
        this.connectionManager.setStatus('disconnected');
    }

    async disconnect() {
        if (this.connectionManager.sock) {
            await this.connectionManager.sock.logout();
        }
        await this.connectionManager.clearSessionData();
        this.connectionManager.setStatus('disconnected');
    }

    async resetSession() {
        console.log('🔄 Resetting session for', this.phoneNumber);
        if (this.connectionManager.sock) {
            this.connectionManager.sock.ev.removeAllListeners();
            await this.connectionManager.sock.end();
            this.connectionManager.sock = null;
        }
        await this.connectionManager.clearSessionData();
        this.connectionManager.isReconnecting = false;
        this.connectionManager.connectionInitiated = false;
        this.connectionManager.setStatus('disconnected');
        console.log('✅ Session reset complete');
    }

    async cleanup() {
        if (this.connectionManager.sock) {
            await this.connectionManager.sock.end();
            this.connectionManager.sock = null;
        }
        await this.connectionManager.clearSessionData();
        await this.connectionManager.mongo.disconnect();
        console.log('🧹 Cleanup completed');
    }

    // Getters
    getPairingCode() {
        return this.connectionManager.pairingCode;
    }

    getConnectionStatus() {
        return this.connectionManager.status;
    }

    isConnected() {
        return this.connectionManager.isConnected;
    }

    get reconnectAttempts() {
        return this.connectionManager.reconnectAttempts || 0;
    }

    get maxReconnectAttempts() {
        return this.connectionManager.maxReconnectAttempts || 0;
    }

    // ADDED: isRegistered method
    isRegistered() {
        return this.connectionManager.sock && 
               this.connectionManager.sock.authState?.creds?.registered;
    }

    getSocket() {
        return this.connectionManager.sock;
    }

    // ADDED: _notifyStatusChange method
    _notifyStatusChange(status) {
        this.lastBotStatus = status;
        if (this.onConnectionStatus) {
            this.onConnectionStatus(status);
        }
    }

    // Callback handlers
    _onPairingCode(code, error) {
        if (this.onPairingCode) this.onPairingCode(code, error);
    }

    _onConnectionStatus(status) {
        this.lastBotStatus = status;
        if (this.onConnectionStatus) this.onConnectionStatus(status);
    }

    _onConnected(sock) {
        if (this.onConnected) this.onConnected(sock);
    }

    // Set callbacks
    setPairingCodeCallback(cb) {
        this.onPairingCode = cb;
    }

    setConnectionStatusCallback(cb) {
        this.onConnectionStatus = cb;
    }

    setOnConnectedCallback(cb) {
        this.onConnected = cb;
    }
}

export { Session } from './models/Session.js';