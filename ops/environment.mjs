import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export function inspectEnvironment({profile = 'demo', nodeVersion = process.versions.node, resolvePackage} = {}) {
  if (!['demo', 'integration'].includes(profile)) throw Error('Use --profile demo|integration');
  const lookup = resolvePackage ?? ((from, name) => createRequire(new URL(from, import.meta.url)).resolve(name));
  const checks = [{name: 'Node.js >=22', ready: Number(nodeVersion.split('.')[0]) >= 22}];
  if (profile === 'integration') {
    for (const [name, from, dependency] of [
      ['Auth embedded test dependency', '../services/api/auth/package.json', '@electric-sql/pglite'],
      ['Ingestion PostgreSQL driver', '../services/ingestion/package.json', 'pg'],
      ['Ingestion native test dependency', '../services/ingestion/package.json', 'embedded-postgres'],
    ]) {
      let ready = false;
      try { lookup(from, dependency); ready = true; } catch {}
      checks.push({name, ready});
    }
  }
  return {profile, ready: checks.every(check => check.ready), checks,
    scope: 'Local prerequisites only; does not prove database, identity, HTTP or hosted readiness.'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--profile')) throw Error('Use --profile demo|integration');
    const result = inspectEnvironment({profile: args[1] ?? 'demo'});
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
