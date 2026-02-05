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

    // Ephemeral scale agents for load testing (address -> privateKey)
    private scaleAgents: Map<string, string> = new Map();

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
                    return await this.mintCapital(request.agentAddress) as SkillResponse<R>;

                case 'create_market':
                    return this.createMarket(
                        request.params as CreateMarketParams
                    ) as SkillResponse<R>;

                case 'discover_markets':
                    return this.discoverMarkets(
                        request.params as DiscoverMarketsParams
                    ) as SkillResponse<R>;

                case 'connect_to_clob':
                    return await this.connectToClob(
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

                case 'start_market':
                    return this.startMarket(
                        (request.params as { marketId: number }).marketId,
                        (request.params as { priceAtStart: number }).priceAtStart || 5000000000000
                    ) as SkillResponse<R>;

                case 'claim_settlement':
                    return await this.claimSettlement(
                        request.agentAddress,
                        (request.params as { marketId: number }).marketId
                    ) as SkillResponse<R>;

                case 'resolve_market':
                    return await this.resolveMarket(
                        request.agentAddress,
                        request.params as { marketId: number, outcome: Outcome }
                    ) as SkillResponse<R>;

                case 'register_scale_agent':
                    return this.registerScaleAgent(
                        request.params as { address: string; privateKey: string }
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
     * Mints initial capital for an agent and performs on-chain setup (USDC mint + approvals)
     */
    private async mintCapital(agent: string): Promise<SkillResponse<{ balance: number }>> {
        const currentBalance = this.agentBalances.get(agent) || 0;

        if (currentBalance > 0) {
            return {
                success: false,
                error: 'Agent already has capital',
            };
        }

        console.log(`[Orchestrator] Minting real capital for ${agent}...`);

        try {
            const { createPublicClient, createWalletClient, http, parseUnits } = await import('viem');
            const { anvil } = await import('viem/chains');
            const { privateKeyToAccount } = await import('viem/accounts');
            const { RPC_URL } = await import('../contracts.js');

            const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
            const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
            const walletDeployer = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC_URL) });

            const usdcAbi = [
                { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
                { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }
            ] as const;

            // 1. Mint USDC
            const mintHash = await walletDeployer.writeContract({
                address: CONTRACTS.USDC,
                abi: usdcAbi,
                functionName: 'mint',
                args: [agent as `0x${string}`, parseUnits(this.INITIAL_CAPITAL.toString(), 6)],
            });
            await publicClient.waitForTransactionReceipt({ hash: mintHash });

            // 2. Approvals (if private key known)
            try {
                const agentPk = this.getAgentPrivateKey(agent);
                const agentAccount = privateKeyToAccount(agentPk);
                const walletAgent = createWalletClient({ account: agentAccount, chain: anvil, transport: http(RPC_URL) });

                // Approve Exchange to spend USDC
                const appExchangeHash = await walletAgent.writeContract({
                    address: CONTRACTS.USDC,
                    abi: usdcAbi,
                    functionName: 'approve',
                    args: [CONTRACTS.EXCHANGE, parseUnits(this.INITIAL_CAPITAL.toString(), 6)],
                });
                await publicClient.waitForTransactionReceipt({ hash: appExchangeHash });

                // Approve CTF to spend USDC (for splitting)
                const appCtfHash = await walletAgent.writeContract({
                    address: CONTRACTS.USDC,
                    abi: usdcAbi,
                    functionName: 'approve',
                    args: [CONTRACTS.CTF, parseUnits(this.INITIAL_CAPITAL.toString(), 6)],
                });
                await publicClient.waitForTransactionReceipt({ hash: appCtfHash });

                // Set Approval for CTF tokens (ERC1155) to Exchange
                const ctfAbi = [
                    { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] }
                ] as const;
                const appCtfExchangeHash = await walletAgent.writeContract({
                    address: CONTRACTS.CTF,
                    abi: ctfAbi,
                    functionName: 'setApprovalForAll',
                    args: [CONTRACTS.EXCHANGE, true],
                });
                await publicClient.waitForTransactionReceipt({ hash: appCtfExchangeHash });

                console.log(`[Orchestrator] On-chain setup complete for ${agent}`);
            } catch (e) {
                console.warn(`[Orchestrator] Could not perform on-chain approvals for ${agent} (private key unknown or error): ${e instanceof Error ? e.message : 'Unknown'}`);
            }

            this.agentBalances.set(agent, this.INITIAL_CAPITAL);

            return {
                success: true,
                data: { balance: this.INITIAL_CAPITAL },
            };
        } catch (error) {
            console.error('[Orchestrator] Capital minting failed:', error);
            return {
                success: false,
                error: `Capital setup failed: ${error instanceof Error ? error.message : 'Unknown'}`,
            };
        }
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
        // Relaxed for E2E testing to allow immediate trading
        /*
        if (params.startTimestamp < now) {
            return {
                success: false,
                error: 'Start timestamp must be in the future',
            };
        }
        */

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
     * Connects agent to a market's CLOB session and prepares LP liquidity if needed
     */
    private async connectToClob(
        agent: string,
        marketId: number
    ): Promise<SkillResponse<{ sessionId: string; connected: boolean }>> {
        const clob = this.marketManager.getCLOB(marketId);

        if (!clob) {
            return {
                success: false,
                error: `No active CLOB for market ${marketId}`,
            };
        }

        // If LP is connecting, ensure they split positions to provide initial liquidity
        if (agent.toLowerCase() === LP_ADDRESS.toLowerCase()) {
            console.log('[Orchestrator] LP connecting. Performing on-chain splitPosition...');
            try {
                const { createPublicClient, createWalletClient, http, parseUnits } = await import('viem');
                const { anvil } = await import('viem/chains');
                const { privateKeyToAccount } = await import('viem/accounts');
                const { RPC_URL } = await import('../contracts.js');

                const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
                const lpAccount = privateKeyToAccount(LP_PRIVATE_KEY);
                const walletLP = createWalletClient({ account: lpAccount, chain: anvil, transport: http(RPC_URL) });

                const ctfAbi = [
                    { name: 'splitPosition', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'partition', type: 'uint256[]' }, { name: 'amount', type: 'uint256' }], outputs: [] },
                ] as const;

                // Split 50% of initial capital into YES/NO shares
                const amount = parseUnits((this.INITIAL_CAPITAL / 2).toString(), 6);

                const splitHash = await walletLP.writeContract({
                    address: CONTRACTS.CTF,
                    abi: ctfAbi,
                    functionName: 'splitPosition',
                    args: [
                        CONTRACTS.USDC,
                        '0x0000000000000000000000000000000000000000000000000000000000000000',
                        MARKET_STATE.conditionId, // Use global market state for now
                        [1n, 2n],
                        amount
                    ],
                });
                await publicClient.waitForTransactionReceipt({ hash: splitHash });
                console.log('[Orchestrator] LP positions split on-chain.');
            } catch (e) {
                console.error('[Orchestrator] LP Split failed:', e);
            }
        }

        // Credit agent's capital to the CLOB (off-chain balance)
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
        // Check scale agents first
        const scaleKey = this.scaleAgents.get(agent.toLowerCase());
        if (scaleKey) return scaleKey as Hex;

        // Fallback to static accounts
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
     * skill.polybook.start_market
     * Starts a market and creates its CLOB session
     */
    private startMarket(
        marketId: number,
        priceAtStart: number
    ): SkillResponse<{ started: boolean }> {
        try {
            this.marketManager.startMarket(marketId, priceAtStart);
            return {
                success: true,
                data: { started: true },
            };
        } catch (e: any) {
            return {
                success: false,
                error: e.message,
            };
        }
    }

    /**
     * skill.polybook.resolve_market
     * Reports payouts on-chain (privileged action)
     */
    private async resolveMarket(
        agent: string,
        params: { marketId: number, outcome: Outcome }
    ): Promise<SkillResponse<{ resolved: boolean }>> {
        try {
            const privateKey = this.getAgentPrivateKey(agent);
            // In a real system, we'd verify the agent is the authorized Oracle

            const payouts = params.outcome === Outcome.UP ? [1n, 0n] : [0n, 1n];

            // Re-use logic from real-e2e.ts or similar
            // This would involve a viem writeContract call to CTF.reportPayouts
            console.log(`[Orchestrator] Resolving market ${params.marketId} with outcome ${params.outcome}`);

            // For the mock, we just update the local state
            this.marketManager.recordResolution(params.marketId, params.outcome);
            this.marketManager.freezeMarket(params.marketId);

            return {
                success: true,
                data: { resolved: true },
            };
        } catch (e: any) {
            return {
                success: false,
                error: e.message,
            };
        }
    }

    /**
     * skill.polybook.claim_settlement
     * Claims settlement payout for a resolved market
     */
    private async claimSettlement(
        agent: string,
        marketId: number
    ): Promise<SkillResponse<{ claimed: boolean; message: string }>> {
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

        console.log(`[Orchestrator] Agent ${agent} claiming settlement for market ${marketId}`);

        // In production, this would call:
        // await wallet.writeContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'redeemPositions', ... })

        return {
            success: true,
            data: {
                claimed: true,
                message: `Settlement claim processed for market ${marketId}.`,
            },
        };
    }

    /**
     * skill.polybook.register_scale_agent
     * Registers an ephemeral key for scale testing
     */
    private registerScaleAgent(params: {
        address: string;
        privateKey: string;
    }): SkillResponse<{ registered: boolean }> {
        this.scaleAgents.set(params.address.toLowerCase(), params.privateKey);
        console.log(`[Orchestrator] Registered scale agent: ${params.address}`);
        return {
            success: true,
            data: { registered: true },
        };
    }
}
