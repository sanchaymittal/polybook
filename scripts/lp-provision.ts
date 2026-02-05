/**
 * PolyBook v1 - Phase 3: LP Provision
 *
 * Mints USDC to LP, approves CTF, and splits position into YES/NO tokens.
 *
 * Run: npx tsx src/scripts/lp-provision.ts
 */
import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    encodePacked,
    concat,
    toHex,
    pad,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
    DEPLOYER_PRIVATE_KEY,
    LP_PRIVATE_KEY,
    LP_ADDRESS,
    CONTRACTS,
    RPC_URL,
} from '../orchestrator/src/contracts.js';
import { MARKET_STATE } from '../orchestrator/src/market-state.js';

// USDC ABI (mock has mint function)
const USDC_ABI = [
    {
        name: 'mint',
        type: 'function',
        inputs: [
            { name: '_to', type: 'address' },
            { name: '_amount', type: 'uint256' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'approve',
        type: 'function',
        inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
    },
    {
        name: 'balanceOf',
        type: 'function',
        inputs: [{ name: '', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
    },
] as const;

// ConditionalTokens ABI (subset for splitPosition)
const CTF_ABI = [
    {
        name: 'splitPosition',
        type: 'function',
        inputs: [
            { name: 'collateralToken', type: 'address' },
            { name: 'parentCollectionId', type: 'bytes32' },
            { name: 'conditionId', type: 'bytes32' },
            { name: 'partition', type: 'uint256[]' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'getCollectionId',
        type: 'function',
        inputs: [
            { name: 'parentCollectionId', type: 'bytes32' },
            { name: 'conditionId', type: 'bytes32' },
            { name: 'indexSet', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
    },
    {
        name: 'getPositionId',
        type: 'function',
        inputs: [
            { name: 'collateralToken', type: 'address' },
            { name: 'collectionId', type: 'bytes32' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'pure',
    },
    {
        name: 'balanceOf',
        type: 'function',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'id', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
    },
    {
        name: 'PositionSplit',
        type: 'event',
        inputs: [
            { name: 'stakeholder', type: 'address', indexed: true },
            { name: 'collateralToken', type: 'address', indexed: false },
            { name: 'parentCollectionId', type: 'bytes32', indexed: true },
            { name: 'conditionId', type: 'bytes32', indexed: true },
            { name: 'partition', type: 'uint256[]', indexed: false },
            { name: 'amount', type: 'uint256', indexed: false },
        ],
    },
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
        name: 'getOutcomeSlotCount',
        type: 'function',
        inputs: [{ name: 'conditionId', type: 'bytes32' }],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
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
] as const;

// Amount to mint/split (1000 USDC with 6 decimals)
const AMOUNT = 1000n * 10n ** 6n;

// Parent collection ID (0 for root)
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

// Partition: [1, 2] for binary outcomes (YES=0b01=1, NO=0b10=2)
const PARTITION = [1n, 2n];

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║      Phase 3: LP Provision                           ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    // Setup clients
    const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const lpAccount = privateKeyToAccount(LP_PRIVATE_KEY);

    const publicClient = createPublicClient({
        chain: anvil,
        transport: http(RPC_URL),
    });

    const deployerWallet = createWalletClient({
        account: deployerAccount,
        chain: anvil,
        transport: http(RPC_URL),
    });

    const lpWallet = createWalletClient({
        account: lpAccount,
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Step 0: Compute Condition ID
    console.log('\n0. Computing Condition ID...');
    const conditionId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getConditionId',
        args: [MARKET_STATE.oracle, MARKET_STATE.questionId, BigInt(MARKET_STATE.outcomeSlotCount)],
    });
    console.log(`   Computed Condition ID: ${conditionId}`);
    if (conditionId !== MARKET_STATE.conditionId) {
        console.warn(`   ⚠️ Mismatch with MARKET_STATE.conditionId: ${MARKET_STATE.conditionId}`);
        console.warn('   Using computed ID.');
    }

    // Step 1: Mint USDC to LP
    console.log('\n1. Minting USDC to LP...');
    const mintHash = await deployerWallet.writeContract({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: 'mint',
        args: [LP_ADDRESS, AMOUNT],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const lpUsdcBalance = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [LP_ADDRESS],
    });
    console.log(`   LP USDC balance: ${Number(lpUsdcBalance) / 1e6} USDC`);

    // Step 2: LP approves CTF to spend USDC
    console.log('\n2. LP approving CTF to spend USDC...');
    const approveHash = await lpWallet.writeContract({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: 'approve',
        args: [CONTRACTS.CTF, AMOUNT],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log('   ✅ Approved');

    // Step 2.5: Ensure Condition is Prepared
    console.log('\n2.5. Checking if Condition is prepared...');
    const slotCount = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getOutcomeSlotCount',
        args: [conditionId],
    });

    if (slotCount === 0n) {
        console.log('   Condition NOT prepared. Preparing now...');
        const prepareHash = await deployerWallet.writeContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'prepareCondition',
            args: [MARKET_STATE.oracle, MARKET_STATE.questionId, BigInt(MARKET_STATE.outcomeSlotCount)],
        });
        await publicClient.waitForTransactionReceipt({ hash: prepareHash });
        console.log('   ✅ Condition Prepared');
    } else {
        console.log('   ✅ Condition already prepared');
    }

    // Step 3: Call splitPosition
    console.log('\n3. Splitting position into YES/NO tokens...');
    console.log(`   ConditionId: ${conditionId}`);
    console.log(`   Amount: ${Number(AMOUNT) / 1e6} USDC`);

    try {
        const splitHash = await lpWallet.writeContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'splitPosition',
            args: [
                CONTRACTS.USDC,
                PARENT_COLLECTION_ID,
                conditionId,
                PARTITION,
                AMOUNT,
            ],
        });
        const splitReceipt = await publicClient.waitForTransactionReceipt({ hash: splitHash });
        console.log(`   Transaction: ${splitHash}`);
        console.log(`   Status: ${splitReceipt.status}`);
    } catch (e) {
        console.error('   ❌ Split Position failed:', e);
        process.exit(1);
    }

    // Step 4: Compute token IDs
    console.log('\n4. Computing token IDs...');

    // Get collection IDs for each outcome
    const yesCollectionId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getCollectionId',
        args: [PARENT_COLLECTION_ID, conditionId, 1n], // YES = indexSet 1
    });

    const noCollectionId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getCollectionId',
        args: [PARENT_COLLECTION_ID, conditionId, 2n], // NO = indexSet 2
    });

    console.log(`   YES collectionId: ${yesCollectionId}`);
    console.log(`   NO collectionId: ${noCollectionId}`);

    // Get position IDs (ERC-1155 token IDs)
    const yesTokenId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getPositionId',
        args: [CONTRACTS.USDC, yesCollectionId],
    });

    const noTokenId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getPositionId',
        args: [CONTRACTS.USDC, noCollectionId],
    });

    console.log(`   YES tokenId: ${yesTokenId}`);
    console.log(`   NO tokenId: ${noTokenId}`);

    // Step 5: Verify LP balances
    console.log('\n5. Verifying LP token balances...');

    const yesBalance = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'balanceOf',
        args: [LP_ADDRESS, yesTokenId],
    });

    const noBalance = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'balanceOf',
        args: [LP_ADDRESS, noTokenId],
    });

    console.log(`   LP YES balance: ${Number(yesBalance) / 1e6}`);
    console.log(`   LP NO balance: ${Number(noBalance) / 1e6}`);

    if (yesBalance === AMOUNT && noBalance === AMOUNT) {
        console.log('   ✅ LP provision successful!');
    } else {
        console.log('   ❌ LP provision failed - unexpected balances');
        process.exit(1);
    }

    // Output for next phases
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('Store these values for next phases:');
    console.log(`  YES_TOKEN_ID="${yesTokenId}"`);
    console.log(`  NO_TOKEN_ID="${noTokenId}"`);
    console.log('═══════════════════════════════════════════════════════');
}

main().catch(console.error);
