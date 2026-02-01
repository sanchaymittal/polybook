/**
 * PolyBook Orchestrator - CLOB Engine Module
 *
 * Central limit order book engine managing both UP and DOWN order books
 * for a single market.
 */
import { createHash } from 'crypto';
import { OrderBook } from './book.js';
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
 * - Two order books (UP and DOWN outcomes)
 * - Agent balances
 * - Position tracking
 * - State export for settlement
 */
export class CLOBEngine {
    private readonly marketId: number;
    private readonly sessionId: string;

    // Order books for each outcome
    private upBook: OrderBook;
    private downBook: OrderBook;

    // Agent balances
    private balances: Map<string, Balance> = new Map();

    // Agent positions
    private positions: Map<string, Position> = new Map();

    // Whether trading is frozen (after market expiry)
    private frozen: boolean = false;

    constructor(marketId: number, sessionId: string) {
        this.marketId = marketId;
        this.sessionId = sessionId;
        this.upBook = new OrderBook(marketId, Outcome.UP);
        this.downBook = new OrderBook(marketId, Outcome.DOWN);
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
    placeOrder(
        agent: string,
        side: Side,
        outcome: Outcome,
        price: number,
        quantity: number,
        type: OrderType
    ): { order: Order; trades: Trade[] } {
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

        // Get the appropriate book
        const book = outcome === Outcome.UP ? this.upBook : this.downBook;

        // Place order
        const result = book.placeOrder(agent, side, price, quantity, type);

        // Process trades
        for (const trade of result.trades) {
            this.processTrade(trade);
        }

        // Unlock remaining margin if order is complete
        if (result.order.filledQuantity >= result.order.quantity) {
            const unfilledMargin =
                requiredMargin -
                this.calculateRequiredMargin(
                    side,
                    price,
                    result.order.filledQuantity
                );
            if (unfilledMargin > 0) {
                balance.locked -= unfilledMargin;
                balance.available += unfilledMargin;
            }
        }

        return result;
    }

    /**
     * Cancels an order
     */
    cancelOrder(orderId: string, agent: string): Order | null {
        // Try both books
        let order = this.upBook.cancelOrder(orderId, agent);
        if (!order) {
            order = this.downBook.cancelOrder(orderId, agent);
        }

        if (order) {
            // Unlock margin
            const unfilledQuantity = order.quantity - order.filledQuantity;
            const unlockedMargin = this.calculateRequiredMargin(
                order.side,
                order.price,
                unfilledQuantity
            );

            const balance = this.balances.get(agent);
            if (balance) {
                balance.locked -= unlockedMargin;
                balance.available += unlockedMargin;
            }
        }

        return order;
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
    getOrderBooks(): { up: OrderBookType; down: OrderBookType } {
        const upSnapshot = this.upBook.getSnapshot();
        const downSnapshot = this.downBook.getSnapshot();

        return {
            up: {
                outcome: Outcome.UP,
                bids: upSnapshot.bids,
                asks: upSnapshot.asks,
            },
            down: {
                outcome: Outcome.DOWN,
                bids: downSnapshot.bids,
                asks: downSnapshot.asks,
            },
        };
    }

    /**
     * Exports state for settlement
     */
    exportState(): CLOBStateExport {
        const positions = Array.from(this.positions.values());
        const allTrades = [...this.upBook.getTrades(), ...this.downBook.getTrades()];

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
        // For BUY orders: pay price * quantity
        // For SELL orders: need to have the outcome tokens (simplified: no margin)
        return side === Side.BUY ? price * quantity : 0;
    }

    /**
     * Processes a trade and updates positions
     */
    private processTrade(trade: Trade): void {
        // Update buyer position
        const buyerPos = this.getPosition(trade.buyer);
        const sellerPos = this.getPosition(trade.seller);

        if (trade.outcome === Outcome.UP) {
            // Buyer gains UP tokens
            const newUpQty = buyerPos.upQuantity + trade.quantity;
            buyerPos.avgUpPrice =
                (buyerPos.avgUpPrice * buyerPos.upQuantity + trade.price * trade.quantity) /
                newUpQty;
            buyerPos.upQuantity = newUpQty;

            // Seller loses UP tokens (or mints SHORT position)
            sellerPos.upQuantity -= trade.quantity;
        } else {
            // Buyer gains DOWN tokens
            const newDownQty = buyerPos.downQuantity + trade.quantity;
            buyerPos.avgDownPrice =
                (buyerPos.avgDownPrice * buyerPos.downQuantity +
                    trade.price * trade.quantity) /
                newDownQty;
            buyerPos.downQuantity = newDownQty;

            // Seller loses DOWN tokens
            sellerPos.downQuantity -= trade.quantity;
        }

        // Update position maps
        this.positions.set(trade.buyer, buyerPos);
        this.positions.set(trade.seller, sellerPos);

        // Unlock buyer's margin (trade completed)
        const buyerBalance = this.balances.get(trade.buyer);
        if (buyerBalance) {
            const cost = trade.price * trade.quantity;
            buyerBalance.locked -= cost;
        }

        // Credit seller
        const sellerBalance = this.balances.get(trade.seller);
        if (sellerBalance) {
            sellerBalance.available += trade.price * trade.quantity;
        }
    }
}
