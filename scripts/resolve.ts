/**
 * PolyBook v1 - Phase 7: Market Resolution
 *
 * Resolves the market condition via mock oracle.
 * The oracle calls reportPayouts on ConditionalTokens to finalize the outcome.
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

// ConditionalTokens ABI (resolution functions)
const CTF_ABI = parseAbi([
    'function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external',
    'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
]);

// Outcome indices
const YES_WINS = 0;
const NO_WINS = 1;

async function main() {
    // Parse command line argument for outcome
    const args = process.argv.slice(2);
    const outcome = args[0]?.toUpperCase() === 'NO' ? NO_WINS : YES_WINS;

    console.log('=== Phase 7: Market Resolution ===\n');
    console.log(`Resolving market with outcome: ${outcome === YES_WINS ? 'YES' : 'NO'}`);

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

    // Verify oracle address matches deployer
    console.log(`\nOracle address: ${MARKET_STATE.oracle}`);
    console.log(`Deployer address: ${DEPLOYER_ADDRESS}`);
    if (MARKET_STATE.oracle.toLowerCase() !== DEPLOYER_ADDRESS.toLowerCase()) {
        throw new Error('Deployer is not the oracle! Cannot resolve.');
    }
    console.log('Oracle verified ✓');

    // Check if already resolved
    const payoutDenom = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'payoutDenominator',
        args: [MARKET_STATE.conditionId as `0x${string}`],
    });

    if (payoutDenom > 0n) {
        console.log('\n⚠️  Condition already resolved!');
        console.log(`Payout denominator: ${payoutDenom}`);

        // Show current payouts
        const yesNumerator = await publicClient.readContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'payoutNumerators',
            args: [MARKET_STATE.conditionId as `0x${string}`, 0n],
        });
        const noNumerator = await publicClient.readContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'payoutNumerators',
            args: [MARKET_STATE.conditionId as `0x${string}`, 1n],
        });
        console.log(`YES payout: ${yesNumerator}/${payoutDenom}`);
        console.log(`NO payout: ${noNumerator}/${payoutDenom}`);
        return;
    }

    // Prepare payouts array: [YES_payout, NO_payout]
    // For binary markets, winning outcome = 1, losing = 0
    const payouts = outcome === YES_WINS ? [1n, 0n] : [0n, 1n];

    console.log(`\nPayouts: [YES=${payouts[0]}, NO=${payouts[1]}]`);
    console.log(`Question ID: ${MARKET_STATE.questionId}`);

    // Call reportPayouts
    console.log('\nCalling reportPayouts...');
    const hash = await walletClient.writeContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'reportPayouts',
        args: [MARKET_STATE.questionId as `0x${string}`, payouts],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Tx hash: ${hash}`);
    console.log(`Status: ${receipt.status === 'success' ? '✓ Success' : '✗ Failed'}`);
    console.log(`Block: ${receipt.blockNumber}`);

    // Verify resolution
    console.log('\n--- Verification ---');
    const newPayoutDenom = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'payoutDenominator',
        args: [MARKET_STATE.conditionId as `0x${string}`],
    });
    const yesNumerator = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'payoutNumerators',
        args: [MARKET_STATE.conditionId as `0x${string}`, 0n],
    });
    const noNumerator = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'payoutNumerators',
        args: [MARKET_STATE.conditionId as `0x${string}`, 1n],
    });

    console.log(`Condition ID: ${MARKET_STATE.conditionId}`);
    console.log(`Payout denominator: ${newPayoutDenom}`);
    console.log(`YES payout: ${yesNumerator}/${newPayoutDenom}`);
    console.log(`NO payout: ${noNumerator}/${newPayoutDenom}`);

    if (newPayoutDenom > 0n) {
        console.log(`\n✓ Market resolved: ${outcome === YES_WINS ? 'YES' : 'NO'} wins!`);
    } else {
        console.log('\n✗ Resolution failed');
    }

    console.log('\n=== Resolution Complete ===');
}

main().catch(console.error);
