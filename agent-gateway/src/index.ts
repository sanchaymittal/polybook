
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

// Routes
fastify.get('/status', async () => {
    return { status: 'READY', x402: 'enabled' };
});

fastify.post('/init', async () => {
    return { status: 'INITIALIZED', address: '0xAgent...' };
});

fastify.post('/buy', async (request, reply) => {
    return { status: 'ORDER_PLACED', tx: '0x123...' };
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
