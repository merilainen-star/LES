// cryptoVault.js — API key storage using Web Crypto with a non-exportable AES-GCM key.
//
// Threat model: casual dumps of chrome.storage.local see only ciphertext. The
// decryption key is stored in IndexedDB as a non-extractable CryptoKey, so the
// raw bytes never leave the browser's keystore. This does NOT defend against
// malware running with the same browser profile — warn users to cap provider
// spending regardless.

const LES_VAULT_DB = 'les-vault';
const LES_VAULT_STORE = 'keys';
const LES_VAULT_MASTER_ID = 'master';
const LES_VAULT_STORAGE_PREFIX = 'lesVault_';

function lesVaultOpenDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(LES_VAULT_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(LES_VAULT_STORE)) {
                db.createObjectStore(LES_VAULT_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function lesVaultIdbGet(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(LES_VAULT_STORE, 'readonly');
        const req = tx.objectStore(LES_VAULT_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function lesVaultIdbPut(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(LES_VAULT_STORE, 'readwrite');
        const req = tx.objectStore(LES_VAULT_STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function lesVaultGetMasterKey() {
    const db = await lesVaultOpenDb();
    let key = await lesVaultIdbGet(db, LES_VAULT_MASTER_ID);
    if (!key) {
        key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false, // non-extractable — raw bytes never leave the keystore
            ['encrypt', 'decrypt']
        );
        await lesVaultIdbPut(db, LES_VAULT_MASTER_ID, key);
    }
    return key;
}

function lesVaultBytesToB64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function lesVaultB64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function lesVaultEncrypt(plaintext) {
    if (!plaintext) return null;
    const key = await lesVaultGetMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return {
        iv: lesVaultBytesToB64(iv),
        data: lesVaultBytesToB64(new Uint8Array(cipher)),
        v: 1
    };
}

async function lesVaultDecrypt(record) {
    if (!record || !record.iv || !record.data) return '';
    const key = await lesVaultGetMasterKey();
    const iv = lesVaultB64ToBytes(record.iv);
    const data = lesVaultB64ToBytes(record.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plain);
}

function lesVaultStorageKey(name) {
    return LES_VAULT_STORAGE_PREFIX + name;
}

async function lesVaultSetKey(name, plaintext) {
    const storageKey = lesVaultStorageKey(name);
    if (!plaintext) {
        await chrome.storage.local.remove(storageKey);
        return;
    }
    const record = await lesVaultEncrypt(plaintext);
    await chrome.storage.local.set({ [storageKey]: record });
}

async function lesVaultGetKey(name) {
    const storageKey = lesVaultStorageKey(name);
    const data = await chrome.storage.local.get(storageKey);
    const record = data[storageKey];
    if (!record) return '';
    try {
        return await lesVaultDecrypt(record);
    } catch (e) {
        console.warn('LES vault: decrypt failed for', name, e);
        return '';
    }
}

async function lesVaultHasKey(name) {
    const storageKey = lesVaultStorageKey(name);
    const data = await chrome.storage.local.get(storageKey);
    return Boolean(data[storageKey]);
}

async function lesVaultGetKeyMeta(name) {
    const plain = await lesVaultGetKey(name);
    if (!plain) return { present: false, last4: '' };
    const last4 = plain.length >= 4 ? plain.slice(-4) : plain;
    return { present: true, last4 };
}

const LES_VAULT_API = { lesVaultSetKey, lesVaultGetKey, lesVaultHasKey, lesVaultGetKeyMeta };

const LES_VAULT_GLOBAL =
    typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LES_VAULT_API;
} else if (LES_VAULT_GLOBAL) {
    Object.assign(LES_VAULT_GLOBAL, LES_VAULT_API);
}
