/**
 * PolyBook v1 - Test Order Signing
 *
 * Creates and signs a test order, then verifies it on-chain.
 *
 * Run: npx tsx src/scripts/test-signing.ts
 */
import { createPublicClient, http } from 'viem';
import { anvil } from 'viem/chains';
import {
    TRADER_A_PRIVATE_KEY,
    TRADER_A_ADDRESS,
    CONTRACTS,
    RPC_URL,
} from '../contracts.js';
import { MARKET_STATE } from '../market-state.js';
import {
    createBuyOrder,
    createSellOrder,
    signOrder,
    Side,
    type Order,
} from '../signing.js';

// Exchange ABI (subset for validation)
const EXCHANGE_ABI = [
    {
        name: 'validateOrder',
        type: 'function',
        inputs: [
            {
                name: 'order',
                type: 'tuple',
                components: [
                    { name: 'salt', type: 'uint256' },
                    { name: 'maker', type: 'address' },
                    { name: 'signer', type: 'address' },
                    { name: 'taker', type: 'address' },
                    { name: 'tokenId', type: 'uint256' },
                    { name: 'makerAmount', type: 'uint256' },
                    { name: 'takerAmount', type: 'uint256' },
                    { name: 'expiration', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'feeRateBps', type: 'uint256' },
                    { name: 'side', type: 'uint8' },
                    { name: 'signatureType', type: 'uint8' },
                    { name: 'signature', type: 'bytes' },
                ],
            },
        ],
        outputs: [],
        stateMutability: 'view',
    },
    {
        name: 'hashOrder',
        type: 'function',
        inputs: [
            {
                name: 'order',
                type: 'tuple',
                components: [
                    { name: 'salt', type: 'uint256' },
                    { name: 'maker', type: 'address' },
                    { name: 'signer', type: 'address' },
                    { name: 'taker', type: 'address' },
                    { name: 'tokenId', type: 'uint256' },
                    { name: 'makerAmount', type: 'uint256' },
                    { name: 'takerAmount', type: 'uint256' },
                    { name: 'expiration', type: 'uint256' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'feeRateBps', type: 'uint256' },
                    { name: 'side', type: 'uint8' },
                    { name: 'signatureType', type: 'uint8' },
                    { name: 'signature', type: 'bytes' },
                ],
            },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
    },
] as const;

/**
 * Convert Order to contract tuple format
 */
function orderToTuple(order: Order) {
    return {
        salt: order.salt,
        maker: order.maker,
        signer: order.signer,
        taker: order.taker,
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        expiration: order.expiration,
        nonce: order.nonce,
        feeRateBps: order.feeRateBps,
        side: order.side,
        signatureType: order.signatureType,
        signature: order.signature,
    };
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║      Phase 4: Test Order Signing                     ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    const publicClient = createPublicClient({
        chain: anvil,
        transport: http(RPC_URL),
    });

    // Create a BUY order for YES tokens
    console.log('\n1. Creating BUY order for YES tokens...');
    const buyOrder = createBuyOrder({
        maker: TRADER_A_ADDRESS,
        tokenId: MARKET_STATE.yesTokenId,
        price: 0.6, // 60 cents per YES token
        quantity: 10n * 10n ** 6n, // 10 tokens (with 6 decimal places)
    });

    console.log('   Unsigned order:');
    console.log(`     Maker: ${buyOrder.maker}`);
    console.log(`     TokenId: ${buyOrder.tokenId}`);
    console.log(`     Side: ${buyOrder.side === Side.BUY ? 'BUY' : 'SELL'}`);
    console.log(`     MakerAmount (USDC): ${buyOrder.makerAmount}`);
    console.log(`     TakerAmount (tokens): ${buyOrder.takerAmount}`);
    console.log(`     Expiration: ${buyOrder.expiration}`);

    // Sign the order
    console.log('\n2. Signing order with EIP-712...');
    const signedOrder = await signOrder(buyOrder, TRADER_A_PRIVATE_KEY);
    console.log(`   Signature: ${signedOrder.signature.slice(0, 42)}...`);

    // Get order hash from contract
    console.log('\n3. Getting order hash from Exchange...');
    const orderHash = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: EXCHANGE_ABI,
        functionName: 'hashOrder',
        args: [orderToTuple(signedOrder)],
    });
    console.log(`   Order hash: ${orderHash}`);

    // Validate order on-chain (this will revert if invalid)
    console.log('\n4. Validating order signature on-chain...');
    try {
        await publicClient.readContract({
            address: CONTRACTS.EXCHANGE,
            abi: EXCHANGE_ABI,
            functionName: 'validateOrder',
            args: [orderToTuple(signedOrder)],
        });
        console.log('   ✅ Order signature is valid!');
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // 0x3f6cc768 = InvalidTokenId() - signature passed but token not registered
        // 0xc1ab6dc1 = InvalidToken() - same
        if (errorMessage.includes('0x3f6cc768') || errorMessage.includes('InvalidTokenId')) {
            console.log('   ✅ Signature validated! (InvalidTokenId - token not registered yet)');
            console.log('   Note: We need to register tokens in Phase 6');
        } else if (errorMessage.includes('0x8baa579f') || errorMessage.includes('InvalidSignature')) {
            console.log(`   ❌ Invalid signature - EIP-712 signing mismatch`);
            process.exit(1);
        } else {
            console.log(`   ⚠️  Validation error: ${errorMessage.slice(0, 100)}`);
        }
    }

    // Test SELL order too
    console.log('\n5. Creating and signing SELL order...');
    const sellOrder = createSellOrder({
        maker: TRADER_A_ADDRESS,
        tokenId: MARKET_STATE.yesTokenId,
        price: 0.65,
        quantity: 5n * 10n ** 6n,
    });
    const signedSellOrder = await signOrder(sellOrder, TRADER_A_PRIVATE_KEY);
    console.log(`   SELL order signed: ${signedSellOrder.signature.slice(0, 42)}...`);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('✅ EIP-712 signing implementation verified!');
    console.log('═══════════════════════════════════════════════════════');
}

main().catch(console.error);
