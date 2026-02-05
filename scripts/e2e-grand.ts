
import axios from 'axios';
import { createWalletClient, http, parseUnits, keccak256, encodePacked, getContract, publicActions, walletActions, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY_URL = 'http://127.0.0.1:3402';
const CLOB_URL = 'http://127.0.0.1:3030';
const RPC_URL = 'http://127.0.0.1:8545';

// Addresses (Fixed for Anvil/PolyBook Setup)
const CTF_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const USDC_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const EXCHANGE_ADDR = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';

// ------------------------------------------------------------------
// Inlined ClobClient (to avoid ts-node import issues)
// ------------------------------------------------------------------

const TYPES = {
    Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
    ],
} as const;

class ClobClient {
    static getEnv() {
        return {
            CLOB_URL: 'http://127.0.0.1:3030',
            EXCHANGE_ADDR: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as `0x${string}`
        };
    }

    static getDomain() {
        const { EXCHANGE_ADDR } = this.getEnv();
        return {
            name: "Polymarket CTF Exchange",
            version: "1",
            chainId: 31337,
            verifyingContract: EXCHANGE_ADDR,
        } as const;
    }

    static async placeOrder(
        privateKey: `0x${string}`,
        market: any,
        side: 'BUY' | 'SELL',
        price: number,
        quantity: number
    ) {
        const { CLOB_URL } = this.getEnv();
        const account = privateKeyToAccount(privateKey);
        const maker = account.address;

        const priceBn = parseUnits(price.toString(), 6);
        const qtyBn = parseUnits(quantity.toString(), 6);

        let makerAmount = 0n;
        let takerAmount = 0n;
        let tokenId = "0";

        if (side === 'BUY') {
            makerAmount = (qtyBn * priceBn) / 1000000n; // USDC
            takerAmount = qtyBn; // Tokens
            tokenId = market.yes_token_id;
        } else {
            makerAmount = qtyBn; // Tokens
            takerAmount = (qtyBn * priceBn) / 1000000n; // USDC
            tokenId = market.yes_token_id;
        }

        const salt = BigInt(Math.floor(Math.random() * 1000000));

        const order = {
            salt,
            maker,
            signer: maker,
            taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
            tokenId: BigInt(tokenId),
            makerAmount,
            takerAmount,
            expiration: 0n,
            nonce: 0n,
            feeRateBps: 0n,
            side: side === 'BUY' ? 0 : 1,
            signatureType: 0,
        };

        const DOMAIN = this.getDomain();

        const signature = await account.signTypedData({
            domain: DOMAIN,
            types: TYPES,
            primaryType: 'Order',
            message: order,
        });

        // Construct API Payload
        const { hashTypedData } = await import('viem');
        const orderHash = await hashTypedData({
            domain: DOMAIN,
            types: TYPES,
            primaryType: 'Order',
            message: order
        });

        const payload = {
            maker,
            token_id: tokenId,
            side,
            price: priceBn.toString(),
            quantity: qtyBn.toString(),
            order_hash: orderHash,
            salt: order.salt.toString(),
            signer: order.signer,
            taker: order.taker,
            maker_amount: order.makerAmount.toString(),
            taker_amount: order.takerAmount.toString(),
            expiration: order.expiration.toString(),
            nonce: order.nonce.toString(),
            fee_rate_bps: order.feeRateBps.toString(),
            signature_type: order.signatureType,
            signature,
        };

        console.log(`[CLOB] Placing Order for ${maker}: ${side} ${quantity} @ ${price}`);
        const res = await axios.post(`${CLOB_URL}/order`, payload);
        return res.data;
    }
}


// ABI Snippets
const CTF_ABI = [
    "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external",
    "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external",
    "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)",
    "function getPositionId(address collateralToken, bytes32 collectionId) external view returns (uint256)",
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
];

const ERC20_ABI = [
    "function mint(address to, uint256 amount) external",
    "function approve(address spender, uint256 amount) external",
    "function balanceOf(address account) external view returns (uint256)",
    "function allowance(address owner, address spender) external view returns (uint256)"
];

async function main() {
    console.log('\n🌟 Starting Grand Unified E2E Test (Chainlink Adapter + PolyBook)...\n');

    // 0. Setup Viem Clients
    const publicClient = createWalletClient({ chain: anvil, transport: http(RPC_URL) }).extend(publicActions);

    // Maker: Account 1
    const makerPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const makerAccount = privateKeyToAccount(makerPk);
    const makerClient = createWalletClient({ account: makerAccount, chain: anvil, transport: http(RPC_URL) }).extend(publicActions).extend(walletActions);

    // Taker: Account 2
    const takerPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
    const takerAccount = privateKeyToAccount(takerPk);
    const takerClient = createWalletClient({ account: takerAccount, chain: anvil, transport: http(RPC_URL) }).extend(publicActions).extend(walletActions);

    console.log(`Maker: ${makerAccount.address}`);
    console.log(`Taker: ${takerAccount.address}`);

    try {
        // ---------------------------------------------------------
        // Step 1: Deploy Adapter & Initialize Market (via Forge Script)
        // ---------------------------------------------------------
        console.log('\nStep 1: Deploying Adapter & Initializing Market...');
        const scriptPath = '/Users/sanchaymittal/github/uma-ctf-adapter/scripts/E2E_Step1_DeployInit.s.sol';
        const cwd = '/Users/sanchaymittal/github/uma-ctf-adapter';

        // Ensure script exists
        if (!fs.existsSync(scriptPath)) throw new Error("Deploy script not found");

        const output = execSync(`forge script scripts/E2E_Step1_DeployInit.s.sol --broadcast --rpc-url ${RPC_URL} -vvvv`, { cwd, encoding: 'utf-8' });

        // Parse Output
        const adapterMatch = output.match(/ChainlinkCtfAdapter: (0x[a-fA-F0-9]{40})/);
        const questionMatch = output.match(/QuestionID:\s+(0x[a-fA-F0-9]{64})/);

        if (!adapterMatch || !questionMatch) {
            console.error(output);
            throw new Error("Failed to parse deployment output");
        }

        const adapterAddr = adapterMatch[1] as `0x${string}`;
        const questionID = questionMatch[1] as `0x${string}`;

        console.log(`✅ Deployed Adapter: ${adapterAddr}`);
        console.log(`✅ Initialized Question: ${questionID}`);

        // ---------------------------------------------------------
        // Step 2: Calculate Condition & Token IDs
        // ---------------------------------------------------------
        console.log('\nStep 2: Calculating IDs...');

        // Condition ID = keccak256(oracle, questionId, outcomeSlotCount)
        const outcomeSlotCount = 2n;
        const conditionID = keccak256(encodePacked(
            ['address', 'bytes32', 'uint256'],
            [adapterAddr, questionID, outcomeSlotCount]
        ));
        console.log(`   Condition ID: ${conditionID}`);

        // Connect to CTF
        const ctf = getContract({ address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), client: publicClient });

        const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

        // Get Collection IDs
        // use 'read' directly from contract instance in newer viem or use publicClient
        // For simplicity using readContract
        const c1 = await publicClient.readContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), functionName: 'getCollectionId',
            args: [parentCollectionId, conditionID, 1n] // Index Set 1 (Binary: 01)
        }) as `0x${string}`;

        const c2 = await publicClient.readContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), functionName: 'getCollectionId',
            args: [parentCollectionId, conditionID, 2n] // Index Set 2 (Binary: 10)
        }) as `0x${string}`;

        // Get Token IDs
        const yesTokenId = await publicClient.readContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), functionName: 'getPositionId',
            args: [USDC_ADDRESS, c1]
        }) as bigint;

        const noTokenId = await publicClient.readContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), functionName: 'getPositionId',
            args: [USDC_ADDRESS, c2]
        }) as bigint;

        console.log(`   YES Token ID: ${yesTokenId}`);
        console.log(`   NO Token ID: ${noTokenId}`);

        // ---------------------------------------------------------
        // Step 3: Import Market into CLOB
        // ---------------------------------------------------------
        console.log('\nStep 3: Importing Market into CLOB...');
        await axios.post(`${CLOB_URL}/admin/import-market`, {
            slug: `btc-chainlink-${Date.now()}`,
            question: "Will BTC > 60k?",
            question_id: questionID,
            condition_id: conditionID,
            yes_token_id: yesTokenId.toString(),
            no_token_id: noTokenId.toString()
        });
        console.log('✅ Market Imported');

        // ---------------------------------------------------------
        // Step 4: Mint & Enable Trading (Maker)
        // Step 4: Maker Setup (Minting & Splitting)...
        // ---------------------------------------------------------
        console.log('\nStep 4: Maker Setup (Minting & Splitting)...');

        // Mint USDC to Maker
        const amount = parseUnits('1000', 6);
        const mintTx = await publicClient.writeContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'mint',
            args: [makerAccount.address, amount], account: makerAccount
        });
        await publicClient.waitForTransactionReceipt({ hash: mintTx });

        // Approve CTF
        const approveTx = await makerClient.writeContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'approve',
            args: [CTF_ADDRESS, amount], account: makerAccount
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });

        // Confirm Code
        const usdcCode = await publicClient.getBytecode({ address: USDC_ADDRESS });
        console.log(`Debug: USDC Code Length: ${usdcCode?.length || 0}`);

        // Confirm Allowance
        const allowance = await publicClient.readContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'allowance',
            args: [makerAccount.address, CTF_ADDRESS]
        }) as bigint;
        console.log(`Debug: Maker Allowance to CTF: ${allowance}`);

        // Confirm Balance
        const balance = await publicClient.readContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'balanceOf',
            args: [makerAccount.address]
        }) as bigint;
        console.log(`Debug: Maker Balance: ${balance}`);

        // Split Position (Mint 1000 YES + 1000 NO)
        // partition: [1, 2] (binary 01 and 10)
        const splitTx = await makerClient.writeContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), functionName: 'splitPosition',
            args: [USDC_ADDRESS, parentCollectionId, conditionID, [1n, 2n], amount], account: makerAccount
        });
        await publicClient.waitForTransactionReceipt({ hash: splitTx });
        console.log('✅ Maker Split Complete (Has YES/NO tokens)');

        // Approve Exchange (CLOB) to spend YES tokens
        // Wait... CTF tokens are ERC1155.
        // We need to verify if CLOB logic uses ERC1155 approval.
        // PolyBook CLOB (Rust) assumes ERC20 usually, but CTF is 1155.
        // The `ICTFExchange` likely calls `safeTransferFrom` on CTF.
        // So we need `setApprovalForAll(exchange, true)` on CTF.
        const CTF_1155_ABI = ["function setApprovalForAll(address operator, bool approved) external"];
        await makerClient.writeContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_1155_ABI), functionName: 'setApprovalForAll',
            args: [EXCHANGE_ADDR, true], account: makerAccount
        });
        console.log('✅ Maker Approved Exchange');


        // ---------------------------------------------------------
        // Step 5: Place Orders (Maker SELL YES)
        // ---------------------------------------------------------
        console.log('\nStep 5: Maker Placing Order...');
        const marketMeta = { yes_token_id: yesTokenId.toString() }; // Mock market obj for ClobClient

        await ClobClient.placeOrder(makerPk, marketMeta, 'SELL', 0.50, 10);
        console.log('✅ Maker Sell Order Placed (10 @ 0.50)');

        // ---------------------------------------------------------
        // Step 6: Taker Trade (Buy YES)
        // ---------------------------------------------------------
        console.log('\nStep 6: Taker Setup & Trade...');
        // Mint USDC to Taker
        const mintTx2 = await publicClient.writeContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'mint',
            args: [takerAccount.address, amount], account: takerAccount
        });
        await publicClient.waitForTransactionReceipt({ hash: mintTx2 });

        // Taker approves Exchange (USDC)
        const approveTx2 = await takerClient.writeContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'approve',
            args: [EXCHANGE_ADDR, amount], account: takerAccount
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx2 });

        // Taker Buys
        const buyRes = await ClobClient.placeOrder(takerPk, marketMeta, 'BUY', 0.60, 5);
        if (buyRes.trades.length > 0) {
            console.log(`✅ Taker Matched! Trade ID: ${buyRes.trades[0].trade_id}`);
        } else {
            throw new Error("Taker order not matched");
        }

        // ---------------------------------------------------------
        // Step 7: Resolve Market & Redeem
        // ---------------------------------------------------------
        console.log('\nStep 7: Resolving Market...');
        // Warp Time (Increase 4000s)
        await publicClient.transport.request({ method: 'evm_increaseTime', params: [4000] });
        await publicClient.transport.request({ method: 'evm_mine', params: [] });

        // Resolve via Script Step 2
        execSync(`ADAPTER_ADDR=${adapterAddr} QUESTION_ID=${questionID} forge script scripts/E2E_Step2_Resolve.s.sol --broadcast --rpc-url ${RPC_URL}`, { cwd, encoding: 'utf-8' });
        console.log('✅ Market Resolved');

        // Redeem (Maker has 990 YES left + 1000 NO). 
        // Resolution was YES=1 (Price updated to 70k in DeployInit).
        // Maker should be able to redeem NO tokens? No, YES tokens win.
        // Wait, DeployInit set Price to 70k (Strike 60k). So YES Wins.
        // Maker SOLD 5 YES. Has 995 YES. 1000 NO.
        // Taker BOUGHT 5 YES. Has 5 YES.

        console.log('\nStep 8: Redeeming...');
        // Taker Redeems YES (Should get 5 USDC)
        const balanceBefore = await publicClient.readContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'balanceOf', args: [takerAccount.address]
        }) as bigint;

        await takerClient.writeContract({
            address: CTF_ADDRESS, abi: parseAbi(CTF_ABI), functionName: 'redeemPositions',
            args: [USDC_ADDRESS, parentCollectionId, conditionID, [1n]], // Index 1 = YES? Need to check collections.
            // Earlier c1 = indexSet 1 (01). c2 = indexSet 2 (10).
            // Usually Index 1 is the first slot.
            account: takerAccount
        });

        const balanceAfter = await publicClient.readContract({
            address: USDC_ADDRESS, abi: parseAbi(ERC20_ABI), functionName: 'balanceOf', args: [takerAccount.address]
        }) as bigint;

        console.log(`Taker USDC Balance Change: ${formatUnits(balanceAfter - balanceBefore, 6)}`);

        console.log('\n🎉 GRAND E2E SUCCESS!');

    } catch (e: any) {
        console.error("FAILED:", e);
        process.exit(1);
    }
}

// Minimal helpers for formatting if needed
function formatUnits(val: bigint, decimals: number) {
    return (Number(val) / (10 ** decimals)).toFixed(decimals);
}

main();
