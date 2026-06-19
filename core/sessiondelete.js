// core/sessiondelete.js - Optimized version
export class SessionManager {
    constructor(connectionManager) {
        this.connection = connectionManager;
    }

    /**
     * Clear session data from memory and database
     */
    async clearSessionData() {
        const { phoneNumber } = this.connection;
        console.log(`🗑️ Clearing session data for ${phoneNumber}`);
        
        try {
            await this._deleteFromDatabase();
        } catch (err) {
            console.error('❌ Failed to delete session from MongoDB:', err);
        }

        this._clearMemory();
        this._clearTimeouts();
        this._closeSocket();
        
        console.log(`🧹 Session data cleared for ${phoneNumber}`);
    }

    /**
     * Force delete session without any checks
     */
    async forceDeleteSession() {
        console.log(`💥 Force deleting session for ${this.connection.phoneNumber}`);
        await this.clearSessionData();
    }

    /**
     * Check if session is valid
     * @returns {boolean} True if session is valid
     */
    isValidSession() {
        const { credsData, keyStoreData } = this.connection;
        
        if (!credsData || !keyStoreData || typeof credsData !== 'object' || typeof keyStoreData !== 'object') {
            return false;
        }
        
        return !!(credsData.me && credsData.serverToken && credsData.clientToken);
    }

    /**
     * Get session statistics
     * @returns {Object} Session statistics
     */
    getSessionStats() {
        const { phoneNumber, credsData, keyStoreData, isConnected, connectedAt } = this.connection;
        
        return {
            phoneNumber,
            hasCredentials: !!credsData,
            hasKeys: !!(keyStoreData && Object.keys(keyStoreData).length > 0),
            isConnected,
            connectedAt: connectedAt || null,
            sessionAge: connectedAt ? Math.floor((Date.now() - connectedAt.getTime()) / 1000) : 0,
            credentialsRegistered: credsData?.registered || false,
            keyCount: keyStoreData ? Object.keys(keyStoreData).length : 0
        };
    }

    /**
     * Export session data for backup
     * @returns {Object} Session data
     */
    exportSessionData() {
        const { phoneNumber, credsData, keyStoreData } = this.connection;
        
        return {
            phoneNumber,
            creds: credsData,
            keys: keyStoreData,
            exportedAt: new Date().toISOString(),
            version: '1.0'
        };
    }

    /**
     * Import session data from backup
     * @param {Object} data - Session data to import
     */
    async importSessionData(data) {
        if (!data.creds || !data.keys) {
            throw new Error('Invalid session data: missing creds or keys');
        }
        
        console.log(`📥 Importing session data for ${data.phoneNumber || this.connection.phoneNumber}`);
        
        await this.clearSessionData();
        this.connection.credsData = data.creds;
        this.connection.keyStoreData = data.keys;
        await this.connection.saveSession();
        
        console.log(`✅ Session data imported successfully`);
    }

    // Private helper methods
    async _deleteFromDatabase() {
        await this.connection.mongo.deleteSession(this.connection.phoneNumber);
        console.log(`✅ Session deleted from MongoDB for ${this.connection.phoneNumber}`);
    }

    _clearMemory() {
        this.connection.credsData = null;
        this.connection.keyStoreData = {};
        this.connection.pairingCode = null;
        this.connection.isConnected = false;
        this.connection.connectionInitiated = false;
        this.connection.isReconnecting = false;
        this.connection.reconnectAttempts = 0;
        this.connection.connectedAt = null;
    }

    _clearTimeouts() {
        const timeouts = ['pairingTimeout', 'reconnectTimer', 'connectionTimeout', 'sessionDeleteTimer'];
        timeouts.forEach(name => {
            if (this.connection[name]) {
                clearTimeout(this.connection[name]);
                this.connection[name] = null;
            }
        });
    }

    _closeSocket() {
        if (this.connection.sock) {
            try {
                this.connection.sock.end();
            } catch (e) {
                console.debug(`Socket close error during session clear for ${this.connection.phoneNumber}:`, e.message);
            }
            this.connection.sock = null;
        }
    }
}