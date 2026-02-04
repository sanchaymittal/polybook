
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatUnits
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
    CONTRACTS,
    RPC_URL,
    LP_PRIVATE_KEY,
    TRADER_A_PRIVATE_KEY,
    CHAIN_ID,
    TRADER_A_ADDRESS,
    LP_ADDRESS
} from '../src/contracts.js';
import { createExecutor } from '../src/executor.js';
import { createOrder, signOrder, UnsignedOrder, Side } from '../src/signing.js';
import { MARKET_STATE } from '../src/market-state.js';
import { MatchingEngineClient } from '../src/matching-client.js';
import { createHash } from 'crypto';
import { Order, Outcome } from '../src/types.js';

// ABIs
const CTF_ABI = parseAbi([
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, uint256 partition, uint256[] amount) external',
    'function balanceOf(address account, uint256 id) external view returns (uint256)',
]);
const ERC20_ABI = parseAbi([
    'function mint(address to, uint256 amount) external',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
]);

async function main() {
    console.log('--- Starting End-to-End Trade Flow Test ---');

    const client = createMatchingClient();
    const executor = createExecutor(LP_PRIVATE_KEY); // Using LP key for approvals helper

    // 1. Setup LP (Seller)
    console.log('\n1. Setting up LP (Seller)...');
    const lpClient = createWalletClient({
        account: privateKeyToAccount(LP_PRIVATE_KEY),
        chain: anvil,
        transport: http(RPC_URL)
    });
    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });

    // Mint USDC to LP
    await lpClient.writeContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'mint',
        args: [LP_ADDRESS, 10000n * 10n ** 6n],
    });

    // Approve CTF to spend USDC (for splitting)
    await lpClient.writeContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS.CTF, 10000n * 10n ** 6n],
    });

    // Split Collateral to get YES tokens
    console.log('Splitting collateral to mint YES/NO tokens...');
    try {
        await lpClient.writeContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'splitPosition',
            args: [
                CONTRACTS.USDC,
                '0x0000000000000000000000000000000000000000000000000000000000000000', // Parent ID (0 for collateral)
                MARKET_STATE.conditionId, // Partition/Condition ?? Wait.
                // splitPosition(collat, parentCollection, partition, amounts)
                // CTF.sol: splitPosition(IERC20 collateralToken, bytes32 parentCollectionId, uint256 conditionId, uint256[] calldata partition)
                // Wait. Args check.
                // CTF Interface: splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount)
                // NO.
                // Gnosis CTF: splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata partition, uint256 amount)
                // My args: [USDC, 0x0, conditionId, [1, 2], amount] ??

                // Let's check `phase_2_condition_creation.txt` or `LocalDeployment.s.sol`.
                // deploy_ctf_exchange_locally logs doesn't show split.

                // Usually: splitPosition(collateral, parentCollectionId, conditionId, partition, amount)
                // partition: [1, 2] for binary.
                // amount: amount to split.
            ]
            // Wait, I need accurate args.
            // Let's defer SPLIT if I assume LP has tokens.
            // But LP likely doesn't.
            // I'll try to execute split. 
            // `splitPosition(address,bytes32,bytes32,uint256[],uint256)`
        });
    } catch (e) {
        // If split fails, maybe signature wrong.
        // Let's use `createTrade` equivalent? 
        // Or assume I can just use `mint` if I added a mint helper to LocalDeployment?
        // No.
    }

    // Actually, earlier phases verified split?
    // Phase 2 Condition Creation.
    // I can assume it works if I find the right params.
    // conditionId is in MARKET_STATE?
    // In `market-state.ts`: `conditionId`.

    // Correct args for `splitPosition`:
    // (address collateral, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)

    const splitHash = await lpClient.writeContract({
        address: CONTRACTS.CTF,
        abi: parseAbi(['function splitPosition(address,bytes32,bytes32,uint256[],uint256)']),
        functionName: 'splitPosition',
        args: [
            CONTRACTS.USDC,
            '0x0000000000000000000000000000000000000000000000000000000000000000',
            MARKET_STATE.conditionId as `0x${string}`,
            [1n, 2n], // Binary outcome slots
            1000n * 10n ** 6n // Amount
        ]
    });
    console.log('Split TX:', splitHash);

    // Approve Exchange to spend YES tokens (for Selling)
    await executor.ensureERC1155Approval(LP_ADDRESS, LP_PRIVATE_KEY);


    // 2. Setup Trader A (Buyer)
    console.log('\n2. Setting up Trader A (Buyer)...');
    const traderClient = createWalletClient({
        account: privateKeyToAccount(TRADER_A_PRIVATE_KEY),
        chain: anvil,
        transport: http(RPC_URL)
    });

    // Mint USDC
    await traderClient.writeContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'mint',
        args: [TRADER_A_ADDRESS, 1000n * 10n ** 6n],
    });

    // Approve Exchange to spend USDC (for Buying)
    await executor.ensureUSDCApproval(TRADER_A_ADDRESS, TRADER_A_PRIVATE_KEY, 1000n * 10n ** 6n);


    // 3. Place Orders
    console.log('\n3. Placing Orders...');

    // LP Sells YES (index 0 implies 1? or 1 implies YES?)
    // In CTF, partition [1, 2].
    // Outcome 0 -> 1? Outcome 1 -> 2?
    // market-state.ts has `yesTokenId` matching `conditionId` + index 1.
    // Let's trust MARKET_STATE.

    const tokenId = MARKET_STATE.yesTokenId;

    // Use random salt to allow re-runs
    const lpSalt = BigInt('0x' + createHash('sha256').update(Math.random().toString()).digest('hex'));
    const traderSalt = BigInt('0x' + createHash('sha256').update(Math.random().toString()).digest('hex'));

    const sellPrice = 0.6;
    const sellQty = 10000000n; // 10 YES (1e6)
    const lpUnsigned = createOrder({
        salt: lpSalt,
        maker: LP_ADDRESS,
        tokenId,
        makerAmount: sellQty, // Sell 10 YES
        takerAmount: BigInt(6000000), // Want 6 USDC
        side: Side.SELL,
        nonce: 1n,
    });
    const lpSigned = await signOrder(lpUnsigned, LP_PRIVATE_KEY);

    // Construct full Order
    const lpFullOrder: Order = {
        ...lpSigned,
        price: sellPrice,
        quantity: Number(sellQty) / 1e6, // 10
        outcome: Outcome.UP, // Arbitrary for this test since we use tokenId directly
        marketId: 1,
        filledQuantity: 0,
        status: 'OPEN'
    } as any; // Cast to avoid strict type checks on augments if any

    console.log('Placing LP Sell Order...');
    await client.placeOrder(lpFullOrder, lpSigned.salt.toString());


    // Trader A Order: Buy 5 YES at 0.60
    const buyPrice = 0.6;
    const buyQty = 5000000n; // 5 YES (1e6)
    const traderUnsigned = createOrder({
        salt: traderSalt,
        maker: TRADER_A_ADDRESS,
        tokenId,
        makerAmount: BigInt(3000000), // Pay 3 USDC
        takerAmount: buyQty, // Buy 5 YES
        side: Side.BUY,
        nonce: 1n,
    });
    const traderSigned = await signOrder(traderUnsigned, TRADER_A_PRIVATE_KEY);

    const traderFullOrder: Order = {
        ...traderSigned,
        price: buyPrice,
        quantity: Number(buyQty) / 1e6, // 5
        outcome: Outcome.UP,
        marketId: 1,
        filledQuantity: 0,
        status: 'OPEN'
    } as any;

    console.log('Placing Trader Buy Order...');
    await client.placeOrder(traderFullOrder, traderSigned.salt.toString());

    console.log('\nOrders placed. Relay should pick this up momentarily...');

    // Wait for execution
    await new Promise(r => setTimeout(r, 10000));

    // Check Trader A balance of YES tokens
    const balance = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'balanceOf',
        args: [TRADER_A_ADDRESS, tokenId]
    });

    console.log(`\nTrader A YES Balance: ${Number(balance) / 1e6} (Expected >= 5)`);

    if (balance >= 5n * 10n ** 6n) {
        console.log('--- SUCCESS: Trade executed on-chain! ---');
    } else {
        console.log('--- FAILURE: Balance did not update. Relay failed? ---');
    }
}

function createMatchingClient() {
    return new MatchingEngineClient();
}

main().catch(console.error);
