// core/memoryclear.js - Optimized version
export class MemoryCleaner {
    constructor(connectionManager) {
        this.connection = connectionManager;
    }

    /**
     * Clean up memory and resources for a disconnected session
     */
    async cleanupMemory() {
        const { phoneNumber } = this.connection;
        console.log(`🧹 Cleaning up memory for ${phoneNumber}`);

        // Clear all timeouts
        this._clearTimeouts();
        
        // Close socket
        this._closeSocket();
        
        // Reset connection state
        this._resetState();
        
        console.log(`✅ Memory cleaned for ${phoneNumber}`);
    }

    /**
     * Clear all data including credentials
     */
    async fullCleanup() {
        console.log(`🧹 Performing full cleanup for ${this.connection.phoneNumber}`);
        
        // Clear credentials
        this.connection.credsData = null;
        this.connection.keyStoreData = {};
        
        // Clear memory
        await this.cleanupMemory();
        
        console.log(`✅ Full cleanup completed for ${this.connection.phoneNumber}`);
    }

    // Private helper methods
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
                console.debug(`Socket close error for ${this.connection.phoneNumber}:`, e.message);
            }
            this.connection.sock = null;
        }
    }

    _resetState() {
        this.connection.isConnected = false;
        this.connection.isReconnecting = false;
        this.connection.connectionInitiated = false;
        this.connection.reconnectAttempts = 0;
        this.connection.pairingCode = null;
        this.connection.connectedAt = null;
        this.connection.connectionResolve = null;
        this.connection.connectionReject = null;
    }
}