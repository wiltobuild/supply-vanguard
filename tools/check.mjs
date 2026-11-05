import {readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {ADDITIONAL_ASSET_TYPES} from '../packages/scene/viewer/additional-assets.js';
const root=resolve(import.meta.dirname,'..');
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name.startsWith('.')||e.name==='node_modules'?[]:e.isDirectory()?walk(resolve(dir,e.name)):[resolve(dir,e.name)]);}
const files=walk(root);for(const file of files.filter(f=>/\.(m?js)$/.test(f))){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}
const glbs=files.filter(f=>f.endsWith('.glb'));
const expectedGlbs=[...Object.keys(JSON.parse(readFileSync(resolve(root,'tests/fixtures/original-glbs.sha256.json')))),...ADDITIONAL_ASSET_TYPES.map(id=>`${id}.glb`)];
if(glbs.length!==expectedGlbs.length)throw Error(`Expected ${expectedGlbs.length} GLBs, got ${glbs.length}`);
for(const name of expectedGlbs)if(!glbs.includes(resolve(root,'packages/scene/viewer/assets',name)))throw Error(`Missing required GLB ${name}`);
for(const f of glbs){const b=readFileSync(f);if(b.toString('ascii',0,4)!=='glTF'||b.readUInt32LE(4)!==2||b.readUInt32LE(8)!==b.length)throw Error('Invalid GLB '+f);}
const board=JSON.parse(readFileSync(resolve(root,'planning/tasks.json'))),ids=new Set(board.tasks.map(t=>t.id));if(ids.size!==board.tasks.length)throw Error('Duplicate task IDs');for(const t of board.tasks)for(const dep of t.dependsOn)if(!ids.has(dep))throw Error('Unknown dependency '+dep);
console.log(`JavaScript syntax, ${glbs.length} GLB containers and ${ids.size} task definitions validated.`);
