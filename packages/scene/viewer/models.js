import * as THREE from 'three';
import {additionalBuilders} from './additional-models.js';
import {ADDITIONAL_ASSET_TYPES,DECORATION_PROVENANCE} from './additional-assets.js';

// Original procedural equipment. Representative clinical forms, not manufacturer replicas.
// Coordinates: meters, Y up, +Z front. Every returned asset has a floor-level origin.
export const ASSET_TYPES = ['incubator', 'warmer', 'monitor', 'infusion', 'recliner', 'supply-cabinet', 'supply-cart', 'workstation', 'sink', 'stool', ...ADDITIONAL_ASSET_TYPES];
const mat = (color, roughness = .55, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const M = {
  white: mat('#e8eceb', .48), ivory: mat('#f4f1e7', .64), steel: mat('#aabac0', .28, .72), chrome: mat('#c4d5d8', .22, .8),
  gray: mat('#849598', .48), dark: mat('#344c54', .52), tire: mat('#303b40', .88), teal: mat('#468d92', .66),
  glass: mat('#cde8e9', .16, .06, { transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide }),
  fluid: mat('#dbe8d8', .24, 0, { transparent: true, opacity: .42, depthWrite: false }),
  screen: mat('#071c23', .28, .05), green: mat('#7deba9', .5, 0, { emissive: '#4ecf7b', emissiveIntensity: .5 }),
  amber: mat('#efba55', .52, 0, { emissive: '#b47420', emissiveIntensity: .15 }), blue: mat('#78bccc', .62),
  binBlue: mat('#77a9b4', .7), binMint: mat('#94bcb0', .72), binSand: mat('#dbc499', .72),
  brown: mat('#987c64', .91), brownDark: mat('#715f51', .89), wood: mat('#bea484', .82), paper: mat('#faf9f0', .9),
};
const geomCache = new Map();
function cached(key, build) { if (!geomCache.has(key)) geomCache.set(key, build()); return geomCache.get(key); }
function roundedGeometry(w, h, d, r = .015) {
  const key = `r:${w}:${h}:${d}:${r}`;
  return cached(key, () => {
    const b = Math.min(r * .32, d * .12, w * .08, h * .08), rad = Math.min(r, w / 3, h / 3);
    const x = -w / 2 + b, y = -h / 2 + b, W = w - 2 * b, H = h - 2 * b;
    const s = new THREE.Shape();
    s.moveTo(x + rad, y); s.lineTo(x + W - rad, y); s.quadraticCurveTo(x + W, y, x + W, y + rad);
    s.lineTo(x + W, y + H - rad); s.quadraticCurveTo(x + W, y + H, x + W - rad, y + H);
    s.lineTo(x + rad, y + H); s.quadraticCurveTo(x, y + H, x, y + H - rad);
    s.lineTo(x, y + rad); s.quadraticCurveTo(x, y, x + rad, y);
    const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 2, steps: 1, curveSegments: 3 });
    g.translate(0, 0, -d / 2 + b); return g;
  });
}
function mesh(parent, geo, material, x = 0, y = 0, z = 0, name = '') {
  const o = new THREE.Mesh(geo, material); o.position.set(x, y, z); o.castShadow = !material.transparent; o.receiveShadow = !material.transparent;
  if (name) o.name = name; parent.add(o); return o;
}
function box(p, w, h, d, x, y, z, m = M.white, r = .015, name = '') { return mesh(p, roundedGeometry(w, h, d, r), m, x, y, z, name); }
function rawbox(p, w, h, d, x, y, z, m = M.white) { return mesh(p, cached(`b:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d)), m, x, y, z); }
function cyl(p, radius, height, x, y, z, m = M.steel, segments = 16) { return mesh(p, cached(`c:${radius}:${height}:${segments}`, () => new THREE.CylinderGeometry(radius, radius, height, segments)), m, x, y, z); }
function bar(p, a, b, radius = .012, material = M.steel) {
  const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b), v = bv.clone().sub(av);
  const o = cyl(p, radius, v.length(), ...av.clone().add(bv).multiplyScalar(.5).toArray(), material, 10);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()); return o;
}
function tube(p, points, radius, material, segments = 32) {
  const curve = new THREE.CatmullRomCurve3(points.map(v => new THREE.Vector3(...v)));
  return mesh(p, new THREE.TubeGeometry(curve, segments, radius, 5, false), material);
}
function ring(p, radius, tubeRadius, x, y, z, material = M.gray, rotY = 0) {
  const o = mesh(p, cached(`t:${radius}:${tubeRadius}`, () => new THREE.TorusGeometry(radius, tubeRadius, 6, 20)), material, x, y, z); o.rotation.y = rotY; return o;
}
function wheel(p, x, z, radius = .065) {
  cyl(p, .018, .06, x, radius * 2 + .012, z, M.chrome, 10);
  const tire = cyl(p, radius, .045, x, radius, z, M.tire, 16); tire.rotation.z = Math.PI / 2;
  const hub = cyl(p, radius * .48, .049, x, radius, z, M.gray, 12); hub.rotation.z = Math.PI / 2;
  box(p, .04, .075, .09, x + .012, radius + .035, z, M.steel, .008);
}
function mobileBase(p, width, depth, pole = false) {
  if (pole) {
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5, x = Math.cos(a) * width / 2, z = Math.sin(a) * depth / 2;
      bar(p, [0, .15, 0], [x, .12, z], .022, M.gray); wheel(p, x, z, .045);
    }
  } else {
    box(p, width, .075, .085, 0, .19, -depth / 2 + .08, M.gray);
    box(p, width, .075, .085, 0, .19, depth / 2 - .08, M.gray);
    box(p, .095, .065, depth - .1, -width / 2 + .08, .19, 0, M.gray);
    box(p, .095, .065, depth - .1, width / 2 - .08, .19, 0, M.gray);
    for (const x of [-width / 2 + .05, width / 2 - .05]) for (const z of [-depth / 2 + .08, depth / 2 - .08]) wheel(p, x, z);
  }
}
function controlPanel(p, x, y, z, w = .22, h = .13) {
  box(p, w, h, .033, x, y, z, M.dark, .018);
  box(p, w * .65, h * .65, .004, x - w * .08, y, z + .019, M.screen, .005);
  for (let i = 0; i < 3; i++) box(p, w * .045, .008, .005, x - w * .25 + i * .025, y + .014, z + .023, M.green, .002);
  const knob = cyl(p, .012, .011, x + w * .36, y - .025, z + .026, M.gray, 12); knob.rotation.x = Math.PI / 2;
  box(p, .012, .012, .006, x + w * .36, y + .023, z + .022, M.amber, .003);
}
function monitorHead(p, x, y, z, width = .43) {
  const h = width * .68;
  box(p, width, h, .075, x, y, z, M.white, .025, 'monitor-housing');
  box(p, width * .87, h * .8, .009, x, y + .008, z + .042, M.screen, .01, 'simulated-monitor-display');
  for (let row = 0; row < 3; row++) {
    const yy = y + h * .23 - row * h * .21, pts = [];
    for (let j = 0; j < 30; j++) { const t = j / 29, peak = j % 15 === 9 ? .035 : j % 15 === 8 ? -.012 : j % 15 === 10 ? -.022 : Math.sin(j * 1.7) * .002; pts.push([x - width * .36 + t * width * .52, yy + peak * (1 - row * .2), z + .05]); }
    tube(p, pts, .0018, row === 2 ? M.amber : row === 1 ? M.blue : M.green, 48);
    for (let k = 0; k < 3; k++) box(p, .01, .018 + k % 2 * .008, .003, x + width * .24 + k * .016, yy, z + .05, row === 2 ? M.amber : M.green, .001);
  }
  for (let i = 0; i < 5; i++) box(p, .022, .007, .003, x - .08 + i * .04, y - h * .43, z + .041, M.gray, .002);
  box(p, .015, .009, .004, x + width * .39, y - h * .42, z + .042, M.green, .003);
  bar(p, [x - .12, y + h / 2 + .01, z], [x + .12, y + h / 2 + .01, z], .012, M.gray);
}
function incubator(g) {
  mobileBase(g, .79, 1.15);
  box(g, .31, .6, .53, 0, .54, -.02, M.white, .045, 'height-adjustable-pedestal');
  box(g, .22, .08, .44, 0, .32, -.02, M.teal, .022);
  box(g, .79, .18, 1.22, 0, .9, 0, M.white, .05, 'incubator-deck');
  box(g, .82, .045, 1.25, 0, 1.015, 0, M.gray, .025);
  box(g, .68, .045, 1.05, 0, 1.06, 0, M.ivory, .03, 'mattress');
  box(g, .64, .012, 1.01, 0, 1.089, 0, M.paper, .025);
  // Clear enclosure panels retain distinct seams and door frames.
  for (const x of [-.389, .389]) {
    box(g, .012, .42, 1.12, x, 1.30, 0, M.glass, .006, 'clear-side-panel');
    for (const z of [-.28, .28]) {
      ring(g, .085, .012, x * 1.025, 1.30, z, M.gray, Math.PI / 2);
      const cover = cyl(g, .076, .005, x * 1.027, 1.30, z, M.glass, 20); cover.rotation.z = Math.PI / 2;
      box(g, .022, .024, .025, x * 1.035, 1.385, z, M.white, .004);
    }
    bar(g, [x, 1.10, -.56], [x, 1.10, .56], .012, M.white);
    bar(g, [x, 1.51, -.56], [x, 1.51, .56], .011, M.white);
  }
  for (const z of [-.56, .56]) {
    box(g, .79, .42, .012, 0, 1.30, z, M.glass, .006, 'clear-end-panel');
    for (const x of [-.389, .389]) bar(g, [x, 1.10, z], [x, 1.51, z], .012, M.white);
    bar(g, [-.389, 1.51, z], [.389, 1.51, z], .011, M.white);
  }
  box(g, .8, .012, 1.13, 0, 1.515, 0, M.glass, .005, 'clear-hood');
  box(g, .14, .035, .035, 0, 1.55, .16, M.white, .012, 'hood-lift-handle');
  controlPanel(g, .16, .92, .625, .27, .12);
  for (let i = 0; i < 7; i++) box(g, .007, .035, .005, -.30 + i * .017, .92, .613, M.gray, .002);
  box(g, .28, .12, .34, 0, .73, .49, M.white, .02, 'utility-drawer');
  box(g, .12, .018, .025, 0, .74, .669, M.gray, .006);
  tube(g, [[.31, .86, -.49], [.4, .66, -.52], [.35, .44, -.48], [.16, .37, -.25]], .012, M.dark);
  box(g, .06, .02, .15, .29, .19, .37, M.teal, .005, 'height-pedal');
}
function warmer(g) {
  mobileBase(g, .74, 1.14);
  box(g, .27, .61, .4, 0, .51, -.14, M.white, .045);
  box(g, .19, 1.58, .16, 0, 1.03, -.49, M.white, .035, 'heater-column');
  box(g, .09, 1.25, .018, 0, 1.08, -.393, M.gray, .01);
  box(g, .77, .12, 1.05, 0, .88, .03, M.white, .035);
  box(g, .66, .05, .94, 0, .968, .03, M.ivory, .02, 'warmer-mattress');
  for (const x of [-.365, .365]) box(g, .012, .19, 1.0, x, 1.09, .03, M.glass, .005);
  for (const z of [-.46, .52]) box(g, .73, .19, .012, 0, 1.09, z, M.glass, .005);
  box(g, .48, .13, .51, 0, 1.84, -.27, M.white, .04, 'radiant-heater');
  box(g, .38, .015, .34, 0, 1.768, -.23, M.dark, .018);
  for (let i = 0; i < 5; i++) box(g, .29, .005, .012, 0, 1.757, -.35 + i * .055, M.amber, .002);
  controlPanel(g, 0, 1.43, -.385, .25, .18);
  box(g, .22, .09, .25, .39, 1.24, -.41, M.white, .018, 'accessory-tray');
  tube(g, [[.19, 1.32, -.4], [.36, 1.22, -.38], [.39, 1.04, -.16]], .007, M.dark);
}
function monitor(g) {
  mobileBase(g, .52, .48, true); cyl(g, .025, 1.14, 0, .71, 0);
  cyl(g, .036, .12, 0, .81, 0, M.gray);
  bar(g, [0, 1.25, 0], [0, 1.38, .02], .022);
  monitorHead(g, 0, 1.43, .025, .49);
  box(g, .29, .026, .22, 0, 1.05, .11, M.white, .015, 'monitor-accessory-tray');
  tube(g, [[.17, 1.35, -.02], [.20, .97, -.03], [.08, .7, -.08]], .007, M.dark);
}
function infusion(g) {
  mobileBase(g, .52, .52, true); cyl(g, .018, 1.52, 0, .91, 0, M.chrome, 16);
  bar(g, [-.19, 1.69, 0], [.19, 1.69, 0], .012, M.chrome);
  for (const x of [-.16, .16]) {
    tube(g, [[x, 1.69, 0], [x, 1.73, 0], [x + .035, 1.74, 0], [x + .05, 1.70, 0]], .008, M.chrome, 14);
    box(g, .11, .23, .035, x, 1.52, .015, M.fluid, .025, 'fluid-bag');
    box(g, .075, .06, .003, x, 1.53, .035, M.paper, .003);
    cyl(g, .008, .05, x, 1.38, .015, M.white, 8);
  }
  for (const [x, y, z] of [[-.10, 1.17, .055], [.10, .94, .055]]) {
    box(g, .23, .19, .14, x, y, z, M.white, .025, 'infusion-pump');
    box(g, .13, .068, .008, x - .026, y + .03, z + .075, M.screen, .006);
    for (let i = 0; i < 3; i++) box(g, .016, .008, .003, x - .065 + i * .032, y + .034, z + .081, M.green, .001);
    box(g, .16, .035, .018, x, y - .053, z + .08, M.teal, .008);
    const knob = cyl(g, .018, .011, x + .082, y + .024, z + .085, M.gray, 12); knob.rotation.x = Math.PI / 2;
  }
  tube(g, [[-.16, 1.39, .02], [-.21, 1.22, .12], [-.11, 1.13, .15], [-.21, .73, .15], [-.13, .47, .09]], .0035, M.fluid, 36);
  tube(g, [[.16, 1.39, .02], [.21, 1.1, .11], [.10, .89, .15], [.22, .62, .12]], .0035, M.fluid, 32);
}
function recliner(g) {
  for (const x of [-.30, .30]) for (const z of [-.33, .34]) cyl(g, .025, .13, x, .065, z, M.dark, 10);
  box(g, .74, .18, .83, 0, .22, .025, M.brownDark, .05);
  box(g, .62, .14, .63, 0, .40, .10, M.brown, .065, 'seat-cushion');
  const back = box(g, .67, .60, .18, 0, .73, -.31, M.brown, .075, 'reclining-back'); back.rotation.x = -.12;
  box(g, .52, .16, .075, 0, .93, -.185, M.brown, .045, 'headrest');
  for (const x of [-.365, .365]) {
    box(g, .14, .30, .74, x, .43, .03, M.brownDark, .055);
    box(g, .15, .10, .77, x, .61, .03, M.brown, .045, 'padded-arm');
    box(g, .1, .025, .35, x, .669, .12, M.wood, .012);
  }
  box(g, .61, .15, .10, 0, .29, .45, M.brown, .035, 'folded-footrest');
  bar(g, [.43, .31, .18], [.45, .39, .18], .015, M.dark);
}
function bin(p, x, y, z, w, color, id) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.name = id; g.userData = { binId: id, kind: 'supply-bin', evidence: 'app-demo' }; p.add(g);
  box(g, w, .025, .34, 0, 0, 0, color, .009);
  for (const xx of [-w / 2 + .012, w / 2 - .012]) box(g, .024, .17, .34, xx, .09, 0, color, .007);
  box(g, w, .17, .02, 0, .09, -.16, color, .009);
  box(g, w, .105, .027, 0, .057, .16, color, .012, 'bin-front');
  box(g, w * .65, .048, .004, 0, .06, .176, M.paper, .004, 'label-holder');
  for (let i = 0; i < 7; i++) rawbox(g, .002 + i % 2 * .002, .021, .001, -w * .16 + i * .01, .06, .18, M.dark);
  // Unbranded wrapped stock: visible contents establish scale without real product claims.
  for (let i = 0; i < 3; i++) box(g, w * .22, .09 + (i % 2) * .03, .11, -w * .26 + i * w * .26, .075, -.02, M.ivory, .008, 'sample-pack');
  return g;
}
function cabinet(g) {
  box(g, 1.56, 1.93, .025, 0, 1.03, -.24, M.white, .012, 'cabinet-back');
  for (const x of [-.77, .77]) box(g, .035, 1.97, .51, x, 1.025, 0, M.white, .012);
  for (const y of [.08, .48, .88, 1.28, 1.68, 2.0]) box(g, 1.55, .035, .52, 0, y, 0, M.white, .01, 'shelf');
  for (const x of [-.70, .70]) for (const z of [-.18, .18]) cyl(g, .025, .065, x, .033, z, M.gray, 10);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) bin(g, -.57 + col * .38, .105 + row * .40, .035, .33, [M.binBlue, M.binMint, M.binSand][row % 3], `bin-r${row + 1}-c${col + 1}`);
  for (let i = 0; i < 4; i++) {
    box(g, .28, .20, .30, -.57 + i * .38, 1.795, .005, M.ivory, .012, 'bulk-stock-carton');
    box(g, .13, .06, .003, -.57 + i * .38, 1.795, .158, M.paper, .003);
  }
}
function cart(g) {
  for (const x of [-.31, .31]) for (const z of [-.22, .22]) wheel(g, x, z, .06);
  box(g, .72, .65, .52, 0, .52, 0, M.white, .025, 'cart-body');
  box(g, .78, .045, .57, 0, .875, 0, M.gray, .014, 'worktop');
  for (let i = 0; i < 4; i++) {
    const y = .285 + i * .15;
    box(g, .65, .135, .02, 0, y, .273, i === 3 ? M.teal : M.white, .012, `drawer-${i + 1}`);
    bar(g, [-.15, y + .018, .304], [.15, y + .018, .304], .011, M.steel);
    box(g, .08, .028, .003, -.23, y - .02, .286, M.paper, .003);
  }
  for (const x of [-.36, .36]) bar(g, [x, .91, -.25], [x, .91, .24], .012, M.chrome);
  bar(g, [-.36, .91, -.25], [.36, .91, -.25], .012, M.chrome);
  for (const z of [-.18, .18]) bar(g, [.36, .80, z], [.43, .88, z], .012);
  bar(g, [.43, .88, -.18], [.43, .88, .18], .012);
  box(g, .25, .025, .20, -.13, .914, .015, M.blue, .008, 'wrapped-supply-pack');
  box(g, .16, .06, .12, .17, .93, .0, M.ivory, .01);
}
function workstation(g) {
  for (const x of [-.62, .62]) { box(g, .055, .70, .52, x, .36, -.02, M.gray, .01); box(g, .09, .025, .56, x, .0125, -.02, M.dark, .006); }
  box(g, 1.40, .045, .65, 0, .755, 0, M.wood, .025, 'work-surface');
  box(g, 1.29, .25, .025, 0, .58, -.27, M.white, .01);
  box(g, .31, .018, .20, .11, .79, -.13, M.gray, .014);
  bar(g, [.11, .80, -.17], [.11, .97, -.17], .022, M.gray);
  box(g, .47, .28, .035, .11, 1.08, -.16, M.dark, .018, 'workstation-monitor');
  box(g, .435, .245, .004, .11, 1.08, -.14, M.screen, .006);
  // Abstract software UI, never patient data.
  box(g, .067, .209, .003, -.055, 1.08, -.137, M.teal, .003);
  for (let i = 0; i < 5; i++) box(g, .25, .012, .003, .16, 1.16 - i * .037, -.137, i === 0 ? M.blue : M.gray, .002);
  box(g, .38, .017, .125, .10, .79, .15, M.dark, .009, 'keyboard');
  for (let row = 0; row < 3; row++) for (let col = 0; col < 11; col++) rawbox(g, .024, .004, .018, -.05 + col * .03, .800, .111 + row * .03, M.gray);
  box(g, .06, .025, .095, .38, .794, .14, M.gray, .02, 'mouse');
  box(g, .15, .11, .18, -.48, .83, -.12, M.ivory, .012, 'document-holder');
  const chair = new THREE.Group(); chair.name = 'workstation-chair'; chair.position.set(0, 0, .85); g.add(chair);
  mobileBase(chair, .46, .46, true);
  cyl(chair, .029, .25, 0, .31, 0, M.chrome);
  box(chair, .43, .075, .43, 0, .48, 0, M.teal, .055, 'chair-seat');
  bar(chair, [0, .40, .14], [0, .77, .22], .021, M.dark);
  const chairBack = box(chair, .40, .31, .055, 0, .78, .20, M.teal, .045, 'chair-back'); chairBack.rotation.x = .08;
  for (const x of [-.24, .24]) {
    bar(chair, [x * .78, .43, .08], [x, .64, .08], .014, M.dark);
    box(chair, .055, .035, .25, x, .66, -.005, M.dark, .018, 'chair-arm');
  }
}
function sink(g) {
  box(g, .76, .79, .51, 0, .45, 0, M.wood, .016, 'handwash-cabinet');
  box(g, .69, .14, .43, 0, .07, -.01, M.dark, .006);
  for (const x of [-.185, .185]) {
    box(g, .36, .66, .02, x, .47, .265, M.wood, .009);
    box(g, .015, .13, .025, x < 0 ? -.04 : .04, .60, .289, M.chrome, .005);
  }
  // Rim and inset basin, deliberately open rather than a filled solid countertop.
  box(g, .82, .045, .15, 0, .875, -.20, M.ivory, .014);
  box(g, .82, .045, .08, 0, .875, .235, M.ivory, .014);
  for (const x of [-.325, .325]) box(g, .17, .045, .34, x, .875, .015, M.ivory, .012);
  box(g, .48, .025, .32, 0, .765, .01, M.steel, .035, 'basin-bottom');
  for (const x of [-.235, .235]) box(g, .012, .11, .32, x, .82, .01, M.steel, .006);
  for (const z of [-.145, .165]) box(g, .48, .11, .012, 0, .82, z, M.steel, .006);
  cyl(g, .025, .004, 0, .779, .01, M.dark, 16);
  tube(g, [[.0, .90, -.18], [0, 1.04, -.18], [0, 1.09, -.11], [0, 1.06, -.035]], .016, M.chrome, 20);
  box(g, .08, .035, .04, .11, .92, -.19, M.chrome, .008);
  box(g, .07, .11, .07, -.30, .947, -.18, M.white, .013, 'soap-dispenser');
  box(g, .04, .018, .06, -.30, 1.01, -.155, M.gray, .005);
}
function stool(g) {
  mobileBase(g, .42, .42, true); cyl(g, .033, .29, 0, .30, 0, M.chrome);
  cyl(g, .042, .13, 0, .24, 0, M.gray);
  cyl(g, .215, .075, 0, .505, 0, M.teal, 24);
  cyl(g, .19, .02, 0, .455, 0, M.dark, 20);
  bar(g, [.04, .43, 0], [.19, .43, .04], .008, M.dark);
}
const builders = { incubator, warmer, monitor, infusion, recliner, 'supply-cabinet': cabinet, 'supply-cart': cart, workstation, sink, stool,
  ...additionalBuilders({M,mat,box,rawbox,cyl,bar,tube,ring,wheel,mobileBase,controlPanel,monitorHead}) };
// Batch opaque meshes per material, but retain each semantic bin Group for interaction.
// No addon dependency, canvas, or textures; these geometries export cleanly to GLB.
function batchOpaque(group) {
  for (const child of [...group.children]) if (child.isGroup) batchOpaque(child);
  const buckets = new Map();
  for (const child of group.children) {
    if (!child.isMesh || Array.isArray(child.material) || child.material.transparent) continue;
    if (!buckets.has(child.material)) buckets.set(child.material, []);
    buckets.get(child.material).push(child);
  }
  for (const [material, items] of buckets) {
    if (items.length < 2) continue;
    const sources = items.map(item => {
      item.updateMatrix(); const g = item.geometry.index ? item.geometry.toNonIndexed() : item.geometry.clone();
      g.applyMatrix4(item.matrix); return g;
    });
    const geometry = new THREE.BufferGeometry();
    for (const attribute of ['position', 'normal', 'uv']) {
      if (!sources.every(g => g.getAttribute(attribute))) continue;
      const size = sources[0].getAttribute(attribute).itemSize;
      const count = sources.reduce((sum, g) => sum + g.getAttribute(attribute).array.length, 0);
      const array = new Float32Array(count); let offset = 0;
      for (const g of sources) { const data = g.getAttribute(attribute).array; array.set(data, offset); offset += data.length; }
      geometry.setAttribute(attribute, new THREE.BufferAttribute(array, size));
    }
    geometry.computeBoundingSphere();
    for (const item of items) group.remove(item);
    const combined = mesh(group, geometry, material, 0, 0, 0, `${group.name || 'asset'}-batch`);
    combined.userData.partNames = items.map(item => item.name).filter(Boolean);
    for (const source of sources) source.dispose();
  }
}
const assetTemplates = new Map();
export function createAsset(kind) {
  if (!builders[kind]) throw new Error(`Unknown NICU asset: ${kind}`);
  if (!assetTemplates.has(kind)) {
    const g = new THREE.Group(); g.name = kind;
    g.userData = { assetType: kind, units: 'meters', front: '+Z', provenance: 'Original representative model; equipment make and exact Hopkins placement unverified.' };
    if(ADDITIONAL_ASSET_TYPES.includes(kind))Object.assign(g.userData,{role:'static-decoration',tracked:false,upAxis:'Y',provenance:DECORATION_PROVENANCE});
    builders[kind](g); batchOpaque(g); assetTemplates.set(kind, g);
  }
  // Object3D.clone duplicates the node hierarchy and userData while retaining shared
  // immutable geometry/material references, allowing renderer and GLB reuse.
  return assetTemplates.get(kind).clone(true);
}
