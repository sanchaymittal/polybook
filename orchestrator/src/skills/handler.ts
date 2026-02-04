/**
 * PolyBook Orchestrator - Skills Handler Module
 *
 * Handles agent skill requests and routes them to appropriate services.
 * Implements the agent API defined in skill.md.
 */
import { MarketManager } from '../market/index.js';
import {
    Balance,
    CancelOrderParams,
    CreateMarketParams,
    DiscoverMarketsParams,
    Market,
    MarketState,
    Order,
    OrderType,
    Outcome,
    PlaceOrderParams,
    Position,
    Side,
    SkillRequest,
    SkillResponse,
    Trade,
} from '../types.js';
import { createHash } from 'crypto';
import { createOrder, signOrder, UnsignedOrder } from '../signing.js';
import { MARKET_STATE } from '../market-state.js';
import {
    CONTRACTS,
    CHAIN_ID,
    TRADER_A_ADDRESS,
    TRADER_A_PRIVATE_KEY,
    TRADER_B_ADDRESS,
    TRADER_B_PRIVATE_KEY,
    LP_ADDRESS,
    LP_PRIVATE_KEY,
    DEPLOYER_ADDRESS,
    DEPLOYER_PRIVATE_KEY,
} from '../contracts.js';
import { Hex } from 'viem';

/**
 * Skills Handler
 *
 * Routes agent skill requests to the appropriate market/CLOB operations.
 */
export class SkillsHandler {
    private marketManager: MarketManager;

    // Agent balances (separate from CLOB-specific balances)
    private agentBalances: Map<string, number> = new Map();

    // Initial capital amount for agents
    private readonly INITIAL_CAPITAL = 1000;

    constructor(marketManager: MarketManager) {
        this.marketManager = marketManager;
    }

    /**
     * Handles an incoming skill request
     */
    async handleRequest<T, R>(request: SkillRequest<T>): Promise<SkillResponse<R>> {
        const skillName = request.skill.replace('skill.polybook.', '');

        try {
            switch (skillName) {
                case 'mint_capital':
                    return this.mintCapital(request.agentAddress) as SkillResponse<R>;

                case 'create_market':
                    return this.createMarket(
                        request.params as CreateMarketParams
                    ) as SkillResponse<R>;

                case 'discover_markets':
                    return this.discoverMarkets(
                        request.params as DiscoverMarketsParams
                    ) as SkillResponse<R>;

                case 'connect_to_clob':
                    return this.connectToClob(
                        request.agentAddress,
                        (request.params as { marketId: number }).marketId
                    ) as SkillResponse<R>;

                case 'place_order':
                    return await this.placeOrder(
                        request.agentAddress,
                        request.params as PlaceOrderParams
                    ) as SkillResponse<R>;

                case 'cancel_order':
                    return await this.cancelOrder(
                        request.agentAddress,
                        request.params as CancelOrderParams
                    ) as SkillResponse<R>;

                case 'get_positions':
                    return this.getPositions(
                        request.agentAddress,
                        (request.params as { marketId: number }).marketId
                    ) as SkillResponse<R>;

                case 'claim_settlement':
                    return this.claimSettlement(
                        request.agentAddress,
                        (request.params as { marketId: number }).marketId
                    ) as SkillResponse<R>;

                default:
                    return {
                        success: false,
                        error: `Unknown skill: ${request.skill}`,
                    };
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * skill.polybook.mint_capital
     * Mints initial capital for an agent with zero balance
     */
    private mintCapital(agent: string): SkillResponse<{ balance: number }> {
        const currentBalance = this.agentBalances.get(agent) || 0;

        if (currentBalance > 0) {
            return {
                success: false,
                error: 'Agent already has capital',
            };
        }

        this.agentBalances.set(agent, this.INITIAL_CAPITAL);

        return {
            success: true,
            data: { balance: this.INITIAL_CAPITAL },
        };
    }

    /**
     * skill.polybook.create_market
     * Creates a new market (delegates to on-chain transaction)
     */
    private createMarket(
        params: CreateMarketParams
    ): SkillResponse<{ marketId: number; slug: string }> {
        // Validate template
        if (params.template !== 'BTC_UP_DOWN') {
            return {
                success: false,
                error: 'Only BTC_UP_DOWN template is supported',
            };
        }

        // Validate timestamps
        const now = Date.now();
        if (params.startTimestamp <= now) {
            return {
                success: false,
                error: 'Start timestamp must be in the future',
            };
        }

        if (params.expiryTimestamp <= params.startTimestamp) {
            return {
                success: false,
                error: 'Expiry must be after start',
            };
        }

        // In production, this would call the on-chain contract
        // For now, we register it locally
        const marketId = this.marketManager.getAllMarkets().length + 1;
        const market: Market = {
            marketId,
            slug: params.slug,
            startTimestamp: params.startTimestamp,
            expiryTimestamp: params.expiryTimestamp,
            contractAddress: '0x' + '0'.repeat(40), // Placeholder
            state: MarketState.PENDING,
        };

        this.marketManager.registerMarket(market);

        return {
            success: true,
            data: { marketId, slug: params.slug },
        };
    }

    /**
     * skill.polybook.discover_markets
     * Returns markets filtered by state
     */
    private discoverMarkets(
        params: DiscoverMarketsParams
    ): SkillResponse<{ markets: Market[] }> {
        let stateFilter: MarketState;

        switch (params.state) {
            case 'UPCOMING':
                stateFilter = MarketState.PENDING;
                break;
            case 'ACTIVE':
                stateFilter = MarketState.ACTIVE;
                break;
            case 'EXPIRED':
                stateFilter = MarketState.RESOLVED;
                break;
            default:
                return {
                    success: false,
                    error: 'Invalid state filter',
                };
        }

        const markets = this.marketManager.getMarketsByState(stateFilter);

        return {
            success: true,
            data: { markets },
        };
    }

    /**
     * skill.polybook.connect_to_clob
     * Connects agent to a market's CLOB session
     */
    private connectToClob(
        agent: string,
        marketId: number
    ): SkillResponse<{ sessionId: string; connected: boolean }> {
        const clob = this.marketManager.getCLOB(marketId);

        if (!clob) {
            return {
                success: false,
                error: `No active CLOB for market ${marketId}`,
            };
        }

        // Credit agent's capital to the CLOB
        const agentBalance = this.agentBalances.get(agent) || 0;
        if (agentBalance > 0) {
            clob.creditBalance(agent, agentBalance);
        }

        return {
            success: true,
            data: {
                sessionId: `yellow://session/market-${marketId}`,
                connected: true,
            },
        };
    }

    /**
     * skill.polybook.place_order
     * Places an order in the CLOB
     */
    private async placeOrder(
        agent: string,
        params: PlaceOrderParams
    ): Promise<SkillResponse<{ order: Order; trades: Trade[] }>> {
        // Check trading window
        if (!this.marketManager.isTradingAllowed(params.marketId)) {
            return {
                success: false,
                error: 'Trading not allowed for this market',
            };
        }

        const clob = this.marketManager.getCLOB(params.marketId);
        if (!clob) {
            return {
                success: false,
                error: `No CLOB for market ${params.marketId}`,
            };
        }

        // Validate outcome
        if (params.outcome !== Outcome.UP && params.outcome !== Outcome.DOWN) {
            return {
                success: false,
                error: 'Outcome must be UP or DOWN',
            };
        }

        // Validate side
        if (params.side !== Side.BUY && params.side !== Side.SELL) {
            return {
                success: false,
                error: 'Side must be BUY or SELL',
            };
        }

        // Validate type
        if (params.type !== OrderType.LIMIT && params.type !== OrderType.MARKET) {
            return {
                success: false,
                error: 'Type must be LIMIT or MARKET',
            };
        }

        // --- SIGNING LOGIC ---
        try {
            const privateKey = this.getAgentPrivateKey(agent);

            // Generate salt
            const salt = BigInt(`0x${createHash('sha256').update(Math.random().toString()).digest('hex')}`);

            // Resolve real Token ID
            // Assuming simplified single market for now using global MARKET_STATE
            // In a real multi-market setup, we'd lookup token IDs from Market Registry contract on-chain
            const tokenId = params.outcome === Outcome.UP ? MARKET_STATE.yesTokenId : MARKET_STATE.noTokenId;

            // Calculate amounts (scaled by 1e6 for 6 decimals)
            const SCALE = 1_000_000;
            let makerAmount: bigint;
            let takerAmount: bigint;
            const price = params.price;
            const quantity = params.quantity;

            if (params.side === Side.BUY) {
                // Buying YES for USDC
                // takerAmount is Outcome tokens, makerAmount is USDC (Collat)
                takerAmount = BigInt(Math.floor(quantity * SCALE));
                makerAmount = BigInt(Math.floor(price * quantity * SCALE));
            } else {
                // Selling YES for USDC
                // makerAmount is Outcome tokens, takerAmount is USDC (Collat)
                makerAmount = BigInt(Math.floor(quantity * SCALE));
                takerAmount = BigInt(Math.floor(price * quantity * SCALE));
            }

            // Create unsigned order
            const unsignedOrder: UnsignedOrder = createOrder({
                salt,
                maker: agent as `0x${string}`,
                signer: agent as `0x${string}`,
                taker: '0x0000000000000000000000000000000000000000',
                tokenId,
                makerAmount,
                takerAmount,
                expiration: 0n,
                nonce: 0n,
                feeRateBps: 0n,
                side: params.side,
            });

            // Sign
            const signedOrder = await signOrder(unsignedOrder, privateKey);

            // Attach augmented fields needed by CLOB internal logic
            const order: Order = {
                ...signedOrder,
                filledQuantity: 0,
                price: params.price,
                quantity: params.quantity,
                outcome: params.outcome,
                marketId: params.marketId,
                status: 'OPEN', // Initial status
            } as unknown as Order; // Cast due to type augmentation

            // Submit to CLOB
            const result = await clob.placeOrder(order);

            return {
                success: true,
                data: result,
            };

        } catch (e: any) {
            return {
                success: false,
                error: `Failed to sign/place order: ${e.message}`,
            };
        }
    }

    /**
     * Gets private key for a known agent
     */
    private getAgentPrivateKey(agent: string): Hex {
        const normalizedAgent = agent.toLowerCase();
        if (normalizedAgent === TRADER_A_ADDRESS.toLowerCase()) return TRADER_A_PRIVATE_KEY;
        if (normalizedAgent === TRADER_B_ADDRESS.toLowerCase()) return TRADER_B_PRIVATE_KEY;
        if (normalizedAgent === LP_ADDRESS.toLowerCase()) return LP_PRIVATE_KEY;
        if (normalizedAgent === DEPLOYER_ADDRESS.toLowerCase()) return DEPLOYER_PRIVATE_KEY;

        throw new Error(`Unknown agent: ${agent}. Cannot sign order.`);
    }

    /**
     * skill.polybook.cancel_order
     * Cancels an open order
     */
    private async cancelOrder(
        agent: string,
        params: CancelOrderParams
    ): Promise<SkillResponse<{ order: Order | null }>> {
        // Try all markets
        for (const market of this.marketManager.getAllMarkets()) {
            const clob = this.marketManager.getCLOB(market.marketId);
            if (clob) {
                try {
                    const order = await clob.cancelOrder(params.orderId, agent);
                    if (order) {
                        return {
                            success: true,
                            data: { order },
                        };
                    }
                } catch {
                    // Order not in this CLOB, continue
                }
            }
        }

        return {
            success: false,
            error: `Order ${params.orderId} not found`,
        };
    }

    /**
     * skill.polybook.get_positions
     * Gets agent's positions in a market
     */
    private getPositions(
        agent: string,
        marketId: number
    ): SkillResponse<{ position: Position; balance: Balance }> {
        const clob = this.marketManager.getCLOB(marketId);

        if (!clob) {
            return {
                success: false,
                error: `No CLOB for market ${marketId}`,
            };
        }

        return {
            success: true,
            data: {
                position: clob.getPosition(agent),
                balance: clob.getBalance(agent),
            },
        };
    }

    /**
     * skill.polybook.claim_settlement
     * Claims settlement payout for a resolved market
     */
    private claimSettlement(
        agent: string,
        marketId: number
    ): SkillResponse<{ claimed: boolean; message: string }> {
        const market = this.marketManager.getMarket(marketId);

        if (!market) {
            return {
                success: false,
                error: `Market ${marketId} not found`,
            };
        }

        if (market.state !== MarketState.RESOLVED) {
            return {
                success: false,
                error: 'Market is not resolved yet',
            };
        }

        // In production, this would call the on-chain claim() function
        // For now, return success
        return {
            success: true,
            data: {
                claimed: true,
                message: `Settlement claim submitted for market ${marketId}. Check on-chain for payout.`,
            },
        };
    }
}
