/**
 * PolyBook Daemon - Yellow Authentication
 *
 * Implements the auth_request → auth_challenge → auth_verify flow
 * using @erc7824/nitrolite and viem for EIP-712 signing.
 */
import {
    createAuthRequestMessage,
    createAuthVerifyMessage,
    createEIP712AuthMessageSigner,
} from '@erc7824/nitrolite';
import { createWalletClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { getYellowClient } from './client.js';

/**
 * Authentication result
 */
export interface AuthResult {
    success: boolean;
    jwtToken?: string;
    error?: string;
}

/**
 * Authenticates with Yellow Network ClearNode
 *
 * Flow:
 * 1. Send auth_request with address, session_key, scope
 * 2. Receive auth_challenge with nonce
 * 3. Sign challenge with EIP-712
 * 4. Send auth_verify with signature
 * 5. Receive auth_success with JWT
 *
 * @param privateKey - Private key (hex with 0x prefix)
 * @returns Authentication result with JWT token
 */
export async function authenticateWithYellow(privateKey: Hex): Promise<AuthResult> {
    const client = getYellowClient();

    // Create account from private key
    const account = privateKeyToAccount(privateKey);
    const address: Address = account.address;

    // Create wallet client for signing
    const walletClient = createWalletClient({
        account,
        chain: sepolia,
        transport: http(),
    });

    console.log(`Authenticating with Yellow as: ${address}`);

    // Prepare auth request parameters
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    return new Promise((resolve) => {
        // Handle auth_challenge
        client.on('auth_challenge', async (message: unknown) => {
            try {
                console.log('Received auth_challenge, signing...');

                // Parse raw message (snake_case)
                const rawMsg = message as {
                    res?: [number, string, { challenge_message: string }];
                    result?: { challenge_message: string };
                };

                const rawParams = rawMsg.result || rawMsg.res?.[2];

                if (!rawParams?.challenge_message) {
                    throw new Error('Missing challenge_message in response');
                }

                // Construct SDK-compatible object (camelCase)
                const challengeResponse = {
                    method: 'auth_challenge',
                    params: {
                        challengeMessage: rawParams.challenge_message,
                    },
                };

                // Create EIP-712 message signer
                const eip712Signer = createEIP712AuthMessageSigner(
                    walletClient,
                    {
                        scope: 'console',
                        session_key: address,
                        expires_at: expiresAt,
                        allowances: [],
                    },
                    {
                        name: 'polybook-daemon',
                    }
                );

                // Create and send auth_verify
                const authVerifyMsg = await createAuthVerifyMessage(
                    eip712Signer,
                    challengeResponse as any // Cast to satisfy SDK type
                );

                console.log('Sending auth_verify...');
                client.send(authVerifyMsg);
            } catch (error) {
                console.error('Error handling auth_challenge:', error);
                resolve({
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        });

        // Handle auth_verify response (success or failure)
        client.on('auth_verify', (message: unknown) => {
            try {
                // Parse raw message (snake_case)
                const rawMsg = message as {
                    res?: [number, string, { success?: boolean; jwt_token?: string }];
                    result?: { success?: boolean; jwt_token?: string };
                };

                const params = rawMsg.result || rawMsg.res?.[2];

                if (params?.success) {
                    console.log('Authentication successful!');
                    const jwtToken = params.jwt_token;
                    client.setAuthenticated(true, jwtToken);
                    resolve({
                        success: true,
                        jwtToken,
                    });
                } else {
                    console.error('Authentication failed');
                    resolve({
                        success: false,
                        error: 'Authentication rejected by ClearNode',
                    });
                }
            } catch (error) {
                console.error('Error parsing auth_verify response:', error);
                resolve({
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        });

        // Handle errors
        client.on('error', (message: unknown) => {
            console.error('Auth error:', message);
            resolve({
                success: false,
                error: 'Authentication error from ClearNode',
            });
        });

        // Start auth flow by sending auth_request
        (async () => {
            try {
                const authRequestMsg = await createAuthRequestMessage({
                    address,
                    session_key: address,  // Using main key as session key
                    application: 'polybook-daemon',
                    allowances: [],
                    expires_at: expiresAt,
                    scope: 'console',
                });

                console.log('Sending auth_request...');
                client.send(authRequestMsg);
            } catch (error) {
                console.error('Error creating auth_request:', error);
                resolve({
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        })();

        // Timeout after 30 seconds
        setTimeout(() => {
            resolve({
                success: false,
                error: 'Authentication timed out',
            });
        }, 30000);
    });
}
