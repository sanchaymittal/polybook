/**
 * PolyBook v1 - Local Contract Addresses
 *
 * Deployed contract addresses for local Anvil testing.
 */

// Anvil default account 0
export const DEPLOYER_PRIVATE_KEY =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

export const DEPLOYER_ADDRESS =
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

// Anvil account 1 - LP
export const LP_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

export const LP_ADDRESS =
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

// Anvil account 2 - Trader A
export const TRADER_A_PRIVATE_KEY =
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

export const TRADER_A_ADDRESS =
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;

// Anvil account 3 - Trader B
export const TRADER_B_PRIVATE_KEY =
    '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;

export const TRADER_B_ADDRESS =
    '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const;

// Deployed contract addresses
export const CONTRACTS = {
    EXCHANGE: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0' as const, // Native Logic Deployment (Fixed Roles)
    USDC: '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const, // Native Logic Deployment
    CTF: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const, // Native Logic Deployment (Original)
} as const;

// Local RPC
export const RPC_URL = 'http://127.0.0.1:8545' as const;
export const CHAIN_ID = 31337;
