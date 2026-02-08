
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const key = '0x17e0c712f9ea0821e255f820224ee3eb65de3abfc2a57c4fd5103396fe931024';
const account = privateKeyToAccount(key);
console.log(`Address: ${account.address}`);
