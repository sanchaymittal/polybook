/**
 * PolyBook Orchestrator - Type Definitions
 *
 * Core types for markets, orders, and CLOB operations.
 */

import type { Address, Hex } from 'viem';

/**
 * Market lifecycle states
 */
export enum MarketState {
    PENDING = 'PENDING',    // Created, waiting for startTimestamp
    ACTIVE = 'ACTIVE',      // Trading open
    RESOLVED = 'RESOLVED',  // Outcome determined
}

/**
 * Binary outcome types
 */
export enum Outcome {
    NONE = 'NONE',
    UP = 'UP',
    DOWN = 'DOWN',
}

/**
 * Order side (agent perspective)
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
 * Order type
 */
export enum OrderType {
    LIMIT = 'LIMIT',
    MARKET = 'MARKET',
}

/**
 * Order status
 */
export enum OrderStatus {
    OPEN = 'OPEN',
    PARTIALLY_FILLED = 'PARTIALLY_FILLED',
    FILLED = 'FILLED',
    CANCELLED = 'CANCELLED',
}

/**
 * Market information
 */
export interface Market {
    marketId: number;
    slug: string;
    startTimestamp: number;
    expiryTimestamp: number;
    contractAddress: string;
    state: MarketState;
    priceAtStart?: number;
    outcome?: Outcome;
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
    // Augmented fields for CLOB tracking
    filledQuantity: number;
    price: number;
    quantity: number;
    outcome: Outcome;
    marketId: number;
    orderHash?: string; // Hex string of the order hash
}

/**
 * Trade execution record
 */
export interface Trade {
    tradeId: string;
    marketId: number;
    outcome: Outcome;
    price: number;
    quantity: number;
    // Polymarket / Rust Engine fields
    takerOrderHash: string;
    makerOrderHash: string;
    buyer: string;
    seller: string;
    timestamp: number;
    // Optional references for convenience
    takerOrder?: Order;
    makerOrders?: Order[];
}

/**
 * Agent position in a market
 */
export interface Position {
    agent: string;
    marketId: number;
    upQuantity: number;    // Units of UP outcome held
    downQuantity: number;  // Units of DOWN outcome held
    avgUpPrice: number;    // Average buy price for UP
    avgDownPrice: number;  // Average buy price for DOWN
}

/**
 * Agent balance in the CLOB session
 */
export interface Balance {
    agent: string;
    available: number;  // Available for trading
    locked: number;     // Locked in open orders
}

/**
 * Order book level (price + aggregated quantity)
 */
export interface BookLevel {
    price: number;
    quantity: number;
    orderCount: number;
}

/**
 * Order book snapshot for one outcome
 */
export interface OrderBook {
    outcome: Outcome;
    bids: BookLevel[];  // Sorted descending by price
    asks: BookLevel[];  // Sorted ascending by price
}

/**
 * CLOB state export for settlement
 */
export interface CLOBStateExport {
    marketId: number;
    timestamp: number;
    positions: Position[];
    finalizedTrades: Trade[];
    stateHash: string;
}

/**
 * Skill request from an agent
 */
export interface SkillRequest<T = unknown> {
    skill: string;
    params: T;
    agentAddress: string;
    timestamp: number;
}

/**
 * Skill response to an agent
 */
export interface SkillResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

/**
 * Place order request params
 */
export interface PlaceOrderParams {
    marketId: number;
    side: Side;
    outcome: Outcome;
    price: number;
    quantity: number;
    type: OrderType;
}

/**
 * Cancel order request params
 */
export interface CancelOrderParams {
    orderId: string;
}

/**
 * Create market request params
 */
export interface CreateMarketParams {
    template: 'BTC_UP_DOWN';
    slug: string;
    startTimestamp: number;
    expiryTimestamp: number;
}

/**
 * Discover markets request params
 */
export interface DiscoverMarketsParams {
    state: 'UPCOMING' | 'ACTIVE' | 'EXPIRED';
}
