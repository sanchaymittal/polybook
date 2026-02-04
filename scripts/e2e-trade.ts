/**
 * PolyBook v1 - Phase 6: End-to-End Trade Execution Test
 *
 * Tests the full flow:
 * 1. LP has YES/NO tokens (from Phase 3)
 * 2. Trader A creates signed BUY order for YES tokens
 * 3. LP creates signed SELL order for YES tokens
 * 4. Executor matches orders on-chain
 * 5. Verify token transfers
 */
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { anvil } from 'viem/chains';
import {
    CONTRACTS,
    DEPLOYER_PRIVATE_KEY,
    LP_PRIVATE_KEY,
    LP_ADDRESS,
    TRADER_A_PRIVATE_KEY,
    TRADER_A_ADDRESS,
    RPC_URL,
} from '../clob/src/contracts.js';
import { MARKET_STATE } from '../clob/src/market-state.js';
import {
    createBuyOrder,
    createSellOrder,
    signOrder,
    Side,
} from '../clob/src/signing.js';
import { createExecutor } from '../clob/src/executor.js';

// ERC20 ABI
const ERC20_ABI = parseAbi([
    'function balanceOf(address account) external view returns (uint256)',
    'function mint(address to, uint256 amount) external',
]);

// ERC1155 ABI
const ERC1155_ABI = parseAbi([
    'function balanceOf(address account, uint256 id) external view returns (uint256)',
]);

async function main() {
    console.log('=== Phase 6: E2E Trade Execution Test ===\n');

    const publicClient = createPublicClient({
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Create executor (operator = deployer)
    const executor = createExecutor(DEPLOYER_PRIVATE_KEY);
    console.log(`Operator: ${executor.getOperatorAddress()}`);

    const yesTokenId = MARKET_STATE.yesTokenId;
    const price = 0.6; // 60 cents per YES token
    const quantity = 10n; // 10 tokens (scaled by 1e6 = 10_000_000)

    // ===== SETUP =====
    console.log('\n--- Setup ---');

    // Mint USDC to Trader A
    console.log('Minting USDC to Trader A...');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { createWalletClient } = await import('viem');

    const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const deployerClient = createWalletClient({
        account: deployerAccount,
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Mint 1000 USDC to Trader A
    const mintHash = await deployerClient.writeContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'mint',
        args: [TRADER_A_ADDRESS, 1000n * 10n ** 6n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log('USDC minted to Trader A ✓');

    // Check balances before
    console.log('\n--- Balances Before ---');
    const traderAUsdcBefore = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [TRADER_A_ADDRESS],
    });
    const lpYesBefore = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [LP_ADDRESS, yesTokenId],
    });
    const traderAYesBefore = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [TRADER_A_ADDRESS, yesTokenId],
    });

    console.log(`Trader A USDC: ${traderAUsdcBefore / 10n ** 6n}`);
    console.log(`LP YES tokens: ${lpYesBefore}`);
    console.log(`Trader A YES tokens: ${traderAYesBefore}`);

    // ===== CREATE ORDERS =====
    console.log('\n--- Creating Orders ---');

    // Trader A: BUY 10 YES tokens @ $0.60
    // makerAmount = USDC to pay = 10 * 0.6 = 6 USDC = 6_000_000
    // takerAmount = tokens to receive = 10
    const buyOrder = createBuyOrder({
        maker: TRADER_A_ADDRESS,
        tokenId: yesTokenId,
        price: price,
        quantity: quantity,
    });
    const signedBuyOrder = await signOrder(buyOrder, TRADER_A_PRIVATE_KEY);
    console.log(`Trader A BUY order signed: ${signedBuyOrder.signature.slice(0, 20)}...`);

    // LP: SELL 10 YES tokens @ $0.60
    // makerAmount = tokens to sell = 10
    // takerAmount = USDC to receive = 6 USDC = 6_000_000
    const sellOrder = createSellOrder({
        maker: LP_ADDRESS,
        tokenId: yesTokenId,
        price: price,
        quantity: quantity,
    });
    const signedSellOrder = await signOrder(sellOrder, LP_PRIVATE_KEY);
    console.log(`LP SELL order signed: ${signedSellOrder.signature.slice(0, 20)}...`);

    // ===== SET APPROVALS =====
    console.log('\n--- Setting Approvals ---');

    // Trader A approves USDC
    await executor.ensureUSDCApproval(
        TRADER_A_ADDRESS,
        TRADER_A_PRIVATE_KEY,
        signedBuyOrder.makerAmount
    );

    // LP approves ERC1155
    await executor.ensureERC1155Approval(LP_ADDRESS, LP_PRIVATE_KEY);

    // ===== EXECUTE MATCH =====
    console.log('\n--- Executing On-Chain Match ---');

    // For BUY orders: takerFillAmount is in terms of makerAmount (USDC)
    // For matchOrders: taker is the BUY order, makers are SELL orders
    const takerFillAmount = signedBuyOrder.makerAmount; // 6 USDC
    const makerFillAmounts = [signedSellOrder.makerAmount]; // 10 tokens

    const txHash = await executor.executeMatch(
        signedBuyOrder,
        [signedSellOrder],
        takerFillAmount,
        makerFillAmounts
    );

    // ===== VERIFY RESULTS =====
    console.log('\n--- Balances After ---');
    const traderAUsdcAfter = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [TRADER_A_ADDRESS],
    });
    const lpYesAfter = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [LP_ADDRESS, yesTokenId],
    });
    const traderAYesAfter = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [TRADER_A_ADDRESS, yesTokenId],
    });
    const lpUsdcAfter = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [LP_ADDRESS],
    });

    console.log(`Trader A USDC: ${traderAUsdcBefore / 10n ** 6n} -> ${traderAUsdcAfter / 10n ** 6n}`);
    console.log(`Trader A YES:  ${traderAYesBefore} -> ${traderAYesAfter}`);
    console.log(`LP YES tokens: ${lpYesBefore} -> ${lpYesAfter}`);
    console.log(`LP USDC:       ${lpUsdcAfter / 10n ** 6n}`);

    // Verify
    const usdcTransferred = traderAUsdcBefore - traderAUsdcAfter;
    const yesTransferred = traderAYesAfter - traderAYesBefore;

    console.log('\n--- Verification ---');
    console.log(`USDC transferred: ${usdcTransferred / 10n ** 6n} USDC`);
    console.log(`YES transferred:  ${yesTransferred} tokens`);

    if (yesTransferred > 0n && usdcTransferred > 0n) {
        console.log('\n✓ Trade executed successfully!');
    } else {
        console.log('\n✗ Trade verification failed');
    }

    console.log('\n=== E2E Test Complete ===');
}

main().catch(console.error);
