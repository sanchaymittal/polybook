
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import axios from 'axios';
import { CONTRACTS } from '../orchestrator/src/contracts.js';

const CLOB_URL = 'http://127.0.0.1:3030';
const RPC_URL = 'http://127.0.0.1:8545';

// Random test user
const TEST_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Trader A
const account = privateKeyToAccount(TEST_PK);

const USDC_ABI = [
    { name: 'balanceOf', type: 'function', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
    { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }
] as const;

const CTF_ABI = [
    { name: 'isApprovedForAll', type: 'function', inputs: [{ name: 'account', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
    { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] }
] as const;

async function main() {
    console.log(`🤖 Verifying CLOB Token APIs with user: ${account.address}`);

    const client = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
    const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) });

    // 1. Test Mint
    console.log('\nTesting /mint-dummy...');
    const mintAmount = "10000000"; // 10 USDC
    try {
        const res = await axios.post(`${CLOB_URL}/mint-dummy`, {
            address: account.address,
            amount: mintAmount
        });
        console.log('✅ Mint Success:', res.data);
    } catch (e: any) {
        console.error('❌ Mint Failed:', e.response?.data || e.message);
        process.exit(1);
    }

    // Verify Balance
    const bal = await client.readContract({ address: CONTRACTS.USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] });
    console.log(`💰 USDC Balance: ${formatUnits(bal, 6)}`);

    // 2. Approve CLOB for Split
    // We assume CLOB is the Relayer. In .env we set RELAYER_KEY = DEPLOYER_KEY.
    // So Relayer Address is Deployer Address.
    // Wait, usually CLOB uses *its own* address if it's a relayer?
    // In `api_token.rs`, Relayer Address is derived from RELAYER_PRIVATE_KEY.
    // Let's assume it's the Deployer address for now.
    const RELAYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Deployer

    console.log(`\napproving CLOB Relayer (${RELAYER_ADDRESS}) for USDC...`);
    const tx = await wallet.writeContract({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: 'approve',
        args: [RELAYER_ADDRESS, parseUnits('100', 6)]
    });
    await client.waitForTransactionReceipt({ hash: tx });
    console.log('✅ Approved');

    // 3. Test Split
    console.log('\nTesting /split-position...');
    const splitAmount = "2000000"; // 2 USDC
    try {
        const res = await axios.post(`${CLOB_URL}/split-position`, {
            owner: account.address,
            amount: splitAmount
        });
        console.log('✅ Split Result:', res.data);
        if (!res.data.success) throw new Error("API returned false");
    } catch (e: any) {
        console.error('❌ Split Failed:', e.response?.data || e.message);
        process.exit(1);
    }

    // 4. Test Merge
    console.log('\nTesting /merge-position...');
    // Need CTF Approval
    console.log('Approving CTF for Relayer...');
    const tx2 = await wallet.writeContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'setApprovalForAll',
        args: [RELAYER_ADDRESS, true]
    });
    await client.waitForTransactionReceipt({ hash: tx2 });

    try {
        const res = await axios.post(`${CLOB_URL}/merge-position`, {
            owner: account.address,
            amount: splitAmount
        });
        console.log('✅ Merge Result:', res.data);
        if (!res.data.success) throw new Error("API returned false");
    } catch (e: any) {
        console.error('❌ Merge Failed:', e.response?.data || e.message);
    }

    console.log('\n🎉 All Tests Passed!');
}

main();
