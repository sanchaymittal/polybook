/**
 * PolyBook Daemon - x402 Middleware
 *
 * Stub x402 enforcement for hackathon MVP.
 * Full cryptographic verification is out of scope.
 */
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * x402 payment header name
 */
const X402_HEADER = 'x-402-payment';

/**
 * Routes that require x402 payment
 */
const PROTECTED_ROUTES = [
    '/markets',
    '/orders',
    '/positions',
];

/**
 * x402 middleware factory
 *
 * For hackathon MVP:
 * - Returns 402 for protected routes without payment header
 * - Accepts any payment header value (no verification)
 *
 * In production, this would:
 * - Verify cryptographic payment proofs
 * - Check payment amounts against route costs
 * - Validate payment signatures
 *
 * @returns Fastify preHandler hook
 */
export function createX402Middleware() {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const path = request.url;

        // Check if route requires payment
        const requiresPayment = PROTECTED_ROUTES.some(
            (route) => path.startsWith(route)
        );

        if (!requiresPayment) {
            return; // Continue to handler
        }

        // Check for payment header
        const paymentHeader = request.headers[X402_HEADER];

        if (!paymentHeader) {
            // Return 402 Payment Required
            return reply.status(402).send({
                success: false,
                error: 'Payment Required',
                hint: `Include ${X402_HEADER} header with payment proof`,
                routes: PROTECTED_ROUTES,
            });
        }

        // For hackathon: accept any payment header (stub verification)
        console.log(`x402 payment received for ${path}: ${paymentHeader}`);

        // Continue to handler
        return;
    };
}

/**
 * Gets the list of protected routes
 *
 * @returns Array of route prefixes requiring x402 payment
 */
export function getProtectedRoutes(): string[] {
    return [...PROTECTED_ROUTES];
}
