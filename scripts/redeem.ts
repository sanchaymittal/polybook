/**
 * PolyBook v1 - Phase 8: Redemption
 *
 * Allows holders to redeem winning outcome tokens for USDC.
 * After resolution, winners can burn their ERC-1155 tokens and receive collateral.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
    CONTRACTS,
    LP_PRIVATE_KEY,
    LP_ADDRESS,
    TRADER_A_PRIVATE_KEY,
    TRADER_A_ADDRESS,
    RPC_URL,
} from '../orchestrator/src/contracts.js';
import { MARKET_STATE } from '../orchestrator/src/market-state.js';

// ConditionalTokens ABI
const CTF_ABI = parseAbi([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function payoutDenominator(bytes32 conditionId) external view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)',
]);

// ERC20 ABI
const ERC20_ABI = parseAbi([
    'function balanceOf(address account) external view returns (uint256)',
]);

// ERC1155 ABI
const ERC1155_ABI = parseAbi([
    'function balanceOf(address account, uint256 id) external view returns (uint256)',
]);

// Index sets for binary outcomes:
// 0b01 = 1 = first outcome (YES/index 0)
// 0b10 = 2 = second outcome (NO/index 1)
const YES_INDEX_SET = 1n;
const NO_INDEX_SET = 2n;

async function redeemForAccount(
    holderAddress: Address,
    holderPrivateKey: Hex,
    publicClient: ReturnType<typeof createPublicClient>
) {
    console.log(`\n--- Redeeming for ${holderAddress} ---`);

    const account = privateKeyToAccount(holderPrivateKey);
    const walletClient = createWalletClient({
        account,
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Check token balances before
    const yesBefore = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [holderAddress, MARKET_STATE.yesTokenId],
    });
    const noBefore = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [holderAddress, MARKET_STATE.noTokenId],
    });
    const usdcBefore = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [holderAddress],
    });

    console.log(`Before: YES=${yesBefore}, NO=${noBefore}, USDC=${usdcBefore / 10n ** 6n}`);

    // Redeem YES tokens (if any)
    if (yesBefore > 0n) {
        console.log(`Redeeming ${yesBefore} YES tokens...`);
        const hash = await walletClient.writeContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'redeemPositions',
            args: [
                CONTRACTS.USDC,
                '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
                MARKET_STATE.conditionId as `0x${string}`,
                [YES_INDEX_SET],
            ],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`YES redemption tx: ${hash}`);
    }

    // Redeem NO tokens (if any)
    if (noBefore > 0n) {
        console.log(`Redeeming ${noBefore} NO tokens...`);
        const hash = await walletClient.writeContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'redeemPositions',
            args: [
                CONTRACTS.USDC,
                '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
                MARKET_STATE.conditionId as `0x${string}`,
                [NO_INDEX_SET],
            ],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`NO redemption tx: ${hash}`);
    }

    // Check balances after
    const yesAfter = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [holderAddress, MARKET_STATE.yesTokenId],
    });
    const noAfter = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [holderAddress, MARKET_STATE.noTokenId],
    });
    const usdcAfter = await publicClient.readContract({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [holderAddress],
    });

    console.log(`After:  YES=${yesAfter}, NO=${noAfter}, USDC=${usdcAfter / 10n ** 6n}`);

    const usdcGained = usdcAfter - usdcBefore;
    console.log(`USDC gained: ${usdcGained / 10n ** 6n}`);

    return { yesBefore, noBefore, yesAfter, noAfter, usdcBefore, usdcAfter, usdcGained };
}

async function main() {
    console.log('=== Phase 8: Redemption ===\n');

    const publicClient = createPublicClient({
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Verify market is resolved
    const payoutDenom = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'payoutDenominator',
        args: [MARKET_STATE.conditionId as `0x${string}`],
    });

    if (payoutDenom === 0n) {
        throw new Error('Market is not resolved! Cannot redeem.');
    }

    // Show resolution outcome
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

    console.log(`Resolution: YES=${yesNumerator}/${payoutDenom}, NO=${noNumerator}/${payoutDenom}`);
    console.log(`Winner: ${yesNumerator > 0n ? 'YES' : 'NO'}`);

    // Redeem for Trader A (bought YES tokens)
    const traderAResult = await redeemForAccount(TRADER_A_ADDRESS, TRADER_A_PRIVATE_KEY, publicClient);

    // Redeem for LP (has remaining YES/NO tokens)
    const lpResult = await redeemForAccount(LP_ADDRESS, LP_PRIVATE_KEY, publicClient);

    // Summary
    console.log('\n=== Redemption Summary ===');
    console.log(`Trader A (YES holder): +${traderAResult.usdcGained / 10n ** 6n} USDC`);
    console.log(`LP: +${lpResult.usdcGained / 10n ** 6n} USDC`);

    console.log('\n=== Redemption Complete ===');
}

main().catch(console.error);
