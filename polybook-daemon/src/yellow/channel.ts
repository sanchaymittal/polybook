/**
 * PolyBook Daemon - Yellow Channel Management
 *
 * Handles channel creation and loading.
 * For hackathon MVP, channel creation is stubbed.
 */
import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
    loadChannel,
    saveChannel,
    channelExists,
    type ChannelData,
} from '../state/store.js';

/**
 * Channel initialization result
 */
export interface ChannelResult {
    success: boolean;
    channelId?: string;
    error?: string;
    isNew?: boolean;
}

/**
 * Generates a stub channel ID for hackathon MVP
 *
 * In production, this would call Yellow RPC to create a real channel.
 *
 * @param address - Agent's Ethereum address
 * @returns Stub channel ID
 */
function generateStubChannelId(address: string): string {
    // Create a deterministic but unique channel ID based on address
    const timestamp = Date.now().toString(16);
    return `0x${address.slice(2, 10)}${timestamp}`.toLowerCase();
}

/**
 * Initializes or loads a Yellow channel
 *
 * For hackathon MVP:
 * - If channel exists in persistence, load it
 * - If not, create a stub channel ID and persist
 *
 * In production, this would:
 * - Call createChannel RPC on ClearNode
 * - Fund the channel via on-chain deposit
 * - Wait for channel to be active
 *
 * @param privateKey - Agent's private key
 * @param jwtToken - JWT token from authentication (optional)
 * @returns Channel initialization result
 */
export async function initializeChannel(
    privateKey: Hex,
    jwtToken?: string
): Promise<ChannelResult> {
    // Check if channel already exists
    if (channelExists()) {
        const existing = loadChannel();
        if (existing) {
            console.log(`Loaded existing channel: ${existing.channelId}`);

            // Update JWT if provided
            if (jwtToken && jwtToken !== existing.jwtToken) {
                saveChannel({
                    ...existing,
                    jwtToken,
                    updatedAt: new Date().toISOString(),
                });
            }

            return {
                success: true,
                channelId: existing.channelId,
                isNew: false,
            };
        }
    }

    // Create new channel (stubbed for hackathon)
    try {
        const account = privateKeyToAccount(privateKey);
        const address = account.address;

        console.log('Creating new channel (stub for hackathon)...');

        // Generate stub channel ID
        const channelId = generateStubChannelId(address);

        // Persist channel data
        const channelData: ChannelData = {
            channelId,
            jwtToken,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        saveChannel(channelData);

        console.log(`Created new channel: ${channelId}`);

        return {
            success: true,
            channelId,
            isNew: true,
        };
    } catch (error) {
        console.error('Failed to create channel:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Gets the current channel ID if one exists
 *
 * @returns Channel ID or null
 */
export function getCurrentChannelId(): string | null {
    const channel = loadChannel();
    return channel?.channelId ?? null;
}

/**
 * Gets the stored JWT token for reconnection
 *
 * @returns JWT token or null
 */
export function getStoredJwtToken(): string | null {
    const channel = loadChannel();
    return channel?.jwtToken ?? null;
}
