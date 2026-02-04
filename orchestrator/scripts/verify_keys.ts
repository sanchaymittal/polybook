
import { privateKeyToAccount } from 'viem/accounts';
import { LP_PRIVATE_KEY, LP_ADDRESS, TRADER_A_PRIVATE_KEY, TRADER_A_ADDRESS } from '../src/contracts.js';

function check(name: string, pk: `0x${string}`, addr: string) {
    const account = privateKeyToAccount(pk);
    if (account.address !== addr) {
        console.error(`MISMATCH for ${name}:`);
        console.error(`  Key derives: ${account.address}`);
        console.error(`  Constant is: ${addr}`);
    } else {
        console.log(`MATCH for ${name}: ${addr}`);
    }
}

console.log('Verifying keys...');
check('LP', LP_PRIVATE_KEY, LP_ADDRESS);
check('Trader A', TRADER_A_PRIVATE_KEY, TRADER_A_ADDRESS);
