// SV-034: the ONLY module in this suite that imports child_process or touches real time and randomness. It is imported dynamically, and only
// after an explicit opt-in contract has been validated. Importing the rest of the suite never reaches this file.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
export const realSpawn=spawn;
export const realNonce=()=>randomBytes(12).toString('hex');
export const realClock={now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:handle=>clearTimeout(handle)};
