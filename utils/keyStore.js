// utils/keyStore.js
import { DataSerializer } from './serializer.js';

export class KeyStore {
    constructor(initialKeys = {}) {
        this.store = DataSerializer.normalize(initialKeys || {});
    }

    get = async (type, ids) => {
        const data = {};
        const category = this.store[type] || {};
        for (const id of ids) {
            if (typeof category[id] !== 'undefined') {
                data[id] = category[id];
            }
        }
        return data;
    }

    set = async (data) => {
        for (const category in data) {
            if (!this.store[category]) {
                this.store[category] = {};
            }
            for (const id in data[category]) {
                const value = data[category][id];
                if (value) {
                    this.store[category][id] = DataSerializer.normalize(value);
                } else {
                    delete this.store[category][id];
                }
            }
        }
        return this.store;
    }

    getData() {
        return this.store;
    }
}
