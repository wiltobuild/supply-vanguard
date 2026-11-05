import {parseEquipmentLabel} from './payload.js';
// No permission is requested until start(), called by the visible Start camera button.
export function createScanner({video,onScan,onError,environment=globalThis}) {
 let generation=0,stream,timer;
 const stop=()=>{generation++;environment.clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;video.hidden=true;};
 const supported=()=>Boolean(environment.isSecureContext && environment.BarcodeDetector && environment.navigator?.mediaDevices?.getUserMedia);
 return {stop,supported,async start() {
  stop(); const current=generation;
  if (!supported()) {onError('Camera scanning is unavailable. Type the ID or use a keyboard scanner.');return;}
  try {
   const formats=await environment.BarcodeDetector.getSupportedFormats();
   const allowed=formats.filter(f=>['qr_code','code_128','code_39','ean_13','ean_8','upc_a','upc_e','itf','codabar'].includes(f));
   if (!allowed.length) throw new Error('No supported barcode formats');
   if (current!==generation)return;
   const acquired=await environment.navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
   if (current!==generation) {acquired.getTracks().forEach(t=>t.stop());return;}
   stream=acquired;video.srcObject=stream;video.hidden=false;await video.play();
   const detector=new environment.BarcodeDetector({formats:allowed});
   const poll=async()=>{
    try {
     if (current!==generation)return;
     const labels=await detector.detect(video);
     if (current!==generation)return;
     if (labels.length) {const label=labels[0],id=parseEquipmentLabel(label.rawValue);stop();onScan(id,label.format==='qr_code'?'qr':'barcode');return;}
     timer=environment.setTimeout(poll,200);
    } catch {if(current===generation){stop();onError('Could not read this label. Retry the camera or type the equipment ID.');}}
   };
   if(current===generation)await poll();
  } catch {if(current===generation){stop();onError('Camera access was denied or unavailable. Type the ID, use a keyboard scanner, or retry the camera.');}}
 }};
}
