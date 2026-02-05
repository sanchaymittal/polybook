
import Fastify from 'fastify';
import dotenv from 'dotenv';
import { generatePaymentOffer, validatePayment } from './x402/middleware.js';

dotenv.config();

const fastify = Fastify({ logger: true });

// x402 Middleware Hook
fastify.addHook('preHandler', async (request, reply) => {
    // Skip payment check for non-gated routes
    if (request.url === '/init' || request.url === '/status') return;

    const token = request.headers['authorization'];
    if (!token || !validatePayment(token)) {
        const offer = generatePaymentOffer(request.url);
        reply.code(402)
            .header('WWW-Authenticate', `x402 ${offer}`)
            .send({ error: 'Payment Required', offer });
        return;
    }
});

import axios from 'axios';

const ORCHESTRATOR_URL = 'http://127.0.0.1:3031';

// Routes
fastify.get('/status', async () => {
    return { status: 'READY', x402: 'enabled', orchestrator: ORCHESTRATOR_URL };
});

// Actor: Initialize environment
fastify.post('/init', async (request, reply) => {
    try {
        console.log('[Gateway] Initializing Market and Actor environment...');

        // 1. Create Market
        console.log('[Gateway] Step 1: Creating Market');
        const createRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.create_market',
            params: {
                template: 'BTC_UP_DOWN',
                slug: `market-${Date.now()}`,
                startTimestamp: Date.now(),
                expiryTimestamp: Date.now() + 1000000
            }
        });

        if (!createRes.data.success) throw new Error(`Create failed: ${createRes.data.error}`);
        const marketId = createRes.data.data.marketId;

        // 2. Start Market
        console.log(`[Gateway] Step 2: Starting Market ${marketId}`);
        const startRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.start_market',
            params: { marketId, priceAtStart: 5000000000000 }
        });

        // 3. Mint Capital
        console.log('[Gateway] Step 3: Minting Capital');
        const mintRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.mint_capital',
            params: { intent: 'Actor initialization' },
            agentAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
        });

        // 4. Connect Actor to CLOB
        console.log('[Gateway] Step 4: Connecting Actor');
        const connectRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.connect_to_clob',
            params: { marketId },
            agentAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
        });

        // 5. Connect LP and Place Maker Order (SELL YES @ 0.50)
        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.mint_capital',
            params: { intent: 'LP initialization' },
            agentAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        });

        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.connect_to_clob',
            params: { marketId },
            agentAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        });

        const makerRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.place_order',
            params: {
                marketId,
                side: 1, // SELL
                outcome: 'UP',
                price: 0.50,
                quantity: 100,
                type: 'LIMIT'
            },
            agentAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
        });

        return {
            status: 'INITIALIZED',
            marketId,
            details: {
                create: createRes.data,
                start: startRes.data,
                mint: mintRes.data,
                connect: connectRes.data,
                maker: makerRes.data
            }
        };
    } catch (e: any) {
        console.error('[Gateway] Init failed:', e.message);
        return reply.code(500).send({ error: e.message });
    }
});

// Actor: Buy YES (UP) shares
fastify.post('/buy', async (request, reply) => {
    const { price, quantity, marketId } = request.body as any;
    const targetMarketId = marketId || 1;

    try {
        console.log(`[Gateway] Placing BUY order on market ${targetMarketId}: ${quantity} @ ${price}`);

        const result = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.place_order',
            params: {
                marketId: targetMarketId,
                side: 0, // BUY
                outcome: 'UP',
                price: parseFloat(price) || 0.5,
                quantity: parseFloat(quantity) || 10,
                type: 'LIMIT',
            },
            agentAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
        });

        return { status: 'ORDER_PLACED', result: result.data };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

const start = async () => {
    try {
        await fastify.listen({ port: 3402, host: '0.0.0.0' });
        console.log('Agent Gateway listening on port 3402 at 0.0.0.0');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
