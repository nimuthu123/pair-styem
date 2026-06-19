// database/mongo.js
import mongoose from 'mongoose';
import { Session } from '../models/Session.js';
import { DataSerializer } from '../utils/serializer.js';
import { CredentialValidator } from '../utils/validator.js';

export class MongoManager {
    constructor(uri) {
        // FIXED: Ensure URI is provided
        if (!uri) {
            throw new Error('MongoDB URI is required. Please provide a valid connection string.');
        }
        this.uri = uri;
        this.connected = false;
    }

    async connect() {
        try {
            if (mongoose.connection.readyState === 1) {
                this.connected = true;
                return;
            }

            console.log('🔗 Connecting to MongoDB...');
            await mongoose.connect(this.uri, {
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000,
            });
            this.connected = true;
            console.log('✅ MongoDB Connected Successfully');
            
            // Clean up indexes
            try {
                const collection = mongoose.connection.collection('sessions');
                await collection.dropIndex('session_name_1').catch(() => {});
                await collection.dropIndex('phoneNumber_1').catch(() => {});
                await collection.createIndex({ phoneNumber: 1 }, { unique: true });
            } catch (err) {
                // Index might not exist, ignore
            }
        } catch (err) {
            console.error('❌ MongoDB Connection Error:', err.message);
            this.connected = false;
            throw err;
        }
    }

    async disconnect() {
        try {
            if (mongoose.connection.readyState === 1) {
                await mongoose.disconnect();
                this.connected = false;
                console.log('✅ MongoDB Disconnected');
            }
        } catch (err) {
            console.error('❌ MongoDB Disconnect Error:', err);
        }
    }

    async getSession(phoneNumber) {
        try {
            return await Session.findOne({ phoneNumber });
        } catch (err) {
            console.error('❌ Error getting session:', err);
            return null;
        }
    }

    async saveSession(phoneNumber, data) {
        try {
            const { creds, keys, connectionStatus, connectedAt, pairingCode } = data;
            
            // Validate credentials before saving
            if (creds && Object.keys(creds).length > 0) {
                if (!CredentialValidator.isValid(creds)) {
                    throw new Error('Invalid credentials structure');
                }
            }

            const result = await Session.findOneAndUpdate(
                { phoneNumber },
                {
                    phoneNumber,
                    creds: DataSerializer.serialize(creds || {}),
                    sessionData: {
                        keys: DataSerializer.serialize(keys || {})
                    },
                    connectionStatus,
                    connectedAt,
                    pairingCode,
                    lastUpdated: new Date()
                },
                { 
                    upsert: true, 
                    returnDocument: 'after',
                    setDefaultsOnInsert: true
                }
            );

            return result;
        } catch (err) {
            console.error('❌ Error saving session:', err);
            throw err;
        }
    }

    async updateStatus(phoneNumber, status) {
        try {
            await Session.findOneAndUpdate(
                { phoneNumber },
                { 
                    connectionStatus: status,
                    lastUpdated: new Date()
                },
                { returnDocument: 'after' }
            );
        } catch (err) {
            console.error('❌ Error updating status:', err);
        }
    }

    async deleteSession(phoneNumber) {
        try {
            const result = await Session.deleteOne({ phoneNumber });
            if (result.deletedCount > 0) {
                console.log(`✅ Session deleted for ${phoneNumber}`);
            }
            return result;
        } catch (err) {
            console.error('❌ Error deleting session:', err);
            throw err;
        }
    }
}
