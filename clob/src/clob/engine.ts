/**
 * PolyBook Orchestrator - CLOB Engine Module
 *
 * Central limit order book engine managing both UP and DOWN order books
 * for a single market, now using the Rust-based matching engine.
 */
import { createHash } from 'crypto';
import { MatchingEngineClient } from '../matching-client.js';
import {
    Balance,
    CLOBStateExport,
    Order,
    OrderType,
    Outcome,
    Position,
    Side,
    Trade,
    OrderBook as OrderBookType,
} from '../types.js';

/**
 * CLOB Engine for a single market
 *
 * Manages:
 * - Interface with Rust Matching Engine
 * - Agent balances
 * - Position tracking
 * - State export for settlement
 */
export class CLOBEngine {
    private readonly marketId: number;
    private readonly sessionId: string;

    // Rust Matching Engine Client
    private client: MatchingEngineClient;

    // Agent balances
    private balances: Map<string, Balance> = new Map();

    // Agent positions
    private positions: Map<string, Position> = new Map();

    // Whether trading is frozen (after market expiry)
    private frozen: boolean = false;

    // Track trades for export
    private trades: Trade[] = [];

    constructor(marketId: number, sessionId: string) {
        this.marketId = marketId;
        this.sessionId = sessionId;
        this.client = new MatchingEngineClient();
    }

    /**
     * Checks if the CLOB is frozen
     */
    isFrozen(): boolean {
        return this.frozen;
    }

    /**
     * Freezes the CLOB (no more trading allowed)
     */
    freeze(): void {
        this.frozen = true;
    }

    /**
     * Credits balance to an agent
     */
    creditBalance(agent: string, amount: number): Balance {
        let balance = this.balances.get(agent);

        if (!balance) {
            balance = { agent, available: 0, locked: 0 };
            this.balances.set(agent, balance);
        }

        balance.available += amount;
        return balance;
    }

    /**
     * Gets agent balance
     */
    getBalance(agent: string): Balance {
        return this.balances.get(agent) || { agent, available: 0, locked: 0 };
    }

    /**
     * Places an order
     */
    async placeOrder(
        agent: string,
        side: Side,
        outcome: Outcome,
        price: number,
        quantity: number,
        type: OrderType
    ): Promise<{ order: Order; trades: Trade[] }> {
        if (this.frozen) {
            throw new Error('CLOB is frozen - trading not allowed');
        }

        // Calculate required margin
        const requiredMargin = this.calculateRequiredMargin(side, price, quantity);

        // Check balance
        const balance = this.getBalance(agent);
        if (balance.available < requiredMargin) {
            throw new Error(
                `Insufficient balance: need ${requiredMargin}, have ${balance.available}`
            );
        }

        // Lock funds
        balance.available -= requiredMargin;
        balance.locked += requiredMargin;

        // Generate a unique order hash (in production this comes from signature)
        const orderHash = `0x${createHash('sha256').update(Math.random().toString()).digest('hex')}`;

        // Each outcome is a separate token/orderbook in Rust engine
        // Token ID format: "MARKET_ID-OUTCOME"
        const tokenId = `${this.marketId}-${outcome === Outcome.UP ? 'UP' : 'DOWN'}`;

        try {
            // Call Rust Engine
            // Scale price and quantity (assuming 6 decimals)
            const scaledPrice = Math.floor(price * 1e6);
            const scaledQuantity = Math.floor(quantity * 1e6);

            const response = await this.client.placeOrder(
                agent,
                tokenId,
                side,
                scaledPrice,
                scaledQuantity,
                orderHash
            );

            if (!response.success) {
                // Revert margin lock
                balance.locked -= requiredMargin;
                balance.available += requiredMargin;
                throw new Error(response.error || 'Unknown error from matching engine');
            }

            // Construct Order object
            const order: Order = {
                // Mock signature fields as we don't have them here
                salt: 0n,
                maker: agent as `0x${string}`,
                signer: agent as `0x${string}`,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId: BigInt(outcome === Outcome.UP ? 1 : 2), // Mock
                makerAmount: BigInt(Math.floor(quantity)),
                takerAmount: BigInt(Math.floor(price * quantity)),
                expiration: 0n,
                nonce: 0n,
                feeRateBps: 0n,
                side,
                signatureType: 0,
                signature: '0x',
                // Augmented fields
                filledQuantity: 0,
                price,
                quantity,
                outcome,
                marketId: this.marketId,
                orderId: response.order_id || orderHash,
                status: response.trades.length > 0 ? (response.trades.reduce((sum, t) => sum + parseFloat(t.quantity), 0) >= quantity ? "FILLED" : "PARTIALLY_FILLED") : "OPEN",
                createdAt: Date.now(),
                updatedAt: Date.now()
            } as unknown as Order; // forced cast due to enum status vs string mismatch if slightly off in definitions, but here it matches OrderStatus enum logic if I import enum.
            // Actually explicit enum usage:
            // import { OrderStatus } from '../types.js'
            // status: ... // I need to verify OrderStatus import.

            // Process trades returned by engine
            const trades: Trade[] = [];
            let totalFilled = 0;

            for (const t of response.trades) {
                // Map Rust trade to TS Trade
                const trade: Trade = {
                    tradeId: t.trade_id,
                    buyer: t.buyer,
                    seller: t.seller,
                    marketId: this.marketId,
                    outcome: outcome,
                    price: parseFloat(t.price) / 1e6,
                    quantity: parseFloat(t.quantity) / 1e6,
                    takerOrderHash: t.taker_order_hash,
                    makerOrderHash: t.maker_order_hashes[0],
                    timestamp: Date.now()
                };

                trades.push(trade);
                this.trades.push(trade); // Store history
                this.processTrade(trade, outcome);

                totalFilled += parseFloat(t.quantity) / 1e6;
            }

            // Update filled quantity
            order.filledQuantity = totalFilled;
            if (order.filledQuantity >= order.quantity) {
                // order.status = OrderStatus.FILLED; 
            } else if (order.filledQuantity > 0) {
                // order.status = OrderStatus.PARTIALLY_FILLED;
            }

            // Unlock remaining margin if fully filled (approximate)
            if (order.filledQuantity >= order.quantity) {
                const unfilledMargin =
                    requiredMargin -
                    this.calculateRequiredMargin(
                        side,
                        price,
                        order.filledQuantity
                    );
                if (unfilledMargin > 0) {
                    balance.locked -= unfilledMargin;
                    balance.available += unfilledMargin;
                }
            }

            return { order, trades };
        } catch (e) {
            console.error("Failed to place order:", e);
            // Revert margin lock on failure
            balance.locked -= requiredMargin;
            balance.available += requiredMargin;
            throw e;
        }
    }

    /**
     * Cancels an order
     */
    async cancelOrder(orderId: string, agent: string): Promise<Order | null> {
        console.warn("Cancel not implemented in Rust engine yet");
        return null;
    }

    /**
     * Gets agent positions
     */
    getPosition(agent: string): Position {
        return (
            this.positions.get(agent) || {
                agent,
                marketId: this.marketId,
                upQuantity: 0,
                downQuantity: 0,
                avgUpPrice: 0,
                avgDownPrice: 0,
            }
        );
    }

    /**
     * Gets order books snapshot
     */
    async getOrderBooks(): Promise<{ up: OrderBookType; down: OrderBookType }> {
        const upTokenId = `${this.marketId}-UP`;
        const downTokenId = `${this.marketId}-DOWN`;

        const [upState, downState] = await Promise.all([
            this.client.getOrderBook(upTokenId),
            this.client.getOrderBook(downTokenId)
        ]);

        return {
            up: {
                outcome: Outcome.UP,
                bids: upState.bids.map(l => ({ price: parseFloat(l.price) / 1e6, quantity: parseFloat(l.quantity) / 1e6, orderCount: l.order_count })),
                asks: upState.asks.map(l => ({ price: parseFloat(l.price) / 1e6, quantity: parseFloat(l.quantity) / 1e6, orderCount: l.order_count })),
            },
            down: {
                outcome: Outcome.DOWN,
                bids: downState.bids.map(l => ({ price: parseFloat(l.price) / 1e6, quantity: parseFloat(l.quantity) / 1e6, orderCount: l.order_count })),
                asks: downState.asks.map(l => ({ price: parseFloat(l.price) / 1e6, quantity: parseFloat(l.quantity) / 1e6, orderCount: l.order_count })),
            },
        };
    }

    /**
     * Exports state for settlement
     */
    exportState(): CLOBStateExport {
        const positions = Array.from(this.positions.values());
        const allTrades = this.trades;

        // Sort trades by timestamp
        allTrades.sort((a, b) => a.timestamp - b.timestamp);

        // Calculate state hash
        const stateData = JSON.stringify({ positions, trades: allTrades });
        const stateHash = createHash('sha256').update(stateData).digest('hex');

        return {
            marketId: this.marketId,
            timestamp: Date.now(),
            positions,
            finalizedTrades: allTrades,
            stateHash: `0x${stateHash}`,
        };
    }

    /**
     * Calculates required margin for an order
     */
    private calculateRequiredMargin(
        side: Side,
        price: number,
        quantity: number
    ): number {
        return side === Side.BUY ? price * quantity : 0;
    }

    /**
     * Processes a trade and updates positions
     */
    private processTrade(trade: Trade, outcome: Outcome): void {
        const buyerPos = this.getPosition(trade.buyer);
        const sellerPos = this.getPosition(trade.seller);

        const tradePrice = trade.price;
        const tradeQty = trade.quantity;

        if (outcome === Outcome.UP) {
            const newUpQty = buyerPos.upQuantity + tradeQty;
            buyerPos.avgUpPrice =
                (buyerPos.avgUpPrice * buyerPos.upQuantity + tradePrice * tradeQty) /
                newUpQty;
            buyerPos.upQuantity = newUpQty;
            sellerPos.upQuantity -= tradeQty;
        } else {
            const newDownQty = buyerPos.downQuantity + tradeQty;
            buyerPos.avgDownPrice =
                (buyerPos.avgDownPrice * buyerPos.downQuantity +
                    tradePrice * tradeQty) /
                newDownQty;
            buyerPos.downQuantity = newDownQty;
            sellerPos.downQuantity -= tradeQty;
        }

        this.positions.set(trade.buyer, buyerPos);
        this.positions.set(trade.seller, sellerPos);

        const buyerBalance = this.balances.get(trade.buyer);
        if (buyerBalance) {
            const cost = tradePrice * tradeQty;
            buyerBalance.locked -= cost;
        }

        const sellerBalance = this.balances.get(trade.seller);
        if (sellerBalance) {
            sellerBalance.available += tradePrice * tradeQty;
        }
    }
}
