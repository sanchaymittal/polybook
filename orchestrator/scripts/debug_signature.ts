
import { createPublicClient, http, parseAbi } from 'viem';
import { anvil } from 'viem/chains';
import { CONTRACTS, RPC_URL } from '../src/contracts.js';
import { Side, SignatureType } from '../src/signing.js';

async function main() {
    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });

    console.log('--- Debugging Relay Taker Order ---');

    // Values from Relay Log Step 1430 (Taker Order - Trader A)
    const takerOrder = {
        salt: 63910567559549187693294567991609377574447371183730691742839702913193008145975n,
        maker: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        signer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: 41069470821908003820423618366673725376269941223722400569053573765861956451072n,
        makerAmount: 3000000n,
        takerAmount: 5000000n,
        expiration: 1770222389n,
        nonce: 1n,
        feeRateBps: 0n,
        side: Side.BUY, // 0
        signatureType: SignatureType.EOA, // 0
        signature: '0xcb013587d84fb76de4fbd9df7d92821789c3f44215cba96db8d9f4d458d0d7ff7217e8cf87582559e6fc170d482a1f61a6ef94596ece9ab100d76618636a6eb31c' as `0x${string}`
    };

    const HashingABI = parseAbi([
        'struct Order { uint256 salt; address maker; address signer; address taker; uint256 tokenId; uint256 makerAmount; uint256 takerAmount; uint256 expiration; uint256 nonce; uint256 feeRateBps; uint8 side; uint8 signatureType; bytes signature; }',
        'function validateOrderSignature(bytes32 orderHash, Order memory order) external view',
        'function hashOrder(Order memory order) external view returns (bytes32)',
        'function matchOrders(Order memory takerOrder, Order[] memory makerOrders, uint256 takerFillAmount, uint256[] memory makerFillAmounts) external',
        'function domainSeparator() external view returns (bytes32)'
    ]);

    try {
        const separator = await publicClient.readContract({
            address: CONTRACTS.EXCHANGE,
            abi: HashingABI,
            functionName: 'domainSeparator',
        });
        console.log(`Contract DOMAIN_SEPARATOR: ${separator}`);
    } catch (e) {
        console.log('Could not fetch domainSeparator');
        console.log(e);
    }

    const orderHash = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: HashingABI,
        functionName: 'hashOrder',
        args: [takerOrder]
    });
    console.log(`Order Hash: ${orderHash}`);

    try {
        await publicClient.readContract({
            address: CONTRACTS.EXCHANGE,
            abi: HashingABI,
            functionName: 'validateOrderSignature',
            args: [orderHash, takerOrder]
        });
        console.log('validateOrderSignature SUCCESS');
    } catch (e: any) {
        console.log('validateOrderSignature FAILED');
        console.log(e.message || e);
    }

    try {
        // Taker with Empty Makers
        await publicClient.simulateContract({
            address: CONTRACTS.EXCHANGE,
            abi: HashingABI,
            functionName: 'matchOrders',
            args: [takerOrder, [], 0n, []],
            account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // Deployer
        });
        console.log('Empty Match Simulation SUCCESS');
    } catch (e: any) {
        console.log('Empty Match Simulation FAILED');
        console.log(e.message || e);
    }
}

main().catch(console.error);
