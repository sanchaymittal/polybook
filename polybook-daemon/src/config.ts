/**
 * PolyBook Daemon - Configuration Module
 *
 * Loads environment variables with Yellow Network defaults.
 */
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

/**
 * Daemon configuration interface
 */
export interface Config {
    // Server settings
    port: number;
    host: string;

    // Yellow Network
    yellowWsUrl: string;
    chainId: number;
    custodyAddress: string;
    adjudicatorAddress: string;

    // Optional pre-existing private key
    privateKey?: string;
}

/**
 * Gets an optional environment variable with a default value
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns The environment variable value or default
 */
function getEnvOptional(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
}

/**
 * Loads configuration from environment variables
 *
 * @returns Configuration object with Yellow Network defaults
 */
export function loadConfig(): Config {
    return {
        // Server
        port: parseInt(getEnvOptional('PORT', '3402'), 10),
        host: getEnvOptional('HOST', '127.0.0.1'),

        // Yellow Network (sandbox defaults)
        yellowWsUrl: getEnvOptional(
            'YELLOW_WS_URL',
            'wss://clearnet-sandbox.yellow.com/ws'
        ),
        chainId: parseInt(getEnvOptional('CHAIN_ID', '11155111'), 10),
        custodyAddress: getEnvOptional(
            'CUSTODY_ADDRESS',
            '0x019B65A265EB3363822f2752141b3dF16131b262'
        ),
        adjudicatorAddress: getEnvOptional(
            'ADJUDICATOR_ADDRESS',
            '0x7c7ccbc98469190849BCC6c926307794fDfB11F2'
        ),

        // Optional pre-existing private key
        privateKey: process.env.PRIVATE_KEY || undefined,
    };
}

// Singleton config instance
let configInstance: Config | null = null;

/**
 * Gets the singleton configuration instance
 *
 * @returns Configuration object
 */
export function getConfig(): Config {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}
