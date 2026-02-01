/**
 * PolyBook Orchestrator - Configuration Module
 *
 * Loads and validates environment configuration for the market orchestrator.
 */
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Orchestrator configuration interface
 */
export interface Config {
    // Private key for signing
    privateKey: string;

    // Ethereum RPC
    alchemyRpcUrl: string;

    // Yellow Network
    yellowWsUrl: string;
    yellowFaucetUrl: string;
    yellowCustodyAddress: string;
    yellowAdjudicatorAddress: string;

    // Deployed Contracts
    marketRegistryAddress: string;
    yellowVerifierAddress: string;

    // Chain
    chainId: number;

    // Logging
    logLevel: string;
}

/**
 * Gets a required environment variable or throws
 */
function getEnvRequired(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

/**
 * Gets an optional environment variable with a default
 */
function getEnvOptional(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
}

/**
 * Loads configuration from environment
 */
export function loadConfig(): Config {
    return {
        privateKey: getEnvRequired('PRIVATE_KEY'),
        alchemyRpcUrl: getEnvRequired('ALCHEMY_RPC_URL'),
        yellowWsUrl: getEnvOptional('YELLOW_WS_URL', 'wss://clearnet-sandbox.yellow.com/ws'),
        yellowFaucetUrl: getEnvOptional(
            'YELLOW_FAUCET_URL',
            'https://clearnet-sandbox.yellow.com/faucet/requestTokens'
        ),
        yellowCustodyAddress: getEnvOptional(
            'YELLOW_CUSTODY_ADDRESS',
            '0x019B65A265EB3363822f2752141b3dF16131b262'
        ),
        yellowAdjudicatorAddress: getEnvOptional(
            'YELLOW_ADJUDICATOR_ADDRESS',
            '0x7c7ccbc98469190849BCC6c926307794fDfB11F2'
        ),
        marketRegistryAddress: getEnvOptional('MARKET_REGISTRY_ADDRESS', ''),
        yellowVerifierAddress: getEnvOptional('YELLOW_VERIFIER_ADDRESS', ''),
        chainId: parseInt(getEnvOptional('CHAIN_ID', '11155111'), 10),
        logLevel: getEnvOptional('LOG_LEVEL', 'info'),
    };
}

// Singleton config instance
let configInstance: Config | null = null;

/**
 * Gets the singleton config instance
 */
export function getConfig(): Config {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}
