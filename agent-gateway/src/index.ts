
import Fastify from 'fastify';
import dotenv from 'dotenv';

dotenv.config();

const fastify = Fastify({ logger: true });

import axios from 'axios';
import { ClobClient } from './clob_client.js';

const ORCHESTRATOR_URL = 'http://127.0.0.1:3031'; // Deprecated

// Demo Accounts
const ACTOR_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // 0x3C44... (Alice)
const LP_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";    // 0xf39F... (Deployer)
// Addresses
const ACTOR_ADDR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const LP_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Store current market context in memory
let currentMarket: any = null;

// Routes
fastify.get('/status', async () => {
    return { status: 'READY', clob: 'http://127.0.0.1:3030' };
});

// Actor: Initialize environment
fastify.post('/init', async (request, reply) => {
    try {
        console.log('[Gateway] Initializing Market and Actor environment...');

        // 1. Create Market
        console.log('[Gateway] Step 1: Creating Market');
        const slug = `market-${Date.now()}`;
        const createRes = await ClobClient.createMarket(slug, "Will BTC Go Up?");

        if (!createRes.success) throw new Error(`Create failed: ${createRes.error}`);
        const market = createRes.market;
        currentMarket = market; // Cache for '/buy' route

        // 2. Mint Capital (Actor + LP)
        console.log('[Gateway] Step 2: Minting Capital');
        await ClobClient.mintCapital(ACTOR_ADDR);
        await ClobClient.mintCapital(LP_ADDR);

        // 3. Place LP Maker Order (SELL YES @ 0.50)
        console.log('[Gateway] Step 3: Placing LP Order');
        const makerRes = await ClobClient.placeOrder(
            LP_PK,
            market,
            'SELL',
            0.50,
            100
        );

        return {
            status: 'INITIALIZED',
            marketId: market.market_id,
            details: {
                market,
                maker: makerRes
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

    // Use cached market if available, else fail (basic demo limit)
    const market = currentMarket;
    if (!market) {
        return reply.code(400).send({ error: "Market not initialized. Call /init first." });
    }

    try {
        console.log(`[Gateway] Placing BUY order on market: ${quantity} @ ${price}`);

        const result = await ClobClient.placeOrder(
            ACTOR_PK,
            market,
            'BUY',
            parseFloat(price) || 0.5,
            parseFloat(quantity) || 10
        );

        return { status: 'ORDER_PLACED', result };
    } catch (e: any) {
        console.error(e);
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
