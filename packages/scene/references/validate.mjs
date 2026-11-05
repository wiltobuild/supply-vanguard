import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {ROOMS, INITIAL_LOCATIONS, ASSET_LABELS, MANIFEST, SOURCES} from '../viewer/data.js';
import {SLOT_LAYOUT} from '../viewer/config.js';
import {LIMITS} from '../viewer/nav.js';

const viewer = new URL('../viewer/', import.meta.url);
export const registerURL = new URL('./register.json', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, viewer), 'utf8'));

// Model numbers are a reproducible snapshot, never measurements of the real ward.
export function sceneSnapshot() {
  const manifest = json('assets/manifest.json');
  const elements = [
    {id:'ward-envelope', kind:'architecture', modelValues:MANIFEST.dimensions},
    {id:'ward-layout', kind:'architecture', modelValues:{infantRoomCount:MANIFEST.roomCount, roomIds:MANIFEST.roomIds}},
    {id:'procedural-architecture', kind:'architecture', modelValues:{file:'ward.js'}},
    {id:'navigation', kind:'navigation', modelValues:{limits:LIMITS, file:'assets/navigation.json'}},
    {id:'equipment-slots', kind:'placement', modelValues:SLOT_LAYOUT},
    {id:'coordinate-system', kind:'convention', modelValues:{units:MANIFEST.units, upAxis:MANIFEST.upAxis, equipmentFront:'+Z', geographicNorthVerified:false}},
    ...ROOMS.map(room => ({id:room.id, kind:'room', modelValues:room})),
    ...INITIAL_LOCATIONS.map(({items, ...location}) => ({id:location.id, kind:'supply-location', modelValues:location})),
    ...Object.keys(ASSET_LABELS).map(id => ({id:`model:${id}`, kind:'equipment-model', modelValues:manifest.assets.find(asset => asset.id === id)}))
  ];
  const paths = ['data.js', 'config.js', 'ward.js', 'models.js', 'nav.js', 'assets/manifest.json', 'assets/locations.json', 'assets/navigation.json',
    ...manifest.assets.map(asset => `assets/${asset.file}`), `assets/${manifest.ward.file}`, `assets/${manifest.ward.cutawayFile}`];
  const artifacts = paths.map(path => {
    const bytes = readFileSync(new URL(path, viewer));
    const normalization = path.endsWith('.glb') ? 'binary' : 'utf8-lf';
    const content = normalization === 'binary' ? bytes : bytes.toString('utf8').replace(/\r\n/g, '\n');
    return {path, normalization, sha256:createHash('sha256').update(content).digest('hex')};
  });
  return {elements, artifacts};
}

const requireThat = (condition, message) => { if (!condition) throw Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function uniqueById(records, label) {
  requireThat(Array.isArray(records), `${label} must be an array`);
  const map = new Map();
  for (const record of records) {
    requireThat(record && nonempty(record.id) && !map.has(record.id), `${label}: missing or duplicate ID`);
    map.set(record.id, record);
  }
  return map;
}

// Schema 1 is a blocked baseline: it cannot certify architectural accuracy.
// An authorized measurement workflow needs a separately reviewed schema change,
// evidence artifacts and field-level measurement comparisons before promotion.
export function validateRegister(register, snapshot = sceneSnapshot()) {
  requireThat(register.schemaVersion === 1 && register.taskId === 'SV-015', 'Unsupported reference register');
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(register.reviewedOn) && Number.isFinite(Date.parse(register.reviewedOn)), 'Review date is required');
  requireThat(/^[a-f0-9]{40}$/.test(register.baselineCommit), 'Baseline commit is required');
  for (const basis of ['measured', 'estimated', 'qualitative', 'convention']) {
    requireThat(nonempty(register.definitions?.[basis]), `Missing basis definition: ${basis}`);
  }
  requireThat(register.validation?.status === 'blocked-external-evidence' && register.validation.authorizedReview === null,
    'No authorized geometry review is registered; status must remain blocked');
  requireThat(register.validation.architecturalAccuracyClaimed === false, 'Architectural accuracy is not established');
  const blockers = uniqueById(register.validation.requiredEvidence, 'Required evidence');
  for (const id of ['permission', 'measured-geometry', 'location-mapping', 'equipment-placement', 'authorized-review']) {
    requireThat(nonempty(blockers.get(id)?.needed) && nonempty(blockers.get(id)?.resolutionEvidence), `Missing external evidence requirement: ${id}`);
  }
  const sources = uniqueById(register.sources, 'Sources');
  requireThat(sources.get('local-scene')?.scope === 'illustrative-model', 'Local scene must be labeled illustrative');
  for (const source of sources.values()) {
    requireThat(source.dimensionalEvidence === false && nonempty(source.limitation), `No dimensional evidence is registered: ${source.id}`);
    requireThat(['illustrative-model', 'qualitative-only', 'building-context-only'].includes(source.scope), `Unsupported source scope: ${source.id}`);
  }
  for (const source of SOURCES) {
    const match = [...sources.values()].find(s => s.url === source.url);
    requireThat(match && nonempty(match.locator) && match.accessedOn === register.reviewedOn, `Missing dated public-source review: ${source.url}`);
  }
  const elements = uniqueById(register.elements, 'Elements');
  requireThat(elements.size === snapshot.elements.length, 'Element coverage differs from the scene');
  let estimated = 0, conventions = 0;
  for (const expected of snapshot.elements) {
    const record = elements.get(expected.id);
    requireThat(record && record.kind === expected.kind, `Missing or wrong element: ${expected.id}`);
    requireThat(isDeepStrictEqual(record.modelValues, expected.modelValues), `Model snapshot changed: ${expected.id}`);
    const convention = record.kind === 'convention';
    requireThat(record.basis === (convention ? 'convention' : 'estimated') && record.confidence === (convention ? 'declared' : 'unverified'),
      `No approved measured evidence for element: ${record.id}`);
    requireThat(Array.isArray(record.sourceIds) && record.sourceIds.length === 1 && record.sourceIds[0] === 'local-scene',
      `Public qualitative sources cannot establish modeled dimensions or placement: ${record.id}`);
    requireThat(Array.isArray(record.scope) && record.scope.length > 0 && record.scope.every(nonempty) && nonempty(record.limitation), `Element needs scope and limitation: ${record.id}`);
    convention ? conventions++ : estimated++;
  }
  requireThat(isDeepStrictEqual(register.artifacts, snapshot.artifacts), 'Scene artifacts changed; review and refresh the reference register');
  const claims = uniqueById(register.qualitativeClaims, 'Qualitative claims');
  requireThat(claims.size > 0, 'Qualitative review is missing');
  for (const claim of claims.values()) {
    requireThat(claim.basis === 'qualitative' && nonempty(claim.statement) && nonempty(claim.limitation), `Invalid qualitative claim: ${claim.id}`);
    requireThat(Array.isArray(claim.sourceIds) && claim.sourceIds.length > 0 && claim.sourceIds.every(id => sources.get(id)?.scope === 'qualitative-only'),
      `Qualitative claim needs a qualitative source: ${claim.id}`);
  }
  return {status:register.validation.status, measured:0, estimated, conventions, qualitativeClaims:claims.size, artifacts:snapshot.artifacts.length};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = validateRegister(JSON.parse(readFileSync(registerURL, 'utf8')));
    console.log(JSON.stringify(summary, null, 2));
    console.log('Register consistency passed. Authorized geometry validation remains BLOCKED; this is not architectural sign-off.');
    if (process.argv.includes('--require-authorized')) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
