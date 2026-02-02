/**
 * PolyBook Daemon - Main Entry Point
 *
 * Fastify server that exposes x402-compatible HTTP API
 * for agent interaction with Yellow Network.
 */
import Fastify from 'fastify';
import { getConfig } from './config.js';
import { createX402Middleware } from './x402/middleware.js';
import { registerInitRoute } from './routes/init.js';
import { registerStatusRoute } from './routes/status.js';

/**
 * Prints the startup banner
 */
function printBanner(): void {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                                                          ║');
    console.log('║              🔮 polybook-daemon v0.1.0 🔮                ║');
    console.log('║                                                          ║');
    console.log('║   Agent-side runtime for x402 + Yellow prediction       ║');
    console.log('║   markets. Non-custodial. Agent-native.                  ║');
    console.log('║                                                          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
}

/**
 * Creates and configures the Fastify server
 *
 * @returns Configured Fastify instance
 */
async function createServer() {
    const app = Fastify({
        logger: true,  // Simple logging without pino-pretty
    });

    // Register x402 middleware
    app.addHook('preHandler', createX402Middleware());

    // Register routes
    await registerInitRoute(app);
    await registerStatusRoute(app);

    // Health check endpoint
    app.get('/health', async () => {
        return { status: 'ok', timestamp: new Date().toISOString() };
    });

    return app;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
    printBanner();

    const config = getConfig();

    console.log('Configuration:');
    console.log(`  Port: ${config.port}`);
    console.log(`  Host: ${config.host}`);
    console.log(`  Yellow WS: ${config.yellowWsUrl}`);
    console.log(`  Chain ID: ${config.chainId}`);
    console.log('');

    try {
        const server = await createServer();

        await server.listen({
            port: config.port,
            host: config.host,
        });

        console.log('');
        console.log('🚀 Daemon ready!');
        console.log('');
        console.log('Endpoints:');
        console.log(`  POST http://${config.host}:${config.port}/init`);
        console.log(`  GET  http://${config.host}:${config.port}/status`);
        console.log(`  GET  http://${config.host}:${config.port}/health`);
        console.log('');
        console.log('Call POST /init to bootstrap the daemon.');
        console.log('');

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Run main
main().catch(console.error);
