/**
 * PolyBook Daemon - State Store
 *
 * JSON file persistence for keys and channel state.
 * Data is stored in the data/ directory (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');
const KEYS_FILE = join(DATA_DIR, 'keys.json');
const CHANNEL_FILE = join(DATA_DIR, 'channel.json');

/**
 * Stored key data
 */
export interface KeysData {
    privateKey: string;      // Hex string with 0x prefix
    address: string;         // Derived address
    createdAt: string;       // ISO timestamp
}

/**
 * Stored channel data
 */
export interface ChannelData {
    channelId: string;       // Yellow channel ID
    jwtToken?: string;       // JWT for reconnection
    createdAt: string;       // ISO timestamp
    updatedAt: string;       // ISO timestamp
}

/**
 * Ensures the data directory exists
 */
function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Checks if keys file exists
 *
 * @returns True if keys are persisted
 */
export function keysExist(): boolean {
    return existsSync(KEYS_FILE);
}

/**
 * Loads stored keys from disk
 *
 * @returns Keys data or null if not found
 */
export function loadKeys(): KeysData | null {
    if (!keysExist()) {
        return null;
    }

    try {
        const data = readFileSync(KEYS_FILE, 'utf-8');
        return JSON.parse(data) as KeysData;
    } catch (error) {
        console.error('Failed to load keys:', error);
        return null;
    }
}

/**
 * Saves keys to disk
 *
 * @param keys - Keys data to persist
 */
export function saveKeys(keys: KeysData): void {
    ensureDataDir();
    writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf-8');
    console.log('Keys saved to:', KEYS_FILE);
}

/**
 * Checks if channel file exists
 *
 * @returns True if channel is persisted
 */
export function channelExists(): boolean {
    return existsSync(CHANNEL_FILE);
}

/**
 * Loads stored channel data from disk
 *
 * @returns Channel data or null if not found
 */
export function loadChannel(): ChannelData | null {
    if (!channelExists()) {
        return null;
    }

    try {
        const data = readFileSync(CHANNEL_FILE, 'utf-8');
        return JSON.parse(data) as ChannelData;
    } catch (error) {
        console.error('Failed to load channel:', error);
        return null;
    }
}

/**
 * Saves channel data to disk
 *
 * @param channel - Channel data to persist
 */
export function saveChannel(channel: ChannelData): void {
    ensureDataDir();
    writeFileSync(CHANNEL_FILE, JSON.stringify(channel, null, 2), 'utf-8');
    console.log('Channel saved to:', CHANNEL_FILE);
}

/**
 * Updates channel data (preserves existing fields)
 *
 * @param updates - Partial channel data to update
 */
export function updateChannel(updates: Partial<ChannelData>): void {
    const existing = loadChannel();
    if (!existing) {
        throw new Error('No channel exists to update');
    }

    const updated: ChannelData = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
    };

    saveChannel(updated);
}
