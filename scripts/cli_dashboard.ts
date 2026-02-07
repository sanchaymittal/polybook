import axios from 'axios';
import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { createPublicClient, http, parseAbi, getAddress, defineChain, parseAbiItem, keccak256, encodePacked } from 'viem';

const CLOB_API_URL = process.env.CLOB_API_URL || (() => { throw new Error("CLOB_API_URL not set") })();
const RPC_URL = process.env.RPC_URL || (() => { throw new Error("RPC_URL not set") })();
const CHAIN_ID = parseInt(process.env.CHAIN_ID || (() => { throw new Error("CHAIN_ID not set") })());
const ADAPTER_ADDRESS = getAddress(process.env.ADAPTER_ADDRESS || (() => { throw new Error("ADAPTER_ADDRESS not set") })());
const CTF_ADDRESS = getAddress(process.env.CTF_ADDRESS || (() => { throw new Error("CTF_ADDRESS not set") })());
const USDC_ADDRESS = getAddress(process.env.USDC_ADDRESS || (() => { throw new Error("USDC_ADDRESS not set") })());

const ARC_TESTNET = defineChain({
    id: CHAIN_ID,
    name: 'Arc Testnet',
    network: 'arc-testnet',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: {
        default: { http: [RPC_URL] },
        public: { http: [RPC_URL] },
    },
});

const ADAPTER_ABI = parseAbi([
    "function questions(bytes32 id) external view returns (bytes32 assetId, uint8 marketType, int256 referencePrice, uint256 expiration, bool resolved, bytes32 questionID, address creator)",
    "function initialize(bytes32 assetId, uint8 marketType, int256 strikePrice, uint256 expiration, string memory description, bytes calldata storkData) external payable",
    "function resolve(bytes32 questionID, bytes calldata storkData) external payable",
    "event QuestionInitialized(bytes32 indexed questionID, bytes32 assetId, uint8 marketType, int256 strikePrice, uint256 expiration)"
]);

const CTF_ABI = parseAbi([
    "function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256)",
    "function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256)"
]);

const publicClient = createPublicClient({
    chain: ARC_TESTNET,
    transport: http()
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const clearScreen = () => {
    console.clear();
};

const waitForKey = () => {
    return new Promise<void>(resolve => {
        rl.question('\nPress Enter to continue...', () => {
            resolve();
        });
    });
};

async function getMarkets(status: string) {
    try {
        const res = await axios.get(`${CLOB_API_URL}/markets?status=${status}`);
        return res.data.markets;
    } catch (e: any) {
        return [];
    }
}

async function getOrderbook(tokenId: string) {
    try {
        const res = await axios.get(`${CLOB_API_URL}/orderbook/${tokenId}`);
        return res.data;
    } catch (e: any) {
        return { bids: [], asks: [] };
    }
}

const showMarketList = async (status: string) => {
    console.log(`\n🔍 Fetching Markets from Chain Events & CLOB Registry...`);

    // 1. Get markets from CLOB (for metadata like slug/description)
    const clobMarkets = await getMarkets("ACTIVE");
    const resolvedClob = await getMarkets("RESOLVED");
    const allClob = [...clobMarkets, ...resolvedClob];

    // 2. Load from Local Registry (Lifecycle Manager's memory)
    let registryMarkets: any[] = [];
    try {
        const registryPath = path.join(process.cwd(), 'lifecycle-manager/registry.json');
        if (fs.existsSync(registryPath)) {
            registryMarkets = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        }
    } catch (e) { /* ignore */ }

    // 3. Discover recent markets from Chain Events
    let eventQuestionIds: `0x${string}`[] = [];
    try {
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock - 10000n; // Last ~10k blocks (fast)
        const logs = await publicClient.getLogs({
            address: ADAPTER_ADDRESS,
            event: parseAbiItem("event QuestionInitialized(bytes32 indexed questionID, bytes32 assetId, uint8 marketType, int256 strikePrice, uint256 expiration)"),
            fromBlock: fromBlock > 0n ? fromBlock : 0n
        });
        eventQuestionIds = logs.map(l => (l as any).args.questionID);

        // Map questionID -> transactionHash for deep decoding
        const qidToTx: Record<string, string> = {};
        logs.forEach(l => {
            if ((l as any).args.questionID) {
                qidToTx[(l as any).args.questionID.toLowerCase()] = l.transactionHash!;
            }
        });
        (showMarketList as any).qidToTx = qidToTx;
    } catch (e: any) {
        // Fallback to registry/CLOB only
    }

    const allKnownMarkets = [...clobMarkets, ...resolvedClob, ...registryMarkets];
    const allUniqueQuestionIds = Array.from(new Set([
        ...allKnownMarkets.map(m => m.question_id),
        ...eventQuestionIds
    ]));

    console.log(`✅ Discovered ${allUniqueQuestionIds.length} unique market(s) total.`);

    console.log(`\n=== ALL MARKETS (VERIFYING ON-CHAIN...) ===`);
    if (allUniqueQuestionIds.length === 0) {
        console.log("No markets found.");
    } else {
        const tableData = await Promise.all(allUniqueQuestionIds.map(async (qid: any, index) => {
            let onChainStatus = "Unknown";
            let onChainOutcome = "Pending";
            let questionText = "Unknown On-Chain Market";

            const match = allKnownMarkets.find(m => m.question_id.toLowerCase() === qid.toLowerCase());

            try {
                const qData = await publicClient.readContract({
                    address: ADAPTER_ADDRESS,
                    abi: ADAPTER_ABI,
                    functionName: 'questions',
                    args: [qid]
                }) as any;

                const marketType = qData[1];
                const referencePrice = qData[2];
                const expiry = qData[3];
                const resolved = qData[4];

                onChainStatus = resolved ? "RESOLVED" : (Number(expiry) < Math.floor(Date.now() / 1000) ? "EXPIRED" : "ACTIVE");

                if (match) {
                    questionText = match.question;
                } else {
                    // DEEP DECODING: Try to find description in transaction calldata
                    const txHash = (showMarketList as any).qidToTx?.[qid.toLowerCase()];
                    if (txHash) {
                        try {
                            const tx = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
                            const decoded = (publicClient as any).decodeFunctionData({
                                abi: ADAPTER_ABI,
                                data: tx.input
                            });
                            if (decoded.functionName === 'initialize') {
                                questionText = decoded.args[4] as string;
                                // Add to known markets to cache it
                                (allKnownMarkets as any).push({ question_id: qid, question: questionText });
                            }
                        } catch (e) {
                            // Fallback to derived text
                            const priceFormatted = Number(referencePrice) / 10 ** 18;
                            if (marketType === 0) { // PRICE_ABOVE_STRIKE
                                questionText = `BTC Above $${priceFormatted}`;
                            } else { // PRICE_RANGE_UP_DOWN
                                questionText = `BTC UP/DOWN (Ref: $${priceFormatted})`;
                            }
                        }
                    } else {
                        // Derive question text from market type
                        const priceFormatted = Number(referencePrice) / 10 ** 18;
                        if (marketType === 0) { // PRICE_ABOVE_STRIKE
                            questionText = `BTC Above $${priceFormatted}`;
                        } else { // PRICE_RANGE_UP_DOWN
                            questionText = `BTC UP/DOWN (Ref: $${priceFormatted})`;
                        }
                    }
                }

                if (resolved) {
                    const conditionID = keccak256(encodePacked(['address', 'bytes32', 'uint256'], [ADAPTER_ADDRESS, qid, 2n]));
                    const payoutNo = await publicClient.readContract({
                        address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'payoutNumerators',
                        args: [conditionID, 0n]
                    }) as bigint;
                    if (payoutNo === 0n) {
                        const payoutYes = await publicClient.readContract({
                            address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'payoutNumerators',
                            args: [conditionID, 1n]
                        }) as bigint;
                        if (payoutYes > 0n) onChainOutcome = (marketType === 1) ? "UP" : "YES";
                    } else {
                        onChainOutcome = (marketType === 1) ? "DOWN" : "NO";
                    }
                }
            } catch (e) {
                onChainStatus = "Query Fail";
            }

            if (status === "RESOLVED" && onChainStatus !== "RESOLVED") return null;
            if (status === "ACTIVE" && onChainStatus === "RESOLVED") return null;

            return {
                Idx: index,
                ID: qid.substring(0, 10) + '...',
                Question: (questionText.length > 50) ? questionText.substring(0, 47) + '...' : questionText,
                'Chain Status': onChainStatus,
                'Outcome': onChainOutcome,
                'Source': match ? (clobMarkets.find(m => m.question_id === qid) ? "CLOB" : "Reg") : "Chain",
                // Internal metadata (not shown in table but returned)
                market_id: match ? (match.market_id || match.slug || qid) : qid,
                question: questionText || (match ? (match.question || match.slug) : "Unknown"),
                yes_token_id: match ? match.yes_token_id : "",
                no_token_id: match ? match.no_token_id : ""
            };
        }));

        const filtered = tableData.filter(d => d !== null) as any[];
        if (filtered.length === 0) {
            console.log(`No ${status} markets found.`);
        } else {
            // Display a cleaned up table (hide internal fields)
            console.table(filtered.map(({ Idx, ID, Question, 'Chain Status': s, 'Outcome': o, Source }) => ({ Idx, ID, Question, 'Chain Status': s, 'Outcome': o, Source })));
        }
        return filtered;
    }
    return [];
};

async function viewOrderbook(market: any) {
    clearScreen();
    console.log(`\n=== ORDERBOOK: ${market.question} (${market.market_id}) ===`);

    const [yesBook, noBook] = await Promise.all([
        getOrderbook(market.yes_token_id),
        getOrderbook(market.no_token_id)
    ]);

    console.log("\n--- YES TOKEN ---");
    if (yesBook.bids.length === 0 && yesBook.asks.length === 0) {
        console.log("(Empty)");
    } else {
        const bids = yesBook.bids.map((b: any) => ({ Type: 'BID', Price: b.price, Qty: b.quantity, Count: b.order_count }));
        const asks = yesBook.asks.map((a: any) => ({ Type: 'ASK', Price: a.price, Qty: a.quantity, Count: a.order_count }));
        console.table([...asks, ...bids]);
    }

    console.log("\n--- NO TOKEN ---");
    if (noBook.bids.length === 0 && noBook.asks.length === 0) {
        console.log("(Empty)");
    } else {
        const bids = noBook.bids.map((b: any) => ({ Type: 'BID', Price: b.price, Qty: b.quantity, Count: b.order_count }));
        const asks = noBook.asks.map((a: any) => ({ Type: 'ASK', Price: a.price, Qty: a.quantity, Count: a.order_count }));
        console.table([...asks, ...bids]);
    }

    await waitForKey();
}

async function mainLoop() {
    while (true) {
        clearScreen();
        console.log("=== POLYBOOK CONSOLE DASHBOARD ===");
        console.log("1. List Active Markets");
        console.log("2. List Resolved Markets");
        console.log("3. Exit");

        const choice = await new Promise<string>(resolve => {
            rl.question('\nSelect Option: ', resolve);
        });

        if (choice === '3') break;

        if (choice === '1' || choice === '2') {
            const status = choice === '1' ? 'ACTIVE' : 'RESOLVED';
            const markets = await showMarketList(status);

            if (markets.length > 0) {
                const mkInput = await new Promise<string>(resolve => {
                    rl.question('\nEnter Index or Market ID to view Orderbook (or Enter to go back): ', resolve);
                });

                const input = mkInput.trim();
                if (input !== "") {
                    const idx = parseInt(input);
                    let selected = (idx >= 0 && idx < markets.length) ? markets[idx] : null;

                    if (!selected) {
                        selected = markets.find((m: any) => m.market_id === input);
                    }

                    if (selected) {
                        await viewOrderbook(selected);
                    } else {
                        console.log("Invalid Index or Market ID");
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            } else {
                await waitForKey();
            }
        }
    }
    rl.close();
    process.exit(0);
}

mainLoop();
