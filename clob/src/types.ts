/**
 * PolyBook Orchestrator - Type Definitions
 *
 * Core types for markets, orders, and CLOB operations.
 */

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
    BUY = 'BUY',
    SELL = 'SELL',
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
 * Order in the CLOB
 */
export interface Order {
    orderId: string;
    marketId: number;
    agent: string;
    side: Side;
    outcome: Outcome;
    price: number;        // 0 to 1
    quantity: number;     // Units
    filledQuantity: number;
    status: OrderStatus;
    createdAt: number;
    updatedAt: number;
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
    buyOrderId: string;
    sellOrderId: string;
    buyer: string;
    seller: string;
    timestamp: number;
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
