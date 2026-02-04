/**
 * PolyBook v1 - Phase 6: Register Tokens
 *
 * Registers outcome tokens with the CTFExchange and adds operator.
 * Must be run by admin account (deployer).
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
    CONTRACTS,
    DEPLOYER_PRIVATE_KEY,
    DEPLOYER_ADDRESS,
    RPC_URL,
} from '../clob/src/contracts.js';
import { MARKET_STATE } from '../clob/src/market-state.js';

// CTFExchange ABI (relevant functions only)
const EXCHANGE_ABI = parseAbi([
    'function addOperator(address operator_) external',
    'function registerToken(uint256 token, uint256 complement, bytes32 conditionId) external',
    'function isOperator(address operator_) external view returns (bool)',
    'function getConditionId(uint256 tokenId) external view returns (bytes32)',
    'function isAdmin(address admin_) external view returns (bool)',
]);

async function main() {
    console.log('=== Phase 6: Register Tokens ===\n');

    // Create clients
    const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const publicClient = createPublicClient({
        chain: anvil,
        transport: http(RPC_URL),
    });
    const walletClient = createWalletClient({
        account,
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Verify admin status
    const isAdmin = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: EXCHANGE_ABI,
        functionName: 'isAdmin',
        args: [DEPLOYER_ADDRESS],
    });
    console.log(`Deployer is admin: ${isAdmin}`);
    if (!isAdmin) {
        throw new Error('Deployer is not admin! Cannot proceed.');
    }

    // Step 1: Add operator if not already
    console.log('\n1. Checking operator status...');
    const isOperator = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: EXCHANGE_ABI,
        functionName: 'isOperator',
        args: [DEPLOYER_ADDRESS],
    });

    if (isOperator) {
        console.log('   Deployer is already an operator ✓');
    } else {
        console.log('   Adding deployer as operator...');
        const addOpHash = await walletClient.writeContract({
            address: CONTRACTS.EXCHANGE,
            abi: EXCHANGE_ABI,
            functionName: 'addOperator',
            args: [DEPLOYER_ADDRESS],
        });
        await publicClient.waitForTransactionReceipt({ hash: addOpHash });
        console.log(`   Operator added: ${addOpHash}`);
    }

    // Step 2: Register tokens
    console.log('\n2. Registering outcome tokens...');
    const yesTokenId = MARKET_STATE.yesTokenId;
    const noTokenId = MARKET_STATE.noTokenId;
    const conditionId = MARKET_STATE.conditionId;

    console.log(`   YES Token: ${yesTokenId}`);
    console.log(`   NO Token:  ${noTokenId}`);
    console.log(`   Condition: ${conditionId}`);

    // Check if already registered
    const existingCondition = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: EXCHANGE_ABI,
        functionName: 'getConditionId',
        args: [yesTokenId],
    });

    if (
        existingCondition !== '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
        console.log('   Tokens already registered ✓');
        console.log(`   Registered conditionId: ${existingCondition}`);
    } else {
        console.log('   Registering tokens with Exchange...');
        const registerHash = await walletClient.writeContract({
            address: CONTRACTS.EXCHANGE,
            abi: EXCHANGE_ABI,
            functionName: 'registerToken',
            args: [yesTokenId, noTokenId, conditionId as `0x${string}`],
        });
        await publicClient.waitForTransactionReceipt({ hash: registerHash });
        console.log(`   Tokens registered: ${registerHash}`);
    }

    // Verify registration
    const verifyCondition = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: EXCHANGE_ABI,
        functionName: 'getConditionId',
        args: [yesTokenId],
    });
    console.log(`\n✓ Verification: YES token conditionId = ${verifyCondition}`);

    console.log('\n=== Token Registration Complete ===');
}

main().catch(console.error);
