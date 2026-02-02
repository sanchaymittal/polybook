/**
 * PolyBook Daemon - Status Route
 *
 * GET /status - Returns current daemon status
 */
import { FastifyInstance } from 'fastify';
import { getYellowClient } from '../yellow/client.js';
import { getDaemonState } from './init.js';
import { getCurrentChannelId } from '../yellow/channel.js';

/**
 * Status response schema
 */
interface StatusResponse {
    ready: boolean;
    agent_address: string | null;
    yellow_connected: boolean;
    yellow_authenticated: boolean;
    channel_id: string | null;
    uptime_seconds: number;
}

// Track server start time
const startTime = Date.now();

/**
 * Registers the /status route
 *
 * @param app - Fastify instance
 */
export async function registerStatusRoute(app: FastifyInstance): Promise<void> {
    app.get('/status', async (_request, reply) => {
        const daemonState = getDaemonState();
        const clientState = getYellowClient().getState();
        const channelId = getCurrentChannelId();

        const response: StatusResponse = {
            ready: daemonState.initialized,
            agent_address: daemonState.address,
            yellow_connected: clientState.connected,
            yellow_authenticated: clientState.authenticated,
            channel_id: channelId,
            uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        };

        return reply.status(200).send(response);
    });
}
