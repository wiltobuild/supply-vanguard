// Node-only bridge to the scene's existing vendored Three.js. No npm dependency or app import change.
import {register} from 'node:module';
const url=new URL('../packages/scene/viewer/vendor/three.module.js',import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier,context,next){if(specifier==='three')return {url:${JSON.stringify(url)},shortCircuit:true};return next(specifier,context);}`)}`,import.meta.url);
export const THREE=await import('../packages/scene/viewer/vendor/three.module.js');
export const {createAsset,ASSET_TYPES}=await import('../packages/scene/viewer/models.js');
export const {createWard}=await import('../packages/scene/viewer/ward.js');
