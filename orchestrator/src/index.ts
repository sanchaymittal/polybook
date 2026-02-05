import Fastify from 'fastify';
import { getConfig } from './config.js';
import { MarketManager } from './market/index.js';
import { SkillsHandler } from './skills/index.js';
import { DEPLOYER_ADDRESS } from './contracts.js';

// BigInt JSON normalization
(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

/**
 * PolyBook Orchestrator Service
 *
 * Exposes internal market logic and skills via REST API.
 */
class PolyBookOrchestrator {
    private config = getConfig();
    private marketManager: MarketManager;
    private skillsHandler: SkillsHandler;
    private fastify = Fastify({ logger: true });

    constructor() {
        this.marketManager = new MarketManager();
        this.skillsHandler = new SkillsHandler(this.marketManager);

        this.setupRoutes();
    }

    private setupRoutes() {
        this.fastify.get('/status', async () => {
            return { status: 'OK', service: 'orchestrator' };
        });

        // Main skill execution endpoint
        this.fastify.post('/skill', async (request, reply) => {
            const body = request.body as any;
            console.log(`[Orchestrator] RECEIVED REQUEST: ${JSON.stringify(body)}`);

            // Validate basic structure
            if (!body.skill || !body.params) {
                console.log('[Orchestrator] FAILED VALIDATION');
                return reply.code(400).send({ error: 'Invalid skill request format' });
            }

            console.log(`[Orchestrator] Handling skill: ${body.skill}`);

            const result = await this.skillsHandler.handleRequest({
                skill: body.skill,
                params: body.params,
                agentAddress: body.agentAddress || DEPLOYER_ADDRESS,
                timestamp: Date.now(),
            });

            console.log(`[Orchestrator] RESULT: ${JSON.stringify(result)}`);
            return result;
        });

        // Market health/info
        this.fastify.get('/markets', async () => {
            return { markets: this.marketManager.getAllMarkets() };
        });
    }

    /**
     * Starts the Orchestrator service
     */
    async start(): Promise<void> {
        const port = 3031;
        try {
            await this.fastify.listen({ port, host: '0.0.0.0' });
            console.log('╔══════════════════════════════════════════════════════╗');
            console.log('║           PolyBook Orchestrator Listening...         ║');
            console.log('╠══════════════════════════════════════════════════════╣');
            console.log(`║  Port: ${port.toString().padEnd(46)}║`);
            console.log(`║  Chain ID: ${this.config.chainId.toString().padEnd(42)}║`);
            console.log('╚══════════════════════════════════════════════════════╝');
        } catch (err) {
            this.fastify.log.error(err);
            process.exit(1);
        }
    }
}

// Main entry
const orchestrator = new PolyBookOrchestrator();
orchestrator.start().catch(console.error);
