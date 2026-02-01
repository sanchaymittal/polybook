/**
 * PolyBook Orchestrator - Main Entry Point
 *
 * Initializes and runs the market orchestrator service.
 */
import { getConfig } from './config.js';
import { MarketManager } from './market/index.js';
import { SkillsHandler } from './skills/index.js';
import { MarketState, Outcome } from './types.js';

/**
 * PolyBook CLOB Service
 *
 * Main CLOB service that:
 * - Manages market lifecycle
 * - Routes agent skill requests
 * - Coordinates CLOB sessions
 * - (In production) Listens to on-chain events
 */
class PolyBookCLOB {
    private config = getConfig();
    private marketManager: MarketManager;
    private skillsHandler: SkillsHandler;

    constructor() {
        this.marketManager = new MarketManager();
        this.skillsHandler = new SkillsHandler(this.marketManager);
    }

    /**
     * Starts the CLOB service
     */
    async start(): Promise<void> {
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║             PolyBook CLOB Service Starting...        ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  Chain ID: ${this.config.chainId.toString().padEnd(42)}║`);
        console.log(`║  Yellow WS: ${this.config.yellowWsUrl.slice(0, 40).padEnd(41)}║`);
        console.log('╚══════════════════════════════════════════════════════╝');

        // In production, this would:
        // 1. Connect to Yellow Network WebSocket
        // 2. Authenticate and establish session
        // 3. Listen to on-chain events (MarketCreated, MarketStarted, etc.)
        // 4. Start API server for agent skill requests

        // For MVP, we'll demonstrate the flow with a mock scenario
        await this.runDemoScenario();
    }

    /**
     * Runs a demo scenario showing the market lifecycle
     */
    private async runDemoScenario(): Promise<void> {
        console.log('\n=== Running Demo Scenario ===\n');

        // 1. Create a market
        console.log('1. Creating a market...');
        const now = Date.now();
        const createResult = await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.create_market',
            params: {
                template: 'BTC_UP_DOWN',
                slug: 'btc-5min-demo',
                startTimestamp: now + 1000, // 1 second from now
                expiryTimestamp: now + 60000, // 1 minute from now
            },
            agentAddress: '0xAgent1',
            timestamp: now,
        });
        console.log('Create result:', createResult);

        // 2. Mint capital for agents
        console.log('\n2. Minting capital for agents...');
        const agent1 = '0xAgent1';
        const agent2 = '0xAgent2';

        await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.mint_capital',
            params: { intent: 'Trading in prediction market' },
            agentAddress: agent1,
            timestamp: now,
        });

        await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.mint_capital',
            params: { intent: 'Trading in prediction market' },
            agentAddress: agent2,
            timestamp: now,
        });
        console.log('Capital minted for both agents');

        // 3. Simulate market start (normally from on-chain event)
        console.log('\n3. Starting market (simulating MarketStarted event)...');
        const marketId = 1;
        const priceAtStart = 50000 * 1e8; // $50,000
        this.marketManager.startMarket(marketId, priceAtStart);

        // 4. Connect agents to CLOB
        console.log('\n4. Connecting agents to CLOB...');
        await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.connect_to_clob',
            params: { marketId: 1 },
            agentAddress: agent1,
            timestamp: now,
        });

        await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.connect_to_clob',
            params: { marketId: 1 },
            agentAddress: agent2,
            timestamp: now,
        });
        console.log('Both agents connected');

        // 5. Place orders
        console.log('\n5. Placing orders...');

        // Agent1 buys UP at 0.60
        const order1Result = await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.place_order',
            params: {
                marketId: 1,
                side: 'BUY',
                outcome: 'UP',
                price: 0.60,
                quantity: 10,
                type: 'LIMIT',
            },
            agentAddress: agent1,
            timestamp: now,
        });
        console.log('Agent1 BUY UP order:', order1Result);

        // Agent2 sells UP at 0.60
        const order2Result = await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.place_order',
            params: {
                marketId: 1,
                side: 'SELL',
                outcome: 'UP',
                price: 0.60,
                quantity: 5,
                type: 'LIMIT',
            },
            agentAddress: agent2,
            timestamp: now,
        });
        console.log('Agent2 SELL UP order:', order2Result);

        // 6. Check positions
        console.log('\n6. Checking positions...');
        const pos1 = await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.get_positions',
            params: { marketId: 1 },
            agentAddress: agent1,
            timestamp: now,
        });
        console.log('Agent1 position:', pos1);

        const pos2 = await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.get_positions',
            params: { marketId: 1 },
            agentAddress: agent2,
            timestamp: now,
        });
        console.log('Agent2 position:', pos2);

        // 7. Get order book
        console.log('\n7. Order book snapshot...');
        const clob = this.marketManager.getCLOB(1);
        if (clob) {
            const books = clob.getOrderBooks();
            console.log('UP book:', books.up);
            console.log('DOWN book:', books.down);
        }

        // 8. Freeze and export state
        console.log('\n8. Freezing market and exporting state...');
        this.marketManager.freezeMarket(1);
        const stateExport = this.marketManager.exportStateForSettlement(1);
        console.log('State export:', {
            marketId: stateExport.marketId,
            positionCount: stateExport.positions.length,
            tradeCount: stateExport.finalizedTrades.length,
            stateHash: stateExport.stateHash,
        });

        // 9. Record resolution
        console.log('\n9. Recording resolution (simulating MarketResolved event)...');
        this.marketManager.recordResolution(1, Outcome.UP);
        console.log('Market resolved with outcome: UP');

        // 10. Claim settlement
        console.log('\n10. Claiming settlements...');
        const claim1 = await this.skillsHandler.handleRequest({
            skill: 'skill.polybook.claim_settlement',
            params: { marketId: 1 },
            agentAddress: agent1,
            timestamp: now,
        });
        console.log('Agent1 claim result:', claim1);

        console.log('\n=== Demo Complete ===\n');
    }
}

// Main entry
const clobService = new PolyBookCLOB();
clobService.start().catch(console.error);
