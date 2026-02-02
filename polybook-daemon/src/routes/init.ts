/**
 * PolyBook Daemon - Init Route
 *
 * POST /init - Bootstrap the daemon
 * This is the primary initialization endpoint.
 */
import { FastifyInstance } from 'fastify';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { type Hex } from 'viem';
import { getConfig } from '../config.js';
import {
    keysExist,
    loadKeys,
    saveKeys,
    type KeysData,
} from '../state/store.js';
import { getYellowClient } from '../yellow/client.js';
import { authenticateWithYellow } from '../yellow/auth.js';
import { initializeChannel, getCurrentChannelId } from '../yellow/channel.js';

/**
 * Init response schema
 */
interface InitResponse {
    status: 'ready' | 'error';
    agent_address?: string;
    channel_id?: string;
    error?: string;
    details?: {
        key_loaded: boolean;
        key_generated: boolean;
        yellow_connected: boolean;
        yellow_authenticated: boolean;
        channel_loaded: boolean;
        channel_created: boolean;
    };
}

/**
 * Daemon state tracking
 */
interface DaemonState {
    initialized: boolean;
    privateKey: Hex | null;
    address: string | null;
    channelId: string | null;
}

// Module-level state
const daemonState: DaemonState = {
    initialized: false,
    privateKey: null,
    address: null,
    channelId: null,
};

/**
 * Gets current daemon state (for status endpoint)
 */
export function getDaemonState(): DaemonState {
    return { ...daemonState };
}

/**
 * Registers the /init route
 *
 * @param app - Fastify instance
 */
export async function registerInitRoute(app: FastifyInstance): Promise<void> {
    app.post('/init', async (_request, reply) => {
        console.log('\n=== POST /init ===\n');

        const details = {
            key_loaded: false,
            key_generated: false,
            yellow_connected: false,
            yellow_authenticated: false,
            channel_loaded: false,
            channel_created: false,
        };

        try {
            // Step 1: Load or generate private key
            let privateKey: Hex;
            let address: string;

            if (keysExist()) {
                // Load existing key
                const existingKeys = loadKeys();
                if (!existingKeys) {
                    throw new Error('Failed to load existing keys');
                }
                privateKey = existingKeys.privateKey as Hex;
                address = existingKeys.address;
                details.key_loaded = true;
                console.log(`Loaded existing key: ${address}`);
            } else {
                // Check for env-provided key
                const config = getConfig();
                if (config.privateKey) {
                    privateKey = config.privateKey as Hex;
                    const account = privateKeyToAccount(privateKey);
                    address = account.address;
                    details.key_loaded = true;
                    console.log(`Using env-provided key: ${address}`);
                } else {
                    // Generate new key
                    privateKey = generatePrivateKey();
                    const account = privateKeyToAccount(privateKey);
                    address = account.address;
                    details.key_generated = true;
                    console.log(`Generated new key: ${address}`);
                }

                // Persist key
                const keysData: KeysData = {
                    privateKey,
                    address,
                    createdAt: new Date().toISOString(),
                };
                saveKeys(keysData);
            }

            // Update daemon state
            daemonState.privateKey = privateKey;
            daemonState.address = address;

            // Step 2: Connect to Yellow Network
            const client = getYellowClient();
            const clientState = client.getState();

            if (!clientState.connected) {
                await client.connect();
                details.yellow_connected = true;
                console.log('Connected to Yellow Network');
            } else {
                details.yellow_connected = true;
                console.log('Already connected to Yellow Network');
            }

            // Step 3: Authenticate with Yellow
            if (!clientState.authenticated) {
                const authResult = await authenticateWithYellow(privateKey);

                if (!authResult.success) {
                    console.error('Authentication failed:', authResult.error);
                    // Continue anyway for hackathon - channel can still be created
                    console.log('Continuing without authentication (hackathon mode)');
                } else {
                    details.yellow_authenticated = true;
                    console.log('Authenticated with Yellow Network');
                }
            } else {
                details.yellow_authenticated = true;
                console.log('Already authenticated with Yellow Network');
            }

            // Step 4: Initialize channel
            const channelResult = await initializeChannel(
                privateKey,
                clientState.jwtToken
            );

            if (!channelResult.success) {
                throw new Error(`Channel init failed: ${channelResult.error}`);
            }

            if (channelResult.isNew) {
                details.channel_created = true;
            } else {
                details.channel_loaded = true;
            }

            daemonState.channelId = channelResult.channelId ?? null;
            daemonState.initialized = true;

            // Success response
            const response: InitResponse = {
                status: 'ready',
                agent_address: address,
                channel_id: channelResult.channelId,
                details,
            };

            console.log('\n=== Init Complete ===\n');
            return reply.status(200).send(response);

        } catch (error) {
            console.error('Init failed:', error);

            const response: InitResponse = {
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
                details,
            };

            return reply.status(500).send(response);
        }
    });
}
