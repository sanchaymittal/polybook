
import { createPublicClient, http, parseAbi } from 'viem';
import { anvil } from 'viem/chains';
import { CONTRACTS, RPC_URL, LP_ADDRESS, TRADER_A_ADDRESS } from '../src/contracts.js';
import { EIP712_DOMAIN, hashOrderStruct, ORDER_TYPES, createOrder, Order, Side, SignatureType } from '../src/signing.js';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters, hashTypedData } from 'viem';

async function main() {
    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });

    // Params from Relay Log (Trade 1)
    const salt = 63910567559549187693294567991609377574447371183730691742839702913193008145975n;
    const maker = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // Trader A
    const signer = maker;
    const taker = '0x0000000000000000000000000000000000000000';
    const tokenId = 41069470821908003820423618366673725376269941223722400569053573765861956451072n;
    const makerAmount = 3000000n;
    const takerAmount = 5000000n;
    const expiration = 1770222389n;
    const nonce = 1n;
    const feeRateBps = 0n;
    const side = Side.BUY; // 0
    const signatureType = SignatureType.EOA; // 0

    const order = {
        salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType, signature: '0x' as `0x${string}`
    };

    console.log('--- Debugging Hash Mismatch ---');

    // 1. Get Domain Separator from Contract
    const domainSeparator = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: parseAbi(['function domainSeparator() external view returns (bytes32)']),
        functionName: 'domainSeparator'
    });
    console.log(`On-Chain Domain Separator: ${domainSeparator}`);

    // 2. Compute Local Domain Separator
    // viem computes this internally for signTypedData.
    // We can compute manually:
    const localDomain = hashTypedData({
        domain: EIP712_DOMAIN,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: order
    });
    // Wait, hashTypedData computes the FINAL digest.
    // I want Domain Separator.
    // Keccak(encode(EIP712Domain(...)))
    const domainTypeHash = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
    const localDomainHash = keccak256(encodeAbiParameters(
        parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
        [
            domainTypeHash,
            keccak256(toHex(EIP712_DOMAIN.name)),
            keccak256(toHex(EIP712_DOMAIN.version)),
            BigInt(EIP712_DOMAIN.chainId),
            EIP712_DOMAIN.verifyingContract
        ]
    ));
    console.log(`Local Domain Separator:    ${localDomainHash}`);

    if (domainSeparator !== localDomainHash) {
        console.error('!!! DOMAIN SEPARATOR MISMATCH !!!');
    } else {
        console.log('Domain Separator MATCHES.');
    }

    // 3. Get Order Hash from Contract
    // hashOrder(Order)
    // Order struct in ABI requires full tuple
    const HashingABI = parseAbi([
        'struct Order { uint256 salt; address maker; address signer; address taker; uint256 tokenId; uint256 makerAmount; uint256 takerAmount; uint256 expiration; uint256 nonce; uint256 feeRateBps; uint8 side; uint8 signatureType; bytes signature; }',
        'function hashOrder(Order memory order) external view returns (bytes32)'
    ]);

    const onChainHash = await publicClient.readContract({
        address: CONTRACTS.EXCHANGE,
        abi: HashingABI,
        functionName: 'hashOrder',
        args: [{ ...order, signature: '0x' }] // Struct
    });
    console.log(`On-Chain Order Hash: ${onChainHash}`);

    // 4. Compute Local Order Hash
    // hashTypedData gives the final EIP712 digest
    const localHash = hashTypedData({
        domain: EIP712_DOMAIN,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: order
    });
    console.log(`Local Order Hash:    ${localHash}`);

    if (onChainHash !== localHash) {
        console.error('!!! ORDER HASH MISMATCH !!!');
        // Likely Struct Hash mismatch
    } else {
        console.log('Order Hash MATCHES.');
    }

}

main().catch(console.error);
