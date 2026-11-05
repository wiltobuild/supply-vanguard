// Resolve the already-vendored scene library for Node-only geometry checks. No dependency changes.
export function resolve(specifier,context,nextResolve){
 if(specifier==='three')return {url:new URL('../../../vendor/three.module.js',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
