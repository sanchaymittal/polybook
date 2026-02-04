/**
 * PolyBook Orchestrator - Market Manager Module
 *
 * Manages market lifecycle:
 * - Creates CLOB sessions when markets start
 * - Enforces trading windows
 * - Freezes CLOB on expiry
 * - Prepares state for settlement
 */
import { MarketController } from '../engine/index.js';
import { Market, MarketState, Outcome } from '../types.js';

/**
 * Market Manager
 *
 * Coordinates between on-chain market contracts and off-chain CLOB sessions.
 */
export class MarketManager {
    // Active markets indexed by ID
    private markets: Map<number, Market> = new Map();

    // CLOB engines indexed by market ID
    private clobEngines: Map<number, MarketController> = new Map();

    /**
     * Registers a new market (from MarketCreated event)
     */
    registerMarket(market: Market): void {
        this.markets.set(market.marketId, market);
        console.log(`[MarketManager] Registered market ${market.marketId}: ${market.slug}`);
    }

    /**
     * Starts a market's CLOB session (from MarketStarted event)
     */
    startMarket(marketId: number, priceAtStart: number): MarketController {
        const market = this.markets.get(marketId);
        if (!market) {
            throw new Error(`Market ${marketId} not found`);
        }

        if (market.state !== MarketState.PENDING) {
            throw new Error(`Market ${marketId} is not in PENDING state`);
        }

        // Update market state
        market.state = MarketState.ACTIVE;
        market.priceAtStart = priceAtStart;

        // Create CLOB engine
        const sessionId = `market-${marketId}`;
        const engine = new MarketController(marketId, sessionId);
        this.clobEngines.set(marketId, engine);

        console.log(`[MarketManager] Started market ${marketId}, price at start: ${priceAtStart}`);

        return engine;
    }

    /**
     * Checks if trading is allowed for a market
     */
    isTradingAllowed(marketId: number): boolean {
        const market = this.markets.get(marketId);
        if (!market) return false;

        const now = Date.now();

        return (
            market.state === MarketState.ACTIVE &&
            now >= market.startTimestamp &&
            now < market.expiryTimestamp
        );
    }

    /**
     * Freezes a market's CLOB (on expiry)
     */
    freezeMarket(marketId: number): void {
        const engine = this.clobEngines.get(marketId);
        if (engine) {
            engine.freeze();
        }

        const market = this.markets.get(marketId);
        if (market) {
            market.state = MarketState.RESOLVED;
        }

        console.log(`[MarketManager] Froze market ${marketId}`);
    }

    /**
     * Gets the CLOB engine for a market
     */
    getCLOB(marketId: number): MarketController | undefined {
        return this.clobEngines.get(marketId);
    }

    /**
     * Gets market info
     */
    getMarket(marketId: number): Market | undefined {
        return this.markets.get(marketId);
    }

    /**
     * Gets all markets by state
     */
    getMarketsByState(state: MarketState): Market[] {
        return Array.from(this.markets.values()).filter((m) => m.state === state);
    }

    /**
     * Gets all markets
     */
    getAllMarkets(): Market[] {
        return Array.from(this.markets.values());
    }

    /**
     * Exports state for settlement
     */
    exportStateForSettlement(marketId: number) {
        const engine = this.clobEngines.get(marketId);
        if (!engine) {
            throw new Error(`CLOB not found for market ${marketId}`);
        }

        if (!engine.isFrozen()) {
            throw new Error(`Market ${marketId} is not frozen yet`);
        }

        return engine.exportState();
    }

    /**
     * Records market resolution (from MarketResolved event)
     */
    recordResolution(marketId: number, outcome: Outcome): void {
        const market = this.markets.get(marketId);
        if (market) {
            market.outcome = outcome;
            market.state = MarketState.RESOLVED;
        }
    }
}
