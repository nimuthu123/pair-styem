// utils/validator.js
export class CredentialValidator {
    static isValid(creds) {
        if (!creds || typeof creds !== 'object' || Object.keys(creds).length === 0) {
            return false;
        }

        const required = [
            'signedIdentityKey.public',
            'pairingEphemeralKeyPair.public',
            'noiseKey.public'
        ];

        for (const path of required) {
            const parts = path.split('.');
            let current = creds;
            for (const part of parts) {
                if (!current || typeof current[part] === 'undefined') {
                    console.warn(`⚠️ Credentials missing ${path}`);
                    return false;
                }
                current = current[part];
            }
        }

        if (typeof creds.registrationId !== 'number') {
            console.warn('⚠️ Credentials missing registrationId');
            return false;
        }

        return true;
    }
}