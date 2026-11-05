// SV-024: original illustrative set dressing, never serialized inventory or a clinical specification.
export const ADDITIONAL_ASSETS = Object.freeze({
  'neonatal-ventilator': {label:'Neonatal ventilator', detail:'Screen, humidifier and twin breathing circuit'},
  'cpap-stand': {label:'CPAP stand', detail:'Flow controls, bubble chamber and breathing hose'},
  'phototherapy-light': {label:'Phototherapy light', detail:'Adjustable arm and blue LED treatment head'},
  'ultrasound-cart': {label:'Portable ultrasound cart', detail:'Display, console, probe holders and cables'},
  'portable-xray': {label:'Portable X-ray', detail:'Wheeled generator, articulated arm and tube head'},
  'transport-incubator': {label:'Transport incubator', detail:'Protective hood, stretcher chassis and gas cylinders'},
  'infant-scale': {label:'Infant scale', detail:'Contoured weighing tray on a mobile cabinet'},
  'feeding-pump-stand': {label:'Feeding-pump stand', detail:'Purple enteral pump, feed bag and dedicated tubing'},
  'portable-suction': {label:'Portable suction', detail:'Vacuum gauge, twin collection jars and hose'},
  'resuscitation-cart': {label:'Resuscitation cart', detail:'Drawer bank, bag-mask tray and cylinder bracket'},
  'milk-refrigerator': {label:'Breast-milk refrigerator', detail:'Glazed door, bottle shelves and temperature display'},
  'milk-preparation-counter': {label:'Milk-preparation counter', detail:'Worktop, bottle rack and closed storage'},
  'equipment-charging-station': {label:'Equipment charging station', detail:'Open charging bays, docks and cable management'},
  'soiled-equipment-rack': {label:'Soiled-equipment rack', detail:'Separate collection trays and covered bin'},
  'wall-ppe-dispenser': {label:'Wall PPE dispenser', detail:'Glove boxes, mask pocket and gown compartment'}
});
export const ADDITIONAL_ASSET_TYPES = Object.freeze(Object.keys(ADDITIONAL_ASSETS));
export const ADDITIONAL_ASSET_LABELS = Object.freeze(Object.fromEntries(Object.entries(ADDITIONAL_ASSETS).map(([id,a])=>[id,a.label])));
export const DECORATION_PROVENANCE = 'Original illustrative static decoration; not tracked inventory. Dimensions, equipment makes and Hopkins placement are unverified. Not for clinical planning.';

// Meter coordinates in the existing six-room concept. No new rooms or inventory IDs.
// Wall PPE uses the same floor-reference origin as other models, with its case at mounting height.
export const ADDITIONAL_PLACEMENTS = Object.freeze([
  {kind:'neonatal-ventilator', roomId:'room-101', x:.55, z:-4.35, rotation:0},
  {kind:'cpap-stand', roomId:'room-102', x:5.6, z:-4.35, rotation:0},
  {kind:'phototherapy-light', roomId:'room-104', x:.5, z:4.25, rotation:Math.PI},
  {kind:'ultrasound-cart', roomId:'room-105', x:5.6, z:4.3, rotation:Math.PI},
  {kind:'portable-xray', roomId:'room-103', x:7.35, z:-3.7, rotation:0},
  {kind:'transport-incubator', roomId:'room-106', x:7.35, z:3.8, rotation:Math.PI},
  {kind:'infant-scale', roomId:'room-102', x:2.25, z:-3.65, rotation:0},
  {kind:'feeding-pump-stand', roomId:'room-103', x:10.55, z:-4.35, rotation:0},
  {kind:'portable-suction', roomId:'room-106', x:10.6, z:4.35, rotation:Math.PI},
  {kind:'resuscitation-cart', roomId:'room-104', x:-2.7, z:3.5, rotation:Math.PI},
  {kind:'milk-refrigerator', roomId:'staff-base', x:-6.95, z:-6.4, rotation:0},
  {kind:'milk-preparation-counter', roomId:'staff-base', x:-6.95, z:-3.6, rotation:Math.PI/2},
  {kind:'equipment-charging-station', roomId:'equipment-store', x:-8.55, z:1.82, rotation:0},
  {kind:'soiled-equipment-rack', roomId:'equipment-store', x:-8.05, z:4.35, rotation:-Math.PI/2},
  {kind:'wall-ppe-dispenser', roomId:'room-101', x:-3.412, z:-2.65, rotation:Math.PI/2}
]);
