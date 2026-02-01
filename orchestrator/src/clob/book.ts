/**
 * PolyBook Orchestrator - Order Book Module
 *
 * Implements a limit order book for a single outcome (UP or DOWN).
 * Supports limit orders, market orders, partial fills, and cancellation.
 */
import { v4 as uuidv4 } from 'uuid';
import {
    Order,
    OrderStatus,
    OrderType,
    Outcome,
    Side,
    Trade,
    BookLevel,
} from '../types.js';

/**
 * Price level containing orders at a single price point
 */
interface PriceLevel {
    price: number;
    orders: Order[];
}

/**
 * OrderBook for a single outcome (UP or DOWN)
 *
 * Uses price-time priority for matching.
 */
export class OrderBook {
    private readonly outcome: Outcome;
    private readonly marketId: number;

    // Price levels - maps price to array of orders
    private bids: Map<number, Order[]> = new Map();  // Buy orders (higher is better)
    private asks: Map<number, Order[]> = new Map();  // Sell orders (lower is better)

    // All orders by ID for fast lookup
    private orders: Map<string, Order> = new Map();

    // Trade history
    private trades: Trade[] = [];

    constructor(marketId: number, outcome: Outcome) {
        this.marketId = marketId;
        this.outcome = outcome;
    }

    /**
     * Places a new order in the book
     */
    placeOrder(
        agent: string,
        side: Side,
        price: number,
        quantity: number,
        type: OrderType
    ): { order: Order; trades: Trade[] } {
        // Validate price range
        if (price < 0 || price > 1) {
            throw new Error('Price must be between 0 and 1');
        }

        if (quantity <= 0) {
            throw new Error('Quantity must be positive');
        }

        // Create order
        const order: Order = {
            orderId: uuidv4(),
            marketId: this.marketId,
            agent,
            side,
            outcome: this.outcome,
            price,
            quantity,
            filledQuantity: 0,
            status: OrderStatus.OPEN,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        // Try to match the order
        const matchedTrades = this.matchOrder(order, type);

        // If order is not fully filled, add to book (for limit orders)
        if (order.filledQuantity < order.quantity && type === OrderType.LIMIT) {
            this.addToBook(order);
        } else if (order.filledQuantity >= order.quantity) {
            order.status = OrderStatus.FILLED;
        }

        // Store the order
        this.orders.set(order.orderId, order);

        return { order, trades: matchedTrades };
    }

    /**
     * Cancels an existing order
     */
    cancelOrder(orderId: string, agent: string): Order | null {
        const order = this.orders.get(orderId);

        if (!order) {
            return null;
        }

        if (order.agent !== agent) {
            throw new Error('Cannot cancel order belonging to another agent');
        }

        if (order.status === OrderStatus.FILLED || order.status === OrderStatus.CANCELLED) {
            throw new Error('Order is already completed');
        }

        // Remove from book
        this.removeFromBook(order);

        // Update status
        order.status = OrderStatus.CANCELLED;
        order.updatedAt = Date.now();

        return order;
    }

    /**
     * Gets the current order book snapshot
     */
    getSnapshot(): { bids: BookLevel[]; asks: BookLevel[] } {
        // Aggregate bids
        const bidLevels: BookLevel[] = [];
        const sortedBidPrices = Array.from(this.bids.keys()).sort((a, b) => b - a);
        for (const price of sortedBidPrices) {
            const orders = this.bids.get(price) || [];
            const quantity = orders.reduce(
                (sum, o) => sum + (o.quantity - o.filledQuantity),
                0
            );
            if (quantity > 0) {
                bidLevels.push({ price, quantity, orderCount: orders.length });
            }
        }

        // Aggregate asks
        const askLevels: BookLevel[] = [];
        const sortedAskPrices = Array.from(this.asks.keys()).sort((a, b) => a - b);
        for (const price of sortedAskPrices) {
            const orders = this.asks.get(price) || [];
            const quantity = orders.reduce(
                (sum, o) => sum + (o.quantity - o.filledQuantity),
                0
            );
            if (quantity > 0) {
                askLevels.push({ price, quantity, orderCount: orders.length });
            }
        }

        return { bids: bidLevels, asks: askLevels };
    }

    /**
     * Gets an order by ID
     */
    getOrder(orderId: string): Order | undefined {
        return this.orders.get(orderId);
    }

    /**
     * Gets all orders for an agent
     */
    getAgentOrders(agent: string): Order[] {
        return Array.from(this.orders.values()).filter((o) => o.agent === agent);
    }

    /**
     * Gets all trades
     */
    getTrades(): Trade[] {
        return [...this.trades];
    }

    /**
     * Matches an incoming order against the book
     */
    private matchOrder(order: Order, type: OrderType): Trade[] {
        const trades: Trade[] = [];

        // Get opposite side
        const oppositeBook = order.side === Side.BUY ? this.asks : this.bids;

        // Get sorted prices (best first)
        const prices =
            order.side === Side.BUY
                ? Array.from(oppositeBook.keys()).sort((a, b) => a - b)   // Lowest ask first
                : Array.from(oppositeBook.keys()).sort((a, b) => b - a); // Highest bid first

        for (const price of prices) {
            // Check if price is acceptable
            if (type === OrderType.LIMIT) {
                if (order.side === Side.BUY && price > order.price) break;
                if (order.side === Side.SELL && price < order.price) break;
            }

            const levelOrders = oppositeBook.get(price) || [];

            for (let i = 0; i < levelOrders.length; i++) {
                const matchedOrder = levelOrders[i];

                // Skip own orders
                if (matchedOrder.agent === order.agent) continue;

                // Calculate fill quantity
                const remainingIncoming = order.quantity - order.filledQuantity;
                const remainingMatched = matchedOrder.quantity - matchedOrder.filledQuantity;
                const fillQuantity = Math.min(remainingIncoming, remainingMatched);

                if (fillQuantity <= 0) continue;

                // Execute trade
                const trade: Trade = {
                    tradeId: uuidv4(),
                    marketId: this.marketId,
                    outcome: this.outcome,
                    price,
                    quantity: fillQuantity,
                    buyOrderId: order.side === Side.BUY ? order.orderId : matchedOrder.orderId,
                    sellOrderId: order.side === Side.SELL ? order.orderId : matchedOrder.orderId,
                    buyer: order.side === Side.BUY ? order.agent : matchedOrder.agent,
                    seller: order.side === Side.SELL ? order.agent : matchedOrder.agent,
                    timestamp: Date.now(),
                };

                trades.push(trade);
                this.trades.push(trade);

                // Update fill quantities
                order.filledQuantity += fillQuantity;
                order.updatedAt = Date.now();
                matchedOrder.filledQuantity += fillQuantity;
                matchedOrder.updatedAt = Date.now();

                // Update order statuses
                if (matchedOrder.filledQuantity >= matchedOrder.quantity) {
                    matchedOrder.status = OrderStatus.FILLED;
                    // Remove from level
                    levelOrders.splice(i, 1);
                    i--;
                } else {
                    matchedOrder.status = OrderStatus.PARTIALLY_FILLED;
                }

                if (order.filledQuantity > 0 && order.filledQuantity < order.quantity) {
                    order.status = OrderStatus.PARTIALLY_FILLED;
                }

                // Stop if incoming order is fully filled
                if (order.filledQuantity >= order.quantity) {
                    order.status = OrderStatus.FILLED;
                    return trades;
                }
            }

            // Clean up empty level
            if (levelOrders.length === 0) {
                oppositeBook.delete(price);
            }
        }

        return trades;
    }

    /**
     * Adds an order to the book
     */
    private addToBook(order: Order): void {
        const book = order.side === Side.BUY ? this.bids : this.asks;

        if (!book.has(order.price)) {
            book.set(order.price, []);
        }

        book.get(order.price)!.push(order);
    }

    /**
     * Removes an order from the book
     */
    private removeFromBook(order: Order): void {
        const book = order.side === Side.BUY ? this.bids : this.asks;
        const levelOrders = book.get(order.price);

        if (levelOrders) {
            const idx = levelOrders.findIndex((o) => o.orderId === order.orderId);
            if (idx !== -1) {
                levelOrders.splice(idx, 1);
            }

            if (levelOrders.length === 0) {
                book.delete(order.price);
            }
        }
    }
}
