// core/paircode.js - Optimized version
export class PairingHandler {
    constructor(connectionManager) {
        this.connection = connectionManager;
        this.pendingRequest = null;
    }

    /**
     * Request a pairing code for the phone number
     * @returns {Promise<string|null>} The pairing code or null if already registered
     */
    async requestPairing() {
        // Prevent multiple concurrent pairing requests
        if (this.pendingRequest) {
            return this.pendingRequest;
        }

        this.pendingRequest = this._doRequestPairing();
        try {
            return await this.pendingRequest;
        } finally {
            this.pendingRequest = null;
        }
    }

    /**
     * Generate a QR code alternative (pairing code)
     * @returns {Promise<string>} Formatted pairing code
     */
    async generatePairingCode() {
        const code = await this.requestPairing();
        if (!code) {
            throw new Error('Failed to generate pairing code');
        }
        return this.formatPairingCode(code);
    }

    /**
     * Format pairing code for better readability
     * @param {string} code - The raw pairing code
     * @returns {string} Formatted code
     */
    formatPairingCode(code) {
        if (!code) return '';
        const cleaned = code.replace(/\D/g, '');
        return cleaned.match(/.{1,3}/g)?.join('-') || cleaned;
    }

    /**
     * Cancel any ongoing pairing attempt
     */
    cancelPairing() {
        if (this.connection.pairingTimeout) {
            clearTimeout(this.connection.pairingTimeout);
            this.connection.pairingTimeout = null;
            console.log(`🛑 Pairing cancelled for ${this.connection.phoneNumber}`);
            return true;
        }
        return false;
    }

    // Private methods
    async _doRequestPairing() {
        const { sock, phoneNumber, isConnected } = this.connection;
        
        try {
            await this._ensureSocket();
            await this._handleRegisteredState();
            
            this._clearPairingTimeout();
            
            console.log(`📱 Requesting pairing code for ${phoneNumber}...`);
            const code = await sock.requestPairingCode(phoneNumber);
            this.connection.pairingCode = code;
            console.log(`📱 PAIRING CODE: ${code}`);
            
            this._startPairingTimeout();
            this._notifyCallback(code);
            
            return code;
        } catch (err) {
            console.error('❌ Error requesting pairing code:', err);
            throw err;
        }
    }

    async _ensureSocket() {
        if (!this.connection.sock) {
            console.log('🔄 Socket not initialized, initializing...');
            await this.connection.init();
            if (!this.connection.sock) {
                throw new Error('Failed to initialize socket');
            }
        }
    }

    async _handleRegisteredState() {
        const sock = this.connection.sock;
        
        if (sock.authState?.creds?.registered) {
            if (this.connection.isConnected) {
                console.log('✅ Already registered and connected');
                return;
            }

            if (this.connection.staleSessionRepairAttempts < this.connection.maxStaleSessionRepairAttempts) {
                console.log('⚠️ Credentials appear registered but socket is not connected; clearing stale session and forcing fresh pairing.');
                this.connection.staleSessionRepairAttempts += 1;
                await this.connection.sessionManager.clearSessionData();
                await this.connection.init();
                await this._doRequestPairing();
                return;
            }

            console.log('⚠️ Already registered but not connected; stale session repair limit reached. Clearing session before retry.');
            await this.connection.sessionManager.clearSessionData();
            throw new Error('Stale registered session detected and cleared; retry request to generate new pairing code.');
        }
    }

    _clearPairingTimeout() {
        if (this.connection.pairingTimeout) {
            clearTimeout(this.connection.pairingTimeout);
            this.connection.pairingTimeout = null;
        }
    }

    _startPairingTimeout() {
        const timeout = 300000; // 5 minutes
        this.connection.pairingTimeout = setTimeout(async () => {
            if (!this.connection.isConnected) {
                console.log(`⏳ Pairing timed out for ${this.connection.phoneNumber} (5 minutes elapsed). Deleting session...`);
                await this.connection.sessionManager.clearSessionData();
                if (this.connection.callbacks.onConnectionStatus) {
                    this.connection.callbacks.onConnectionStatus('session_deleted_timeout');
                }
            } else {
                console.log(`✅ Device connected successfully for ${this.connection.phoneNumber}, timeout not triggered`);
            }
        }, timeout);
    }

    _notifyCallback(code) {
        if (this.connection.callbacks.onPairingCode) {
            this.connection.callbacks.onPairingCode(code);
        }
    }
}
