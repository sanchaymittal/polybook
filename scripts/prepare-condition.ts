/**
 * PolyBook v1 - Phase 2: Prepare Condition
 *
 * Creates a CTF condition for the BTC-UP-DOWN-5MIN market.
 *
 * Run: npx tsx src/scripts/prepare-condition.ts
 */
import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    toBytes,
    encodeAbiParameters,
    parseAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
    DEPLOYER_PRIVATE_KEY,
    DEPLOYER_ADDRESS,
    CONTRACTS,
    RPC_URL,
} from '../orchestrator/src/contracts.js';

// ConditionalTokens ABI (subset needed)
const CTF_ABI = [
    {
        name: 'prepareCondition',
        type: 'function',
        inputs: [
            { name: 'oracle', type: 'address' },
            { name: 'questionId', type: 'bytes32' },
            { name: 'outcomeSlotCount', type: 'uint256' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'getConditionId',
        type: 'function',
        inputs: [
            { name: 'oracle', type: 'address' },
            { name: 'questionId', type: 'bytes32' },
            { name: 'outcomeSlotCount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'pure',
    },
    {
        name: 'getOutcomeSlotCount',
        type: 'function',
        inputs: [{ name: 'conditionId', type: 'bytes32' }],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
    },
    {
        name: 'ConditionPreparation',
        type: 'event',
        inputs: [
            { name: 'conditionId', type: 'bytes32', indexed: true },
            { name: 'oracle', type: 'address', indexed: true },
            { name: 'questionId', type: 'bytes32', indexed: true },
            { name: 'outcomeSlotCount', type: 'uint256', indexed: false },
        ],
    },
] as const;

/**
 * Create a unique questionId for the market
 */
function createQuestionId(marketSlug: string, timestamp: number): `0x${string}` {
    const input = `${marketSlug}-${timestamp}`;
    return keccak256(toBytes(input));
}

/**
 * Compute conditionId matching CTF logic
 */
function computeConditionId(
    oracle: `0x${string}`,
    questionId: `0x${string}`,
    outcomeSlotCount: number
): `0x${string}` {
    // conditionId = keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
    const encoded = encodeAbiParameters(
        parseAbiParameters('address, bytes32, uint256'),
        [oracle, questionId, BigInt(outcomeSlotCount)]
    );
    return keccak256(encoded);
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║      Phase 2: Prepare Condition                      ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    // Setup clients
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

    // Market parameters
    const marketSlug = 'BTC-UP-DOWN-5MIN';
    const timestamp = Math.floor(Date.now() / 1000);
    const outcomeSlotCount = 2;

    // Oracle is the deployer (for mock purposes)
    const oracle = DEPLOYER_ADDRESS;

    // Create questionId
    const questionId = createQuestionId(marketSlug, timestamp);
    console.log(`\nMarket: ${marketSlug}`);
    console.log(`Oracle: ${oracle}`);
    console.log(`QuestionId: ${questionId}`);

    // Compute expected conditionId
    const expectedConditionId = computeConditionId(oracle, questionId, outcomeSlotCount);
    console.log(`Expected ConditionId: ${expectedConditionId}`);

    // Call prepareCondition
    console.log('\nCalling prepareCondition...');
    const hash = await walletClient.writeContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'prepareCondition',
        args: [oracle, questionId, BigInt(outcomeSlotCount)],
    });

    console.log(`Transaction hash: ${hash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Block: ${receipt.blockNumber}`);
    console.log(`Status: ${receipt.status}`);

    // Verify condition was created
    const outcomeCount = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getOutcomeSlotCount',
        args: [expectedConditionId],
    });

    console.log(`\nVerification:`);
    console.log(`  Outcome slot count: ${outcomeCount}`);

    if (outcomeCount === BigInt(2)) {
        console.log('  ✅ Condition created successfully!');
    } else {
        console.log('  ❌ Condition creation failed');
        process.exit(1);
    }

    // Output for next phases
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('Store these values for next phases:');
    console.log(`  ORACLE="${oracle}"`);
    console.log(`  QUESTION_ID="${questionId}"`);
    console.log(`  CONDITION_ID="${expectedConditionId}"`);
    console.log('═══════════════════════════════════════════════════════');
}

main().catch(console.error);
