// Task-local Node test adapter for the browser's existing Three.js import map.
export function resolve(specifier,context,nextResolve){
 if(specifier==='three')return {url:new URL('../../vendor/three.module.js',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
