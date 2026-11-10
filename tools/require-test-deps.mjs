// Runs before `npm test` (SV-019). The auth and API tests use PGlite, an embedded database that is a TEST-ONLY dependency
// installed under services/api/auth. On a clean checkout it is missing, which used to crash the run with a module-not-found
// stack trace. Say what to do instead.
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const dir=resolve(import.meta.dirname,'..','services/api/auth/node_modules/@electric-sql/pglite');
if(!existsSync(dir)){
 console.error('Test dependency missing: @electric-sql/pglite (test-only embedded database).\nInstall it once from a clean checkout, then run the tests again:\n\n  npm run setup:test\n  npm test\n');
 process.exit(1);
}
