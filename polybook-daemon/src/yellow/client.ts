/**
 * PolyBook Daemon - Yellow Network Client
 *
 * WebSocket connection to ClearNode with message handling.
 * Singleton client for the daemon process.
 */
import WebSocket from 'ws';
import { getConfig } from '../config.js';

/**
 * Message handler callback type
 */
export type MessageHandler = (message: unknown) => void;

/**
 * Yellow client state
 */
export interface YellowClientState {
    connected: boolean;
    authenticated: boolean;
    jwtToken?: string;
}

/**
 * Yellow Network WebSocket client
 */
class YellowClient {
    private ws: WebSocket | null = null;
    private messageHandlers: Map<string, MessageHandler> = new Map();
    private pendingPromises: Map<string, {
        resolve: (value: unknown) => void;
        reject: (reason: unknown) => void;
    }> = new Map();
    private state: YellowClientState = {
        connected: false,
        authenticated: false,
    };

    /**
     * Gets current client state
     *
     * @returns Current connection and auth state
     */
    getState(): YellowClientState {
        return { ...this.state };
    }

    /**
     * Connects to ClearNode WebSocket
     *
     * @returns Promise that resolves when connected
     */
    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const config = getConfig();

            console.log(`Connecting to Yellow Network: ${config.yellowWsUrl}`);

            this.ws = new WebSocket(config.yellowWsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connection established');
                this.state.connected = true;
                resolve();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data.toString());
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            };

            this.ws.onclose = (event) => {
                console.log(`WebSocket closed: ${event.code} ${event.reason}`);
                this.state.connected = false;
                this.state.authenticated = false;
            };
        });
    }

    /**
     * Sends a message to ClearNode
     *
     * @param message - Message string to send
     */
    send(message: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        this.ws.send(message);
    }

    /**
     * Sends a message and waits for a response with matching ID
     *
     * @param message - Message string to send
     * @param requestId - Request ID to match response
     * @param timeoutMs - Timeout in milliseconds
     * @returns Promise resolving to response
     */
    sendAndWait(message: string, requestId: string, timeoutMs = 30000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingPromises.delete(requestId);
                reject(new Error(`Request ${requestId} timed out`));
            }, timeoutMs);

            this.pendingPromises.set(requestId, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    this.pendingPromises.delete(requestId);
                    resolve(value);
                },
                reject: (reason) => {
                    clearTimeout(timeout);
                    this.pendingPromises.delete(requestId);
                    reject(reason);
                },
            });

            this.send(message);
        });
    }

    /**
     * Registers a message handler for a specific method
     *
     * @param method - RPC method name
     * @param handler - Handler function
     */
    on(method: string, handler: MessageHandler): void {
        this.messageHandlers.set(method, handler);
    }

    /**
     * Sets authentication state
     *
     * @param authenticated - Whether authenticated
     * @param jwtToken - JWT token for reconnection
     */
    setAuthenticated(authenticated: boolean, jwtToken?: string): void {
        this.state.authenticated = authenticated;
        this.state.jwtToken = jwtToken;
    }

    /**
     * Disconnects from ClearNode
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.state.connected = false;
        this.state.authenticated = false;
    }

    /**
     * Handles incoming WebSocket messages
     *
     * @param data - Raw message data
     */
    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);
            console.log('Received:', JSON.stringify(message, null, 2));

            // Check for pending promise resolution
            if (message.id && this.pendingPromises.has(message.id)) {
                const pending = this.pendingPromises.get(message.id);
                if (pending) {
                    pending.resolve(message);
                }
                return;
            }

            // Route to method handler
            const method = message.method || message.res?.[1];
            if (method && this.messageHandlers.has(method)) {
                const handler = this.messageHandlers.get(method);
                if (handler) {
                    handler(message);
                }
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }
}

// Singleton instance
let clientInstance: YellowClient | null = null;

/**
 * Gets the singleton Yellow client instance
 *
 * @returns Yellow client instance
 */
export function getYellowClient(): YellowClient {
    if (!clientInstance) {
        clientInstance = new YellowClient();
    }
    return clientInstance;
}
