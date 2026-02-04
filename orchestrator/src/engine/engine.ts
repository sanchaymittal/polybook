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
import { MARKET_STATE } from '../market-state.js';

/**
 * CLOB Engine for a single market
 *
 * Manages:
 * - Interface with Rust Matching Engine
 * - Agent balances
 * - Position tracking
 * - State export for settlement
 */
export class MarketController {
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
     * Places a signed order
     */
    async placeOrder(signedOrder: Order): Promise<{ order: Order; trades: Trade[] }> {
        if (this.frozen) {
            throw new Error('CLOB is frozen - trading not allowed');
        }

        const agent = signedOrder.maker;
        const side = signedOrder.side;
        const price = signedOrder.price;
        const quantity = signedOrder.quantity;
        const outcome = signedOrder.outcome;

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

        const orderHash = signedOrder.salt.toString(); // Use salt as order hash for tracking in Rust

        try {
            // Send to Rust Matching Engine via Client
            const response = await this.client.placeOrder(signedOrder, orderHash);

            if (!response.success) {
                // Revert margin lock
                balance.locked -= requiredMargin;
                balance.available += requiredMargin;
                throw new Error(response.error || 'Unknown error from matching engine');
            }

            // Update order status based on fill
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
                    price: parseFloat(t.price) / 1e6, // Rust returns scaled
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
            signedOrder.filledQuantity = totalFilled;
            if (signedOrder.filledQuantity > 0) {
                // Update status logic handled by caller or inferred
            }

            // Unlock remaining margin if fully filled (approximate)
            if (signedOrder.filledQuantity >= signedOrder.quantity) {
                const unfilledMargin =
                    requiredMargin -
                    this.calculateRequiredMargin(
                        side,
                        price,
                        signedOrder.filledQuantity
                    );
                if (unfilledMargin > 0) {
                    balance.locked -= unfilledMargin;
                    balance.available += unfilledMargin;
                }
            }

            return { order: signedOrder, trades };
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
        // Use real Token IDs as keys
        const upTokenId = MARKET_STATE.yesTokenId.toString();
        const downTokenId = MARKET_STATE.noTokenId.toString();

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
