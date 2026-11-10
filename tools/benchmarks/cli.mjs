// Command line wrapper for the benchmark runner (SV-028). Writing this file does not run a benchmark.
// Usage: node tools/benchmarks/cli.mjs --config path/to/config.json [--format json|text]
// Secrets never go in the config file: list header names and the environment variable that holds each value.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {runBenchmark,formatText,createFetchTransport} from './runner.mjs';

export function parseArgs(argv) {
  const out = {format: 'text'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else throw new RangeError(`Unknown argument at position ${i + 1}`);
  }
  if (!out.config) throw new RangeError('--config is required');
  if (!['json', 'text'].includes(out.format)) throw new RangeError('--format must be json or text');
  return out;
}

// config.headerEnv = {"authorization": "SV_BENCH_AUTH"} reads each value from the named environment variable.
export function resolveConfig(file, env) {
  const {headerEnv, ...config} = file;
  if (headerEnv !== undefined) {
    if (headerEnv === null || typeof headerEnv !== 'object' || Array.isArray(headerEnv)) throw new RangeError('headerEnv must be an object');
    config.headers = {};
    Object.entries(headerEnv).forEach(([name, variable], index) => {
      if (typeof variable !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(variable)) throw new RangeError('headerEnv values must be environment variable names');
      if (!env[variable]) throw new RangeError(`headerEnv entry ${index + 1}: the environment variable is not set`);   // neither the name nor the value is echoed
      config.headers[name] = env[variable];
    });
  }
  return config;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = resolveConfig(JSON.parse(readFileSync(args.config, 'utf8')), process.env);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const result = await runBenchmark(config, {transport: createFetchTransport(), signal: controller.signal});
    process.stdout.write(args.format === 'json' ? JSON.stringify(result, null, 2) + '\n' : formatText(result));
    process.exitCode = result.status === 'COMPLETE' && !result.failuresPresent ? 0 : 1;
  } catch (error) {
    // Only our own validation messages are shown; no stack traces, URLs or header values.
    console.error(error instanceof RangeError || error instanceof TypeError ? error.message : 'Benchmark failed to start');
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
