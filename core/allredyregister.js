// core/allredyregister.js
import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

export class AlreadyRegisteredHandler {
    constructor(connectionManager) {
        this.connection = connectionManager;
        this._sessionInfo = null;
        this._lastCheck = 0;
        this._checkInterval = 5000; // 5 seconds cache
    }

    /**
     * Check if the current session is already registered
     * @returns {boolean} True if registered
     */
    isRegistered() {
        return !!this.connection.credsData?.registered;
    }

    /**
     * Check if session is valid and can be used
     * @returns {boolean} True if session is valid
     */
    isValidSession() {
        const { credsData, keyStoreData } = this.connection;
        return !!(credsData?.me && credsData?.serverToken && credsData?.clientToken && 
                 keyStoreData && Object.keys(keyStoreData).length > 0);
    }

    /**
     * Main method: Check session and handle accordingly
     * @returns {Promise<Object>} Result
     */
    async checkAndHandleSession() {
        const { phoneNumber, isConnected } = this.connection;
        
        this._logSessionStatus(phoneNumber, isConnected);

        // If already connected, return success
        if (isConnected) {
            return this._createResult('connected', 'Session is already connected', 'keep', {
                socket: this.connection.sock
            });
        }

        // If there's a registered session but not connected
        if (this.isRegistered() && !isConnected) {
            return this._handleExistingSession();
        }

        // No session exists or default case
        return this._handleNewSession();
    }

    /**
     * Force delete existing session and create new one
     * @returns {Promise<Object>} Result
     */
    async forceRecreate() {
        console.log('💥 Force recreating session...');
        await this.connection.clearSessionData();
        return this._createNewSession();
    }

    /**
     * Get session information (cached)
     * @returns {Object} Session information
     */
    getSessionInfo() {
        const now = Date.now();
        if (this._sessionInfo && (now - this._lastCheck) < this._checkInterval) {
            return this._sessionInfo;
        }

        const { phoneNumber, credsData, keyStoreData, isConnected, connectedAt, pairingCode, status } = this.connection;
        
        this._sessionInfo = {
            phoneNumber,
            isRegistered: this.isRegistered(),
            isValidSession: this.isValidSession(),
            isConnected,
            status,
            connectedAt: connectedAt || null,
            hasKeys: !!(keyStoreData && Object.keys(keyStoreData).length > 0),
            pairingCode: pairingCode || null,
            sessionAge: connectedAt ? Math.floor((Date.now() - connectedAt.getTime()) / 1000) : 0,
            credsExists: !!credsData,
            serverTokenExists: !!credsData?.serverToken,
            clientTokenExists: !!credsData?.clientToken,
            me: credsData?.me || null
        };
        
        this._lastCheck = now;
        return this._sessionInfo;
    }

    /**
     * Check if session is stale and needs repair
     * @returns {boolean} True if session is stale
     */
    isStale() {
        const { isConnected, credsData, isPairing } = this.connection;
        return !!(credsData?.registered && !isConnected && !isPairing);
    }

    /**
     * Check and repair stale session
     * @returns {Promise<Object>} Repair result
     */
    async checkAndRepair() {
        if (!this.isStale()) {
            return {
                status: 'not_stale',
                message: 'Session is not stale',
                action: 'keep'
            };
        }
        
        console.log('🔧 Stale session detected. Recreating...');
        return await this.forceRecreate();
    }

    // Private helper methods
    _logSessionStatus(phoneNumber, isConnected) {
        const status = {
            'Phone': phoneNumber,
            'Status': this.connection.status,
            'Connected': isConnected,
            'Registered': this.isRegistered(),
            'Valid Session': this.isValidSession(),
            'Has Creds': !!this.connection.credsData,
            'Has Keys': !!(this.connection.keyStoreData && Object.keys(this.connection.keyStoreData).length > 0)
        };
        
        console.log('📱 Session Check:', JSON.stringify(status, null, 2));
    }

    _createResult(status, message, action, additional = {}) {
        return { status, message, action, ...additional };
    }

    async _handleExistingSession() {
        console.log('⚠️ Session exists but not connected. Deleting and creating new session...');
        await this.connection.clearSessionData();
        console.log('🗑️ Existing session deleted');
        
        const result = await this._createNewSession();
        return this._createResult('new_session_created', 'Existing session was deleted and new session created', 'recreate', result);
    }

    async _handleNewSession() {
        console.log('🔄 Creating new session...');
        const result = await this._createNewSession();
        return this._createResult('new_session_created', 'New session created', 'create', result);
    }

    async _createNewSession() {
        const { phoneNumber } = this.connection;
        console.log(`🆕 Creating new session for ${phoneNumber}...`);
        
        try {
            this._resetConnectionState();
            await this._closeExistingSocket();
            
            const authState = this.connection.createAuthState();
            const { version } = await fetchLatestBaileysVersion();
            
            this.connection.sock = this.connection.createSocket(version, authState);
            this.connection.setupEventHandlers();
            
            return await this._requestPairingCode();
        } catch (err) {
            console.error('❌ Error creating new session:', err);
            throw err;
        }
    }

    _resetConnectionState() {
        const fields = [
            'credsData', 'keyStoreData', 'pairingCode', 'isConnected',
            'isPairing', 'pairingRequested', 'pairingRetryCount',
            'connectionInitiated', 'connectionAttempts'
        ];
        
        fields.forEach(field => {
            if (field === 'credsData') {
                this.connection.credsData = null;
            } else if (field === 'keyStoreData') {
                this.connection.keyStoreData = {};
            } else if (field === 'isConnected') {
                this.connection.isConnected = false;
            } else if (field === 'pairingRetryCount') {
                this.connection.pairingRetryCount = 0;
            } else if (field === 'connectionAttempts') {
                this.connection.connectionAttempts = 0;
            } else {
                this.connection[field] = false;
            }
        });
    }

    async _closeExistingSocket() {
        if (this.connection.sock) {
            try {
                this.connection.sock.end();
            } catch (e) {
                // Ignore
            }
            this.connection.sock = null;
        }
    }

    async _requestPairingCode() {
        this.connection.isPairing = true;
        this.connection.pairingRequested = true;
        
        const code = await this.connection.pairingHandler.requestPairing();
        
        if (!code) {
            throw new Error('Failed to generate pairing code');
        }
        
        this.connection.pairingCode = code;
        console.log(`📱 New PAIRING CODE: ${code}`);
        console.log('📱 Please enter this code in WhatsApp to connect.');
        console.log('⏱️ Session will auto-delete in 3 minutes if not connected.');
        
        if (this.connection.callbacks.onPairingCode) {
            this.connection.callbacks.onPairingCode(code);
        }
        
        return { pairingCode: code, message: 'New session created with pairing code' };
    }
}