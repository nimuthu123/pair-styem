// models/Session.js
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    creds: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    sessionData: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    connectionStatus: {
        type: String,
        enum: ['connected', 'disconnected', 'connecting', 'reconnecting', 'error'],
        default: 'disconnected'
    },
    connectedAt: {
        type: Date,
        default: null
    },
    pairingCode: {
        type: String,
        default: null
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
