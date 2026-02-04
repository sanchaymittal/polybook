/**
 * PolyBook v1 - Phase 5: Minimal CLOB
 *
 * Simple in-memory Central Limit Order Book with price-time priority.
 * Stores signed Polymarket orders and matches them.
 */
import type { Address, Hex } from 'viem';
import { type Order, Side, type UnsignedOrder, signOrder } from './signing.js';

/**
 * Trade result from matching
 */
export interface Trade {
    tradeId: string;
    buyer: Address;
    seller: Address;
    tokenId: bigint;
    amount: bigint; // Amount of tokens traded
    price: bigint; // Price per token (USDC, 6 decimals)
    takerOrder: Order;
    makerOrders: Order[];
    makerFillAmounts: bigint[];
    timestamp: number;
}

/**
 * Order book entry with tracking info
 */
interface OrderEntry {
    order: Order;
    remaining: bigint; // Remaining amount to fill
    timestamp: number;
}

/**
 * Minimal CLOB for a single market
 */
export class MinimalCLOB {
    // Orders indexed by orderHash
    private orders: Map<Hex, OrderEntry> = new Map();

    // Buy orders for each tokenId (sorted by price DESC, then time ASC)
    private buyBooks: Map<string, OrderEntry[]> = new Map();

    // Sell orders for each tokenId (sorted by price ASC, then time ASC)
    private sellBooks: Map<string, OrderEntry[]> = new Map();

    // Executed trades
    private trades: Trade[] = [];

    // Trade counter for IDs
    private tradeCounter = 0;

    /**
     * Add a signed order to the book
     */
    addOrder(order: Order, orderHash: Hex): void {
        const tokenIdKey = order.tokenId.toString();
        const now = Date.now();

        // Calculate remaining based on side
        // For BUY: remaining is in terms of what maker wants to receive (takerAmount)
        // For SELL: remaining is in terms of what maker wants to sell (makerAmount)
        const remaining = order.side === Side.BUY ? order.takerAmount : order.makerAmount;

        const entry: OrderEntry = {
            order,
            remaining,
            timestamp: now,
        };

        this.orders.set(orderHash, entry);

        if (order.side === Side.BUY) {
            const book = this.buyBooks.get(tokenIdKey) ?? [];
            book.push(entry);
            // Sort by price DESC (best buys first), then time ASC
            book.sort((a, b) => {
                const priceA = this.getPrice(a.order);
                const priceB = this.getPrice(b.order);
                if (priceB !== priceA) {
                    return priceB > priceA ? 1 : -1;
                }
                return a.timestamp - b.timestamp;
            });
            this.buyBooks.set(tokenIdKey, book);
        } else {
            const book = this.sellBooks.get(tokenIdKey) ?? [];
            book.push(entry);
            // Sort by price ASC (best sells first), then time ASC
            book.sort((a, b) => {
                const priceA = this.getPrice(a.order);
                const priceB = this.getPrice(b.order);
                if (priceA !== priceB) {
                    return priceA > priceB ? 1 : -1;
                }
                return a.timestamp - b.timestamp;
            });
            this.sellBooks.set(tokenIdKey, book);
        }
    }

    /**
     * Calculate price from order (USDC per token)
     */
    private getPrice(order: Order): bigint {
        if (order.side === Side.BUY) {
            // BUY: makerAmount is USDC, takerAmount is tokens
            // Price = USDC / tokens
            return (order.makerAmount * 10n ** 6n) / order.takerAmount;
        } else {
            // SELL: makerAmount is tokens, takerAmount is USDC
            // Price = USDC / tokens
            return (order.takerAmount * 10n ** 6n) / order.makerAmount;
        }
    }

    /**
     * Try to match a taker order against existing maker orders
     * Returns trades if matched, empty array if no match
     */
    matchOrder(takerOrder: Order, takerOrderHash: Hex): Trade | null {
        const tokenIdKey = takerOrder.tokenId.toString();
        const takerRemaining =
            takerOrder.side === Side.BUY
                ? takerOrder.takerAmount
                : takerOrder.makerAmount;

        // Get opposing book
        const makerBook =
            takerOrder.side === Side.BUY
                ? this.sellBooks.get(tokenIdKey)
                : this.buyBooks.get(tokenIdKey);

        if (!makerBook || makerBook.length === 0) {
            // No matching orders, add to book
            this.addOrder(takerOrder, takerOrderHash);
            return null;
        }

        // Check if prices cross
        const takerPrice = this.getPrice(takerOrder);
        const bestMakerPrice = this.getPrice(makerBook[0].order);

        const isCrossing =
            takerOrder.side === Side.BUY
                ? takerPrice >= bestMakerPrice // Buyer willing to pay >= seller asks
                : takerPrice <= bestMakerPrice; // Seller asking <= buyer bids

        if (!isCrossing) {
            // No crossing, add to book
            this.addOrder(takerOrder, takerOrderHash);
            return null;
        }

        // Match against maker orders
        const matchedMakers: Order[] = [];
        const fillAmounts: bigint[] = [];
        let remainingToFill = takerRemaining;

        for (const makerEntry of makerBook) {
            if (remainingToFill === 0n) break;

            const makerPrice = this.getPrice(makerEntry.order);
            const crosses =
                takerOrder.side === Side.BUY
                    ? takerPrice >= makerPrice
                    : takerPrice <= makerPrice;

            if (!crosses) break;

            // Calculate fill amount
            const fillAmount =
                remainingToFill < makerEntry.remaining
                    ? remainingToFill
                    : makerEntry.remaining;

            matchedMakers.push(makerEntry.order);
            fillAmounts.push(fillAmount);

            makerEntry.remaining -= fillAmount;
            remainingToFill -= fillAmount;
        }

        if (matchedMakers.length === 0) {
            this.addOrder(takerOrder, takerOrderHash);
            return null;
        }

        // Remove fully filled maker orders from book
        const newBook = makerBook.filter((e) => e.remaining > 0n);
        if (takerOrder.side === Side.BUY) {
            this.sellBooks.set(tokenIdKey, newBook);
        } else {
            this.buyBooks.set(tokenIdKey, newBook);
        }

        // Determine buyer/seller
        const buyer =
            takerOrder.side === Side.BUY
                ? takerOrder.maker
                : matchedMakers[0].maker;
        const seller =
            takerOrder.side === Side.SELL
                ? takerOrder.maker
                : matchedMakers[0].maker;

        // Calculate total amount traded
        const totalAmount = fillAmounts.reduce((a, b) => a + b, 0n);

        // Create trade record
        const trade: Trade = {
            tradeId: `trade-${++this.tradeCounter}`,
            buyer,
            seller,
            tokenId: takerOrder.tokenId,
            amount: totalAmount,
            price: this.getPrice(matchedMakers[0].order), // Use maker's price
            takerOrder,
            makerOrders: matchedMakers,
            makerFillAmounts: fillAmounts,
            timestamp: Date.now(),
        };

        this.trades.push(trade);

        // If taker order not fully filled, add remainder to book
        if (remainingToFill > 0n) {
            const partialEntry: OrderEntry = {
                order: takerOrder,
                remaining: remainingToFill,
                timestamp: Date.now(),
            };
            if (takerOrder.side === Side.BUY) {
                const book = this.buyBooks.get(tokenIdKey) ?? [];
                book.push(partialEntry);
                book.sort((a, b) => {
                    const priceA = this.getPrice(a.order);
                    const priceB = this.getPrice(b.order);
                    if (priceB !== priceA) return priceB > priceA ? 1 : -1;
                    return a.timestamp - b.timestamp;
                });
                this.buyBooks.set(tokenIdKey, book);
            } else {
                const book = this.sellBooks.get(tokenIdKey) ?? [];
                book.push(partialEntry);
                book.sort((a, b) => {
                    const priceA = this.getPrice(a.order);
                    const priceB = this.getPrice(b.order);
                    if (priceA !== priceB) return priceA > priceB ? 1 : -1;
                    return a.timestamp - b.timestamp;
                });
                this.sellBooks.set(tokenIdKey, book);
            }
        }

        return trade;
    }

    /**
     * Get the order book for a token
     */
    getOrderBook(tokenId: bigint): {
        bids: Array<{ price: bigint; quantity: bigint }>;
        asks: Array<{ price: bigint; quantity: bigint }>;
    } {
        const tokenIdKey = tokenId.toString();

        const bids: Array<{ price: bigint; quantity: bigint }> = [];
        const asks: Array<{ price: bigint; quantity: bigint }> = [];

        const buyBook = this.buyBooks.get(tokenIdKey) ?? [];
        for (const entry of buyBook) {
            bids.push({
                price: this.getPrice(entry.order),
                quantity: entry.remaining,
            });
        }

        const sellBook = this.sellBooks.get(tokenIdKey) ?? [];
        for (const entry of sellBook) {
            asks.push({
                price: this.getPrice(entry.order),
                quantity: entry.remaining,
            });
        }

        return { bids, asks };
    }

    /**
     * Get all trades
     */
    getTrades(): Trade[] {
        return [...this.trades];
    }

    /**
     * Clear the order book
     */
    clear(): void {
        this.orders.clear();
        this.buyBooks.clear();
        this.sellBooks.clear();
        this.trades = [];
    }
}
