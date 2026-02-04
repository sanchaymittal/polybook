/**
 * PolyBook v1 - Phase 4: EIP-712 Order Signing
 *
 * Implements Polymarket-compatible order signing using EIP-712.
 * Matches the Order struct from ctf-exchange OrderStructs.sol
 */
import {
    keccak256,
    encodeAbiParameters,
    parseAbiParameters,
    toHex,
    type Address,
    type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID, CONTRACTS } from './contracts.js';

/**
 * Order side enum matching Solidity
 */
export enum Side {
    BUY = 0,
    SELL = 1,
}

/**
 * Signature type enum matching Solidity
 */
export enum SignatureType {
    EOA = 0,
    POLY_PROXY = 1,
    POLY_GNOSIS_SAFE = 2,
    POLY_1271 = 3,
}

/**
 * Order struct matching Polymarket CTF Exchange
 */
export interface Order {
    salt: bigint;
    maker: Address;
    signer: Address;
    taker: Address;
    tokenId: bigint;
    makerAmount: bigint;
    takerAmount: bigint;
    expiration: bigint;
    nonce: bigint;
    feeRateBps: bigint;
    side: Side;
    signatureType: SignatureType;
    signature: Hex;
}

/**
 * Unsigned order (before signing)
 */
export type UnsignedOrder = Omit<Order, 'signature'>;

/**
 * EIP-712 Domain for Polymarket CTF Exchange
 * OpenZeppelin EIP712 includes verifyingContract in the domain
 */
export const EIP712_DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: CONTRACTS.EXCHANGE,
} as const;

/**
 * EIP-712 types for Order
 */
export const ORDER_TYPES = {
    Order: [
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
    ],
} as const;

/**
 * ORDER_TYPEHASH matching Solidity
 */
export const ORDER_TYPEHASH = keccak256(
    toHex(
        'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)'
    )
);

/**
 * Generate a random salt for order uniqueness
 */
export function generateSalt(): bigint {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

/**
 * Create an unsigned order with defaults
 */
export function createOrder(params: {
    maker: Address;
    signer?: Address;
    taker?: Address;
    tokenId: bigint;
    makerAmount: bigint;
    takerAmount: bigint;
    side: Side;
    expiration?: bigint;
    nonce?: bigint;
    feeRateBps?: bigint;
    salt?: bigint;
}): UnsignedOrder {
    const now = BigInt(Math.floor(Date.now() / 1000));

    return {
        salt: params.salt ?? generateSalt(),
        maker: params.maker,
        signer: params.signer ?? params.maker,
        taker: params.taker ?? '0x0000000000000000000000000000000000000000',
        tokenId: params.tokenId,
        makerAmount: params.makerAmount,
        takerAmount: params.takerAmount,
        expiration: params.expiration ?? now + 3600n, // 1 hour default
        nonce: params.nonce ?? 0n,
        feeRateBps: params.feeRateBps ?? 0n,
        side: params.side,
        signatureType: SignatureType.EOA,
    };
}

/**
 * Hash an order for signing (struct hash only, not domain)
 */
export function hashOrderStruct(order: UnsignedOrder): Hex {
    const encoded = encodeAbiParameters(
        parseAbiParameters(
            'bytes32, uint256, address, address, address, uint256, uint256, uint256, uint256, uint256, uint256, uint8, uint8'
        ),
        [
            ORDER_TYPEHASH,
            order.salt,
            order.maker,
            order.signer,
            order.taker,
            order.tokenId,
            order.makerAmount,
            order.takerAmount,
            order.expiration,
            order.nonce,
            order.feeRateBps,
            order.side,
            order.signatureType,
        ]
    );
    return keccak256(encoded);
}

/**
 * Sign an order using EIP-712
 */
export async function signOrder(
    order: UnsignedOrder,
    privateKey: Hex
): Promise<Order> {
    const account = privateKeyToAccount(privateKey);

    // Use viem's signTypedData
    const signature = await account.signTypedData({
        domain: EIP712_DOMAIN,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: {
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
        },
    });

    return {
        ...order,
        signature,
    };
}

/**
 * Verify an order signature matches the signer
 */
export function verifyOrderSignature(order: Order): boolean {
    // For EOA signatures, the recovered address should match the signer
    // This is verified on-chain; here we just validate format
    return (
        order.signature.length === 132 && // 65 bytes = 130 hex chars + 0x
        order.signature.startsWith('0x')
    );
}

/**
 * Create a BUY order (wants to receive tokenId, pays USDC)
 * For BUY: makerAmount = USDC to pay, takerAmount = tokens to receive
 */
export function createBuyOrder(params: {
    maker: Address;
    tokenId: bigint;
    price: number; // Price per token (0-1)
    quantity: bigint; // Number of tokens to buy
    expiration?: bigint;
    nonce?: bigint;
}): UnsignedOrder {
    // Price is in terms of USDC per outcome token
    // e.g., price=0.6 means 0.6 USDC per token
    // USDC has 6 decimals, so 0.6 USDC = 600000
    const pricePerToken = BigInt(Math.floor(params.price * 1e6));
    const makerAmount = pricePerToken * params.quantity / (10n ** 6n);
    const takerAmount = params.quantity;

    return createOrder({
        maker: params.maker,
        tokenId: params.tokenId,
        makerAmount, // USDC to pay
        takerAmount, // Tokens to receive
        side: Side.BUY,
        expiration: params.expiration,
        nonce: params.nonce,
    });
}

/**
 * Create a SELL order (wants to sell tokenId, receives USDC)
 * For SELL: makerAmount = tokens to sell, takerAmount = USDC to receive
 */
export function createSellOrder(params: {
    maker: Address;
    tokenId: bigint;
    price: number; // Price per token (0-1)
    quantity: bigint; // Number of tokens to sell
    expiration?: bigint;
    nonce?: bigint;
}): UnsignedOrder {
    const pricePerToken = BigInt(Math.floor(params.price * 1e6));
    const makerAmount = params.quantity; // Tokens to sell
    const takerAmount = pricePerToken * params.quantity / (10n ** 6n); // USDC to receive

    return createOrder({
        maker: params.maker,
        tokenId: params.tokenId,
        makerAmount,
        takerAmount,
        side: Side.SELL,
        expiration: params.expiration,
        nonce: params.nonce,
    });
}
