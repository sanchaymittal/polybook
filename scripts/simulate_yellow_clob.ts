import { config } from 'dotenv';
import WebSocket from 'ws';
import {
    createWalletClient,
    http,
} from 'viem';
import type { Address, WalletClient } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
    createAppSessionMessage,
    createECDSAMessageSigner,
    createEIP712AuthMessageSigner,
    createAuthRequestMessage,
    createAuthVerifyMessageFromChallenge,
    RPCProtocolVersion
} from '@erc7824/nitrolite';
import type { RPCAppDefinition, RPCAppSessionAllocation } from '@erc7824/nitrolite';

config();

const YELLOW_WS_URL = 'wss://clearnet-sandbox.yellow.com/ws';
// Using a fixed identity for the Simulator/Orchestrator to allow faucet funding
const SIMULATOR_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff81' as `0x${string}`;
// Simulator Address: 0xdD11751cdD3f6EFf01B1f6151B640685bfa5dB4a

const MAKER_ADDRESS = '0xf87faCA915DE5A59379c65Bf2f5cc1727E7D54fC' as Address;
const TAKER_ADDRESS = '0xa8d93Ad5Df49FA95ccE48261932b08eC3708DaF5' as Address;
const TARGET_ASSET_ADDRESS = 'ytest.usd' as Address;

const clobAccount = privateKeyToAccount(SIMULATOR_PRIVATE_KEY);
const clobWallet = createWalletClient({
    account: clobAccount,
    chain: sepolia,
    transport: http()
});

class SimpleYellowClient {
    private ws: WebSocket;
    private pendingRequests = new Map<number, (response: any) => void>();

    constructor(url: string) {
        this.ws = new WebSocket(url);
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws.on('open', () => {
                console.log(`✅ Connected to Yellow Network`);
                resolve();
            });
            this.ws.on('error', reject);
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                const id = msg.res?.[0] || msg.id;
                if (id !== undefined && this.pendingRequests.has(id)) {
                    this.pendingRequests.get(id)!(msg);
                    this.pendingRequests.delete(id);
                }
            });
        });
    }

    async send_request(method: string, params: any): Promise<any> {
        const id = Math.floor(Math.random() * 1000000);
        const timestamp = Date.now();
        const msg = {
            req: [id, method, params, timestamp, "NitroRPC/0.4"]
        };
        return this.sendMessage(msg, id);
    }

    sendMessage(msg: any, id: number): Promise<any> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Timeout waiting for id ${id}`)), 15000);
            this.pendingRequests.set(id, (res) => {
                clearTimeout(timeout);
                resolve(res);
            });
            this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
        });
    }
}

async function authenticate(client: SimpleYellowClient, initialReqId: number, walletClient: WalletClient, account: any, targetAsset: string): Promise<any> {
    const sessionKey = generatePrivateKey();
    const sessionAccount = privateKeyToAccount(sessionKey);

    console.log(`Authenticating CLOB Simulator ${account.address} with Session Key ${sessionAccount.address}`);

    const APPLICATION_NAME = 'Polybook CLOB';
    const SCOPE = 'polybook.clob';

    const authParams = {
        address: account.address,
        session_key: sessionAccount.address,
        application: APPLICATION_NAME,
        allowances: [{
            asset: targetAsset,
            amount: '1000000000000000000000'
        }],
        expires_at: BigInt(Math.floor(Date.now() / 1000) + 3600),
        scope: SCOPE
    };

    // Note: nitrolite SDK might take signer as first arg or authParams depending on version
    // Following the pattern provided by the user
    const authReqMsg = await createAuthRequestMessage(authParams as any, initialReqId);
    console.log("DEBUG: Valid Auth Request Message:", JSON.stringify(authReqMsg, null, 2));
    const authResponse = await client.sendMessage(authReqMsg, initialReqId);

    if (!authResponse?.res?.[2]?.challenge_message) {
        throw new Error(`Auth Failure: ${JSON.stringify(authResponse)}`);
    }

    const challenge = authResponse.res[2].challenge_message;
    console.log(`Received Auth Challenge. Signing with EIP-712...`);


    const partialAuthMsg = {
        scope: authParams.scope,
        session_key: authParams.session_key,
        expires_at: authParams.expires_at,
        allowances: authParams.allowances
    };

    console.log("DEBUG Policy Values (partial, before adding challenge/wallet):");
    console.log("  scope:", authParams.scope);
    console.log("  session_key:", authParams.session_key);
    console.log("  expires_at:", authParams.expires_at.toString());
    console.log("  allowances:", JSON.stringify(authParams.allowances));
    console.log("  wallet (will be added):", account.address);
    console.log("  challenge (will be added):", challenge);

    const authSigner = createEIP712AuthMessageSigner(walletClient as any, partialAuthMsg as any, { name: APPLICATION_NAME });
    const verifyReqId = initialReqId + 1;
    const verifyMsg = await createAuthVerifyMessageFromChallenge(authSigner, challenge, verifyReqId);
    console.log("DEBUG: Valid Verify Message:", JSON.stringify(verifyMsg, null, 2));

    console.log(`Sending Auth Verify...`);
    const verifyResponse = await client.sendMessage(verifyMsg, verifyReqId);

    if (verifyResponse?.res?.[1] === 'error' || verifyResponse?.res?.[2]?.error) {
        throw new Error(`Auth Verify Failed: ${JSON.stringify(verifyResponse)}`);
    }

    console.log(`✅ CLOB Simulator Authenticated`);
    return createECDSAMessageSigner(sessionKey);
}

async function main() {
    const client = new SimpleYellowClient(YELLOW_WS_URL);
    await client.connect();

    console.log("Starting Authentication...");
    const sessionSigner = await authenticate(client, 100, clobWallet, clobAccount, TARGET_ASSET_ADDRESS);

    const SIMULATOR_ADDRESS = clobAccount.address;

    console.log("\n--- SIMULATING ORDER MATCH ---");
    const sessionParams = {
        definition: {
            protocol: "NitroRPC/0.4",
            application: "Polybook CLOB",
            participants: [MAKER_ADDRESS, TAKER_ADDRESS, SIMULATOR_ADDRESS],
            weights: [50, 50, 100],
            quorum: 100,
            challenge: 60,
            nonce: Math.floor(Math.random() * 1000000),
        },
        allocations: [
            { participant: MAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
            { participant: TAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
            { participant: SIMULATOR_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
        ],
        session_data: JSON.stringify({
            initial_allocation: [
                { participant: MAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '1' },
                { participant: TAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
            ],
            final_allocation: [
                { participant: MAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
                { participant: TAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '1' },
            ]
        }),
    };
    console.log("Sending create_app_session request:", JSON.stringify(sessionParams, null, 2));

    const id = Math.floor(Math.random() * 1000000);
    const timestamp = Date.now();
    const payload = [id, 'create_app_session', sessionParams, timestamp];
    const createMsg = {
        req: payload,
        sig: [await sessionSigner(payload as any)]
    };

    const sessionResponse = await client.sendMessage(createMsg, id);
    console.log("Session Response:", JSON.stringify(sessionResponse, null, 2));

    if (sessionResponse.res?.[2]?.app_session_id) {
        const sessionId = sessionResponse.res[2].app_session_id;
        console.log(`🚀 SUCCESS: Session Created: ${sessionId}`);

        console.log("Waiting 1s before submitting state to trigger asu notification...");
        await new Promise(resolve => setTimeout(resolve, 1000));

        const closeParams = {
            app_session_id: sessionId,
            allocations: [
                { participant: MAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
                { participant: TAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
                { participant: SIMULATOR_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
            ],
            session_data: JSON.stringify({
                initial_allocation: [
                    { participant: MAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '1' },
                    { participant: TAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
                ],
                final_allocation: [
                    { participant: MAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '0' },
                    { participant: TAKER_ADDRESS, asset: TARGET_ASSET_ADDRESS, amount: '1' },
                ]
            }),
        };

        console.log("Triggering submit_app_state (Version 2) to trigger initial asu notification...");
        const submitParams = {
            app_session_id: sessionId,
            version: 2,
            intent: 'operate',
            allocations: closeParams.allocations,
            session_data: closeParams.session_data,
        };

        const submitId = Math.floor(Math.random() * 1000000);
        const submitPayload = [submitId, 'submit_app_state', submitParams, Date.now()];
        const submitMsg = {
            req: submitPayload,
            sig: [await sessionSigner(submitPayload as any)]
        };

        const submitResponse = await client.sendMessage(submitMsg, submitId);
        console.log("Submit State Response:", JSON.stringify(submitResponse, null, 2));

        console.log("Waiting 1s before closing session...");
        await new Promise(resolve => setTimeout(resolve, 1000));

        const closeId = Math.floor(Math.random() * 1000000);
        const closePayload = [closeId, 'close_app_session', closeParams, Date.now()];
        const closeMsg = {
            req: closePayload,
            sig: [await sessionSigner(closePayload as any)]
        };

        const closeResponse = await client.sendMessage(closeMsg, closeId);
        console.log("Close Session Response:", JSON.stringify(closeResponse, null, 2));

    } else {
        console.error("❌ Failed:", JSON.stringify(sessionResponse, null, 2));
    }

    console.log("Waiting for 1s for notifications...");
    await new Promise(r => setTimeout(r, 1000));
}

main().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
