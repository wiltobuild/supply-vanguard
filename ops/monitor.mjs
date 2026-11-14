import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Offline evaluation contract for a future authorized metrics adapter. No endpoint is invented.
const fields = ['apiErrorRatio', 'ingestionDelaySeconds', 'staleEquipmentRatio', 'backgroundFailures', 'journalFailures'];
export function evaluateTelemetry(input, {now = Date.now()} = {}) {
  if (!input || input.schemaVersion !== 1) throw Error('Unsupported telemetry schema');
  if (!Number.isFinite(now)) throw Error('Invalid evaluation clock');
  const {thresholds, metrics} = input;
  if (!thresholds || !metrics) throw Error('Metrics and owner-approved thresholds required');
  for (const key of [...fields, 'maxSampleAgeSeconds']) {
    const value = thresholds[key];
    if (!Number.isFinite(value) || value < 0 || (key.endsWith('Ratio') && value > 1)) throw Error(`Invalid threshold: ${key}`);
  }
  const measured = Date.parse(input.measuredAt);
  const age = (now - measured) / 1000;
  const fresh = Number.isFinite(age) && age >= 0 && age <= thresholds.maxSampleAgeSeconds;
  const signals = fields.map(name => {
    const value = metrics[name];
    const valid = Number.isFinite(value) && value >= 0 && (!name.endsWith('Ratio') || value <= 1)
      && (!name.endsWith('Failures') || Number.isInteger(value));
    return {name, state: !fresh || !valid ? 'unknown' : value > thresholds[name] ? 'alert' : 'ok'};
  });
  return {state: signals.some(s => s.state === 'alert') ? 'alert' : signals.some(s => s.state === 'unknown') ? 'unknown' : 'ok',
    signals, scope: 'Aggregated sample evaluation only; no collector, alert delivery or service-level guarantee.'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--input') throw Error('Use --input <aggregate-telemetry.json>');
    const bytes = readFileSync(args[1]);
    if (bytes.length > 16_384) throw Error('Telemetry sample exceeds 16 KiB');
    const result = evaluateTelemetry(JSON.parse(bytes.toString('utf8')));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.state === 'ok' ? 0 : result.state === 'alert' ? 1 : 2;
  } catch { console.error('Telemetry evaluation failed; check bounded aggregate input and explicit thresholds.'); process.exitCode = 2; }
}
