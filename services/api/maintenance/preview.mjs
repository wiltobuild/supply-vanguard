// Explicit, disposable synthetic fixture for the manager's authorized mounted acceptance environment.
// No issuance endpoint, credential logs/files, production verifier or persistent database/access.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {start} from 'node:repl';
import {startFixture} from '../../../apps/web/tests/api-fixture.mjs';
export async function startMaintenancePreview({port=4184}={}){
 const require=createRequire(new URL('./package.json',import.meta.url)),{PGlite}=require('@electric-sql/pglite');
 return startFixture({transport:'preview',PGlite,maintenanceExamples:true,port});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const preview=await startMaintenancePreview({port:Number(process.env.PORT||4184)});
 process.stdout.write(`Disposable synthetic maintenance fixture: ${preview.base}/maintenance\nTrusted in-memory fixture is bound as preview in this local REPL. Sessions are not printed or served by HTTP.\n`);
 const shell=start({prompt:'synthetic preview> ',terminal:!!process.stdin.isTTY});shell.context.preview=preview;
 shell.on('exit',()=>{void preview.close();});
}
