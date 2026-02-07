import { config } from 'dotenv';
import WebSocket from 'ws';
import {
    createWalletClient,
    http,
    zeroAddress,
    parseUnits
} from 'viem';
import type { Address, Hex, WalletClient } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
    createAppSessionMessage,
    createCloseAppSessionMessage,
    createECDSAMessageSigner,
    createEIP712AuthMessageSigner,
    createSubmitAppStateMessage,
    createAuthRequestMessage,
    createAuthVerifyMessageFromChallenge,
    createPingMessage,
    createGetConfigMessage,
    createGetAssetsMessage,
    RPCProtocolVersion
} from '@erc7824/nitrolite';
import type { RPCAppDefinition, RPCAppSessionAllocation } from '@erc7824/nitrolite';

config();

const USE_YELLOW = process.env.USE_YELLOW === 'true';
const YELLOW_WS_URL = process.env.YELLOW_WS_URL;
const MAKER_KEY = process.env.MM_PRIVATE_KEY;
const TAKER_KEY = generatePrivateKey();

if (!USE_YELLOW || !YELLOW_WS_URL || !MAKER_KEY) {
    console.error("❌ Missing required .env variables");
    process.exit(1);
}

const makerAccount = privateKeyToAccount(MAKER_KEY as `0x${string}`);
const takerAccount = privateKeyToAccount(TAKER_KEY);

const makerWallet = createWalletClient({
    account: makerAccount,
    chain: sepolia,
    transport: http()
});

const takerWallet = createWalletClient({
    account: takerAccount,
    chain: sepolia,
    transport: http()
});

class SimpleYellowClient {
    private ws: WebSocket;
    private url: string;
    private listeners: ((msg: any) => void)[] = [];
    private pendingRequests = new Map<number, (response: any) => void>();

    constructor(url: string) {
        this.url = url;
        this.ws = new WebSocket(url);
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws.on('open', () => {
                console.log(`Connected to ${this.url}`);
                resolve();
            });
            this.ws.on('error', (err) => {
                console.error(`Connection error: ${err}`);
                reject(err);
            });
            this.ws.on('message', (data) => {
                const raw = data.toString();
                const msg = JSON.parse(raw);

                let id: number | undefined;
                if (msg.res && Array.isArray(msg.res)) {
                    id = msg.res[0];
                } else if (msg.req && Array.isArray(msg.req)) {
                    id = msg.req[0];
                } else {
                    id = msg.id;
                }

                if (id !== undefined && this.pendingRequests.has(id)) {
                    if (msg.res) {
                        this.pendingRequests.get(id)!(msg);
                        this.pendingRequests.delete(id);
                    }
                }

                if (msg.req && Array.isArray(msg.req)) {
                    const method = msg.req[1];
                    const params = msg.req[2];
                    this.emit('notification', { method, params, fullMsg: msg });
                }
            });
        });
    }

    async sendMessage(jsonString: string, explicitId?: number): Promise<any> {
        return new Promise((resolve, reject) => {
            const msg = JSON.parse(jsonString);

            let id = explicitId;
            if (id === undefined && msg.req && Array.isArray(msg.req)) {
                id = msg.req[0];
            }
            if (id === undefined) id = msg.id;

            if (id !== undefined) {
                this.pendingRequests.set(id, resolve);
            }

            this.ws.send(jsonString, (err) => {
                if (err) reject(err);
                if (id === undefined) resolve(null);
            });
        });
    }

    on(event: string, listener: (msg: any) => void) {
        if (event === 'notification') {
            this.listeners.push(listener);
        }
    }

    off(event: string, listener: (msg: any) => void) {
        if (event === 'notification') {
            this.listeners = this.listeners.filter(l => l !== listener);
        }
    }

    private emit(event: string, msg: any) {
        if (event === 'notification') {
            this.listeners.forEach(l => l(msg));
        }
    }

    close() {
        this.ws.close();
    }
}

async function authenticate(client: SimpleYellowClient, initialReqId: number, walletClient: WalletClient, account: any, targetAsset: string): Promise<any> {
    const sessionKey = generatePrivateKey();
    const sessionAccount = privateKeyToAccount(sessionKey);

    console.log(`Authenticating Wallet ${account.address} with Session Key ${sessionAccount.address}`);

    const APPLICATION_NAME = 'Test app';
    const SCOPE = 'test.app';

    // Set allowance for the specific targetAsset
    const authParams = {
        address: account.address,
        session_key: sessionAccount.address,
        application: APPLICATION_NAME,
        allowances: [{
            asset: targetAsset,
            amount: '1000000000000000000000' // High amount
        }],
        expires_at: BigInt(Math.floor(Date.now() / 1000) + 3600),
        scope: SCOPE
    };

    const authReqMsg = await createAuthRequestMessage(authParams as any, initialReqId);
    const authResponse = await client.sendMessage(authReqMsg, initialReqId);

    let challenge: string | undefined;

    if (authResponse && authResponse.res && Array.isArray(authResponse.res)) {
        if (authResponse.res[1] === 'auth_challenge') {
            challenge = authResponse.res[2].challenge_message;
        } else if (authResponse.res[2] && authResponse.res[2].error) {
            console.error("Auth Request Error:", authResponse.res[2]);
            throw new Error(JSON.stringify(authResponse.res[2]));
        }
    }

    if (!challenge) {
        console.error("Did not receive auth_challenge", JSON.stringify(authResponse));
        throw new Error("Auth Failure");
    }

    console.log(`Received Auth Challenge. Signing with EIP-712...`);

    const partialAuthMsg = {
        scope: authParams.scope,
        session_key: authParams.session_key,
        expires_at: authParams.expires_at,
        allowances: authParams.allowances
    };

    const domain = { name: APPLICATION_NAME };
    console.log(`Using EIP-712 Domain: ${JSON.stringify(domain)}`);

    const authSigner = createEIP712AuthMessageSigner(walletClient, partialAuthMsg, domain);
    const verifyReqId = initialReqId + 1;
    const verifyMsg = await createAuthVerifyMessageFromChallenge(authSigner, challenge, verifyReqId);

    console.log(`Sending Auth Verify...`);
    const verifyResponse = await client.sendMessage(verifyMsg, verifyReqId);

    if (verifyResponse && verifyResponse.error) {
        console.error("Auth Verify Failed:", verifyResponse.error);
        throw verifyResponse.error;
    } else if (verifyResponse && verifyResponse.res) {
        if (verifyResponse.res[1] === 'error' || (verifyResponse.res[2] && verifyResponse.res[2].error)) {
            console.error("Auth Verify Error Response:", verifyResponse.res);
            throw new Error("Auth Verify Failed");
        }
        console.log(`✅ Authenticated ${account.address} with Session Key ${sessionAccount.address}`);
    } else {
        console.log(`✅ Authenticated ${account.address}`);
    }

    return createECDSAMessageSigner(sessionKey);
}

async function main() {
    console.log("🟡 Starting Yellow Network Direct Interaction Test");

    console.log(`Connecting Maker (${makerAccount.address}) to ${YELLOW_WS_URL}...`);
    const makerYellow = new SimpleYellowClient(YELLOW_WS_URL!);
    await makerYellow.connect();

    console.log(`Connecting Taker (${takerAccount.address}) to ${YELLOW_WS_URL}...`);
    const takerYellow = new SimpleYellowClient(YELLOW_WS_URL!);
    await takerYellow.connect();

    const pingId = 999;
    const tempSigner = createECDSAMessageSigner(MAKER_KEY as `0x${string}`);
    const pingMsg = await createPingMessage(tempSigner, pingId);
    await makerYellow.sendMessage(pingMsg, pingId);
    console.log("Ping OK");

    // --- Get Config & Assets ---
    console.log("Fetching Supported Assets...");
    const assetsId = 901;
    const assetsMsg = await createGetAssetsMessage(tempSigner, undefined, assetsId);
    const assetsRes = await makerYellow.sendMessage(assetsMsg, assetsId);
    // console.log("Assets:", JSON.stringify(assetsRes, null, 2));

    let targetAsset = 'ytest.usd'; // Default fallback

    if (assetsRes && assetsRes.res && Array.isArray(assetsRes.res[2])) {
        const assets = assetsRes.res[2];
        if (assets.length > 0) {
            const found = assets.find((a: any) => a.symbol === 'ytest.usd' || a.symbol === 'usdc');
            if (found) {
                targetAsset = found.address || found.symbol;
                console.log(`Selected Asset: ${found.symbol} (${targetAsset})`);
            } else {
                const first = assets[0];
                targetAsset = first.address || first.symbol;
                console.log(`Selected First Available Asset: ${first.symbol} (${targetAsset})`);
            }
        }
    }
    console.log(`Using Target Asset for Allocations: ${targetAsset}`);

    // --- Authenticate Both & Get Session Signers ---
    console.log("Authenticating...");

    const [makerSessionSigner, takerSessionSigner] = await Promise.all([
        authenticate(makerYellow, 1, makerWallet, makerAccount, targetAsset),
        authenticate(takerYellow, 10, takerWallet, takerAccount, targetAsset)
    ]);

    console.log("Creating Session...");

    const appDefinition: RPCAppDefinition = {
        protocol: RPCProtocolVersion.NitroRPC_0_4,
        participants: [makerAccount.address, takerAccount.address],
        weights: [50, 50],
        quorum: 100,
        challenge: 0,
        nonce: Date.now(),
        application: 'Test app',
    };

    const initialAllocations: RPCAppSessionAllocation[] = [
        { participant: makerAccount.address, asset: targetAsset, amount: '1000' },
        { participant: takerAccount.address, asset: targetAsset, amount: '0' },
    ];

    const createReqId = 100;
    const createMsg = await createAppSessionMessage(makerSessionSigner, {
        definition: appDefinition as any,
        allocations: initialAllocations as any
    }, createReqId);

    const sessionResponse = await makerYellow.sendMessage(createMsg, createReqId);

    let sessionId: string | undefined;

    if (sessionResponse && sessionResponse.res && Array.isArray(sessionResponse.res)) {
        const resultObj = sessionResponse.res[2];
        if (typeof resultObj === 'object' && resultObj !== null) {
            if ('app_session' in resultObj) {
                sessionId = (resultObj as any).app_session.app_session_id;
            } else {
                sessionId = (resultObj as any).app_session_id || (resultObj as any).id;
                if (!sessionId && 'error' in resultObj) {
                    console.error("Session Create Error:", resultObj);
                    process.exit(1);
                }
            }
        } else if (sessionResponse.res[1] === 'error') {
            console.error("Session Create Error:", sessionResponse.res);
            process.exit(1);
        }
    }

    if (!sessionId) {
        console.error("❌ Session ID missing in response:", JSON.stringify(sessionResponse, null, 2));
        process.exit(1);
    }

    console.log(`✅ Session Created! ID: ${sessionId}`);

    takerYellow.on('notification', (msg: any) => {
        if (msg.method === 'asu') {
            console.log("🔔 Taker received ASU. Status:", msg.params?.app_session?.status);
        }
    });

    console.log("Maker creating close request...");

    const finalAllocations: RPCAppSessionAllocation[] = [
        { participant: makerAccount.address, asset: targetAsset, amount: '0' },
        { participant: takerAccount.address, asset: targetAsset, amount: '1000' },
    ];

    const closeReqId = 200;
    const closeMsgUnsigned = await createCloseAppSessionMessage(makerSessionSigner, {
        app_session_id: sessionId as Hex,
        allocations: finalAllocations as any
    }, closeReqId);

    console.log("Taker co-signing...");

    const closeMsgJson = JSON.parse(closeMsgUnsigned);
    const takerSig = await takerSessionSigner(closeMsgJson.req);
    closeMsgJson.sig.push(takerSig);

    console.log("Submitting fully signed close request...");
    const closeResponse = await makerYellow.sendMessage(JSON.stringify(closeMsgJson), closeReqId);

    if (closeResponse && closeResponse.res && Array.isArray(closeResponse.res)) {
        const closeResult = closeResponse.res[2];
        console.log("✅ Session Closed!", JSON.stringify(closeResult, null, 2));
    } else {
        console.error("❌ Close failed:", JSON.stringify(closeResponse, null, 2));
    }

    await new Promise(r => setTimeout(r, 2000));
    makerYellow.close();
    takerYellow.close();
    process.exit(0);
}

main().catch(console.error);
