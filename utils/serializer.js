// utils/serializer.js
export class DataSerializer {
    // Normalize data from various formats
    static normalize(data) {
        if (data === null || data === undefined) return data;
        if (Buffer.isBuffer(data)) return data;
        if (data instanceof Uint8Array) return Buffer.from(data);
        if (data && data._bsontype === 'Binary') {
            return Buffer.from(data.buffer || data.value || []);
        }
        if (data && data.type === 'Buffer' && typeof data.data === 'string') {
            return Buffer.from(data.data, 'base64');
        }
        if (Array.isArray(data)) {
            return data.map(item => this.normalize(item));
        }
        if (typeof data === 'object') {
            const normalized = {};
            for (const key of Object.keys(data)) {
                normalized[key] = this.normalize(data[key]);
            }
            return normalized;
        }
        return data;
    }

    // Serialize for MongoDB storage
    static serialize(data) {
        if (data === null || data === undefined) return data;
        
        const serialize = (obj) => {
            if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
                return {
                    type: 'Buffer',
                    data: Buffer.from(obj).toString('base64')
                };
            }
            if (Array.isArray(obj)) {
                return obj.map(item => serialize(item));
            }
            if (typeof obj === 'object' && obj !== null) {
                const result = {};
                for (const key of Object.keys(obj)) {
                    result[key] = serialize(obj[key]);
                }
                return result;
            }
            return obj;
        };
        return serialize(data);
    }

    // Deserialize from MongoDB
    static deserialize(data) {
        if (data === null || data === undefined) return data;
        
        const deserialize = (obj) => {
            if (obj && typeof obj === 'object' && obj.type === 'Buffer' && typeof obj.data === 'string') {
                return Buffer.from(obj.data, 'base64');
            }
            if (Array.isArray(obj)) {
                return obj.map(item => deserialize(item));
            }
            if (typeof obj === 'object' && obj !== null) {
                const result = {};
                for (const key of Object.keys(obj)) {
                    result[key] = deserialize(obj[key]);
                }
                return result;
            }
            return obj;
        };
        return deserialize(data);
    }
}