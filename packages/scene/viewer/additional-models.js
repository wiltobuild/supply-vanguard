// Original SV-024 models built with the established kit's cached geometry and materials.
// All controls/readouts are abstract geometry, never patient data or operating instructions.
export function additionalBuilders({M,mat,box,rawbox,cyl,bar,tube,ring,wheel,mobileBase,controlPanel,monitorHead}) {
  const purple=mat('#9a7bb6',.61), blueLight=mat('#80b8ed',.35,0,{emissive:'#5188dd',emissiveIntensity:.65});
  const coral=mat('#bf7167',.65), glass=mat('#cde8e9',.19,.03,{transparent:true,opacity:.25,depthWrite:false,side:2});
  const handle=(g,w,y,z,m=M.steel)=>{
    bar(g,[-w/2,y-.08,z],[-w/2,y,z],.012,m);bar(g,[-w/2,y,z],[w/2,y,z],.012,m);bar(g,[w/2,y,z],[w/2,y-.08,z],.012,m);
  };
  const vents=(g,x,y,z,n=6)=>{for(let i=0;i<n;i++)box(g,.045,.007,.003,x+i*.065,y,z,M.dark,.002);};
  const gauge=(g,x,y,z)=>{
    const outer=cyl(g,.044,.018,x,y,z,M.steel,24);outer.rotation.x=Math.PI/2;
    const dial=cyl(g,.035,.02,x,y,z+.005,M.paper,24);dial.rotation.x=Math.PI/2;
    bar(g,[x-.016,y-.012,z+.02],[x+.018,y+.02,z+.02],.0025,M.dark);
    for(const a of [-1,-.5,0,.5,1])bar(g,[x+Math.sin(a)*.026,y+Math.cos(a)*.026,z+.02],[x+Math.sin(a)*.031,y+Math.cos(a)*.031,z+.02],.0015,M.dark);
  };
  const bottle=(g,x,y,z,m=M.paper,h=.14)=>{
    cyl(g,.032,h,x,y+h/2,z,m,16);cyl(g,.026,.025,x,y+h+.012,z,M.gray,16);cyl(g,.018,.012,x,y+h+.03,z,M.ivory,12);
    box(g,.04,.045,.003,x,y+h*.55,z+.033,M.paper,.003);
  };
  const cylinder=(g,x,y,z,height=.48)=>{
    cyl(g,.074,height,x,y+height/2,z,M.teal,20);cyl(g,.06,.035,x,y+height+.01,z,M.steel,16);
    cyl(g,.017,.06,x,y+height+.055,z,M.chrome,12);bar(g,[x-.035,y+height+.075,z],[x+.035,y+height+.075,z],.009,M.dark);
    box(g,.085,.13,.006,x,y+height*.55,z+.073,M.paper,.006);
    for(const yy of [y+.08,y+height-.06]){const b=ring(g,.079,.009,x,yy,z,M.dark);b.rotation.x=Math.PI/2;}
  };
  const drawers=(g,w,d,bottom,count,height,accent=M.teal)=>{
    for(let i=0;i<count;i++){const y=bottom+height*(i+.5);box(g,w,height-.012,.035,0,y,d/2+.018,i===0?accent:M.white,.01);box(g,w*.42,.025,.025,0,y+.018,d/2+.046,M.steel,.006);}
  };
  const jar=(g,x,y,z)=>{
    cyl(g,.074,.24,x,y+.12,z,glass,20);cyl(g,.079,.025,x,y+.255,z,M.teal,20);cyl(g,.061,.08,x,y+.055,z,M.fluid,16);
    for(let i=0;i<5;i++)box(g,.025,.003,.003,x+.022,y+.055+i*.033,z+.074,M.gray,.001);
    cyl(g,.012,.038,x-.025,y+.283,z,M.white,10);cyl(g,.012,.038,x+.025,y+.283,z,M.white,10);
  };
  return {
    'neonatal-ventilator'(g){
      mobileBase(g,.62,.59);cyl(g,.044,.9,0,.64,-.09,M.steel);box(g,.45,.045,.38,0,.5,0,M.white,.025);
      box(g,.48,.24,.34,0,1.02,-.025,M.white,.035,'ventilator-console');controlPanel(g,-.015,1.06,.159,.34,.15);
      vents(g,-.15,.948,.151,5);handle(g,.27,1.19,-.13);
      box(g,.2,.13,.21,-.1,.72,.05,M.teal,.018,'heated-humidifier');jar(g,-.1,.79,.05);
      box(g,.14,.13,.18,.18,.72,-.05,M.white,.018);gauge(g,.17,.75,.053);
      for(const x of [-.105,.015]){cyl(g,.021,.035,x,.99,.19,M.blue,12).rotation.x=Math.PI/2;}
      bar(g,[.18,1.11,-.07],[.32,1.42,.01],.014);bar(g,[.32,1.42,.01],[.32,1.42,.38],.014);
      tube(g,[[-.1,1,.21],[-.24,.8,.24],[-.08,1.22,.32],[.22,1.38,.4],[.34,1.16,.46]],.015,M.blue,42);
      tube(g,[[.015,1,.21],[.12,.76,.3],[.27,1.18,.36],[.3,1.36,.43],[.34,1.16,.46]],.014,M.ivory,42);
      box(g,.06,.045,.055,.34,1.15,.46,M.white,.012,'circuit-connector');
    },
    'cpap-stand'(g){
      mobileBase(g,.56,.56,true);cyl(g,.027,1.34,0,.84,0,M.chrome);box(g,.29,.28,.15,0,1.35,.02,M.white,.026,'cpap-flow-unit');
      for(const x of [-.073,.073]){box(g,.035,.17,.025,x,1.38,.105,glass,.005);cyl(g,.012,.022,x,1.29,.128,M.teal,12).rotation.x=Math.PI/2;box(g,.018,.014,.008,x,1.39,.12,M.green,.002);}
      box(g,.35,.035,.3,0,.87,0,M.white,.015);jar(g,.06,.9,.02);gauge(g,-.09,1.18,.112);
      tube(g,[[-.08,1.46,.11],[-.24,1.52,.2],[-.27,1.08,.33],[.05,1.02,.38],[.13,1.2,.29]],.014,M.blue,40);
      tube(g,[[.08,1.46,.11],[.22,1.36,.15],[.15,1.21,.16],[.085,1.19,.02]],.013,M.ivory,28);
      box(g,.09,.05,.06,.13,1.2,.29,M.white,.018,'illustrative-nasal-interface');
      box(g,.18,.21,.12,0,.58,.03,M.teal,.02);handle(g,.24,1.58,-.02);
    },
    'phototherapy-light'(g){
      mobileBase(g,.61,.62);cyl(g,.035,1.1,0,.73,-.16,M.chrome);cyl(g,.048,.47,0,.43,-.16,M.white);
      box(g,.13,.15,.12,0,1.24,-.16,M.teal,.024);bar(g,[0,1.29,-.16],[0,1.72,.04],.028,M.white);
      bar(g,[0,1.72,.04],[0,1.72,.36],.024,M.steel);cyl(g,.055,.08,0,1.72,.36,M.gray).rotation.z=Math.PI/2;
      box(g,.44,.08,.3,0,1.71,.43,M.white,.035,'phototherapy-head');box(g,.37,.012,.235,0,1.664,.43,M.dark,.02);
      for(const x of [-.135,-.045,.045,.135])for(const z of [.35,.43,.51])cyl(g,.018,.009,x,1.654,z,blueLight,12);
      controlPanel(g,0,1.25,-.089,.09,.07);tube(g,[[0,.37,-.21],[.06,.91,-.22],[.07,1.5,-.08],[.07,1.7,.37]],.006,M.dark,24);
    },
    'ultrasound-cart'(g){
      mobileBase(g,.63,.68);box(g,.4,.58,.43,0,.55,-.04,M.white,.035,'ultrasound-cart-body');
      box(g,.44,.06,.48,0,.3,-.02,M.teal,.025);vents(g,-.14,.68,.181,5);vents(g,-.14,.64,.181,5);
      box(g,.6,.085,.46,0,.94,.04,M.white,.03,'console');box(g,.46,.016,.27,0,.993,.09,M.gray,.015);
      for(let row=0;row<3;row++)for(let col=0;col<9;col++)box(g,.026,.008,.021,-.175+col*.043,1.005,-.005+row*.04,M.ivory,.003);
      cyl(g,.031,.013,.11,1.009,.177,M.blue,20);for(const x of [-.19,-.11,-.03])cyl(g,.013,.017,x,1.01,.18,M.dark,12);
      bar(g,[0,1,-.16],[0,1.23,-.14],.029);box(g,.49,.33,.06,0,1.4,-.14,M.white,.025);box(g,.43,.265,.008,0,1.405,-.105,M.screen,.012);
      // Neutral fan-shaped scan graphic without patient information.
      for(let i=0;i<12;i++){const y=1.48-i*.015,w=.04+i*.022;box(g,w,.005,.003,0,y,-.099,i%3===0?M.gray:M.steel,.001);}
      for(const x of [-.32,.32]){ring(g,.04,.009,x,.97,.05,M.teal);box(g,.05,.16,.05,x,.99,.05,M.white,.018,'ultrasound-probe');tube(g,[[x,.91,.05],[x*.97,.54,.15],[x*.8,.48,.21],[x*.75,.82,.16]],.007,M.gray,28);}
      handle(g,.45,.89,.3);
    },
    'portable-xray'(g){
      mobileBase(g,.68,.9);box(g,.59,.52,.68,0,.48,-.12,M.white,.055,'mobile-generator');
      box(g,.62,.085,.72,0,.25,-.12,M.teal,.025);controlPanel(g,0,.7,.237,.34,.11);vents(g,-.19,.42,.226,7);
      box(g,.15,1.29,.18,0,1.03,-.37,M.white,.03,'xray-column');box(g,.17,.18,.2,0,1.51,-.37,M.gray,.025);
      bar(g,[0,1.52,-.37],[0,1.8,.04],.06,M.white);bar(g,[0,1.8,.04],[0,1.57,.47],.048,M.white);
      for(const [y,z] of [[1.52,-.37],[1.8,.04],[1.57,.47]])cyl(g,.065,.16,0,y,z,M.teal,20).rotation.z=Math.PI/2;
      box(g,.26,.22,.29,0,1.43,.48,M.white,.035,'xray-tube-head');box(g,.14,.1,.15,0,1.275,.48,M.dark,.018,'collimator');
      tube(g,[[.07,.69,-.4],[.1,1.31,-.43],[.1,1.84,.03],[.1,1.6,.49]],.014,M.dark,32);
      box(g,.43,.035,.025,0,.95,-.52,M.steel,.008);bar(g,[-.215,.7,-.42],[-.215,.95,-.52],.018);bar(g,[.215,.7,-.42],[.215,.95,-.52],.018);
      box(g,.43,.39,.04,0,.5,-.48,M.gray,.018,'detector-storage');
    },
    'transport-incubator'(g){
      mobileBase(g,.64,1.22);for(const x of [-.23,.23]){bar(g,[x,.22,-.43],[x,.76,.43],.028);bar(g,[x,.22,.43],[x,.76,-.43],.028);}
      box(g,.62,.1,1.15,0,.8,0,M.white,.035,'transport-deck');box(g,.53,.045,.91,0,.885,.015,M.ivory,.03,'transport-mattress');
      for(const x of [-.295,.295])box(g,.015,.37,1.03,x,1.08,0,glass,.009,'transparent-hood');
      for(const z of [-.515,.515])box(g,.6,.37,.015,0,1.08,z,glass,.009);
      box(g,.6,.025,1.04,0,1.278,0,glass,.02);for(const z of [-.51,.51])bar(g,[-.3,1.29,z],[.3,1.29,z],.009,M.white);
      for(const x of [-.305,.305])for(const z of [-.22,.22])ring(g,.075,.01,x,1.08,z,M.ivory,Math.PI/2);
      controlPanel(g,0,.794,.592,.29,.08);for(const z of [-.64,.64])handle(g,.45,.87,z);
      for(const x of [-.14,.14]){const c=cyl(g,.064,.62,x,.46,-.02,M.teal,20);c.rotation.x=Math.PI/2;cyl(g,.023,.05,x,.46,.32,M.steel).rotation.x=Math.PI/2;box(g,.09,.06,.17,x,.46,-.015,M.paper,.004);}
      box(g,.45,.11,.28,0,.63,-.26,M.gray,.015,'transport-battery');
    },
    'infant-scale'(g){
      mobileBase(g,.66,.52);box(g,.49,.57,.4,0,.54,0,M.white,.028);drawers(g,.46,.4,.29,2,.23);
      box(g,.7,.075,.47,0,.88,0,M.teal,.025);box(g,.68,.035,.43,0,.942,0,M.ivory,.025,'weighing-tray');
      for(const x of [-.345,.345]){const b=box(g,.055,.11,.43,x,.988,0,M.white,.025);b.rotation.z=x<0?-.25:.25;}
      for(const z of [-.217,.217])box(g,.66,.065,.027,0,.969,z,M.white,.012);
      controlPanel(g,0,.879,.251,.24,.055);box(g,.31,.003,.25,0,.962,0,M.paper,.015);
    },
    'feeding-pump-stand'(g){
      mobileBase(g,.54,.54,true);cyl(g,.025,1.48,0,.89,0,M.chrome);
      bar(g,[-.17,1.65,0],[.17,1.65,0],.011);for(const x of [-.17,.17])tube(g,[[x,1.65,0],[x,1.59,.015],[x*.75,1.59,.025]],.008,M.steel,12);
      box(g,.18,.26,.065,-.115,1.41,.035,M.fluid,.03,'enteral-feed-bag');box(g,.12,.1,.003,-.115,1.43,.07,M.paper,.01);
      cyl(g,.014,.045,-.115,1.258,.035,purple,12);box(g,.24,.23,.13,.015,1.03,.045,purple,.035,'enteral-pump');
      controlPanel(g,.015,1.075,.117,.17,.1);box(g,.14,.06,.01,.015,.969,.119,M.ivory,.014,'enteral-cassette');
      tube(g,[[-.115,1.24,.035],[-.16,1.12,.12],[-.07,.98,.135],[.1,.95,.14],[.17,.59,.15],[.28,.52,.14]],.006,purple,34);
      cyl(g,.012,.04,.28,.52,.14,purple,10).rotation.z=Math.PI/2;
      box(g,.24,.06,.19,0,.68,.02,M.white,.014);box(g,.11,.035,.05,0,.72,.03,purple,.008);
    },
    'portable-suction'(g){
      mobileBase(g,.5,.47);box(g,.43,.035,.38,0,.62,0,M.white,.018);for(const x of [-.18,.18])bar(g,[x,.2,-.12],[x,.61,-.12],.018);
      box(g,.38,.21,.27,0,.76,-.07,M.white,.025,'suction-pump');handle(g,.23,.93,-.07);gauge(g,-.065,.78,.075);
      cyl(g,.026,.023,.105,.78,.083,M.teal,16).rotation.x=Math.PI/2;vents(g,-.11,.695,.071,4);
      for(const x of [-.115,.115]){jar(g,x,.31,.035);bar(g,[x,.61,0],[x,.58,.035],.014,M.gray);}
      tube(g,[[-.14,.6,.035],[-.23,.67,.08],[-.16,.79,.1]],.009,M.ivory,20);
      tube(g,[[.14,.6,.035],[.27,.68,.1],[.27,.31,.18],[.07,.24,.22],[-.11,.38,.2]],.008,M.blue,32);
    },
    'resuscitation-cart'(g){
      mobileBase(g,.72,.55);box(g,.65,.67,.45,0,.575,0,M.white,.028);drawers(g,.62,.45,.26,4,.15,coral);
      for(const x of [-.31,.31])box(g,.025,.64,.035,x,.59,.25,coral,.008);
      box(g,.7,.045,.51,0,.94,0,M.steel,.02);for(const z of [-.24,.24])bar(g,[-.33,1.04,z],[.33,1.04,z],.009);
      for(const x of [-.33,.33]){bar(g,[x,.96,-.24],[x,1.04,-.24],.009);bar(g,[x,1.04,-.24],[x,1.04,.24],.009);}
      box(g,.28,.1,.2,-.12,1.005,-.02,M.teal,.028,'resuscitation-kit');const bag=cyl(g,.055,.17,.15,1.015,.07,M.blue,20);bag.rotation.z=Math.PI/2;
      box(g,.09,.045,.075,.24,1.015,.07,glass,.025,'mask');cylinder(g,.41,.25,-.04,.47);
      bar(g,[-.4,.83,-.18],[-.4,.83,.18],.018);box(g,.1,.17,.03,.0,.72,.272,coral,.006,'illustrative-seal');
    },
    'milk-refrigerator'(g){
      for(const x of [-.26,.26])for(const z of [-.24,.24])cyl(g,.025,.07,x,.035,z,M.dark,12);
      for(const x of [-.295,.295])box(g,.05,1.49,.59,x,.815,0,M.white,.015,'refrigerator-side');
      for(const y of [.16,1.46])box(g,.59,.19,.59,0,y,0,M.white,.02);
      box(g,.55,1.13,.04,0,.82,-.275,M.dark,.012,'recessed-interior');
      for(const x of [-.257,.257])box(g,.035,1.14,.035,x,.84,.312,M.teal,.008);
      for(const y of [.285,1.395])box(g,.55,.035,.035,0,y,.312,M.teal,.008);
      box(g,.46,1.04,.02,0,.84,.335,glass,.015,'glazed-door');
      for(const y of [.35,.67,.99]){box(g,.45,.018,.42,0,y,.015,M.steel,.004);for(const x of [-.14,0,.14])bottle(g,x,y+.014,.14,M.ivory,.14);}
      bar(g,[.265,.7,.366],[.265,1.05,.366],.015,M.chrome);controlPanel(g,0,1.46,.306,.27,.075);
      vents(g,-.22,.16,.3,8);box(g,.32,.038,.005,0,1.3,.351,M.paper,.006);
    },
    'milk-preparation-counter'(g){
      for(const x of [-.58,.58])for(const z of [-.23,.23])cyl(g,.026,.13,x,.065,z,M.steel,12);
      box(g,1.24,.69,.53,0,.475,0,M.white,.025);box(g,1.32,.065,.62,0,.85,0,M.steel,.018,'prep-worktop');
      box(g,1.3,.13,.025,0,.94,-.298,M.steel,.008,'backsplash');
      for(const x of [-.31,.31]){box(g,.595,.62,.025,x,.49,.28,M.white,.012);box(g,.16,.022,.025,x,.72,.302,M.teal,.005);}
      box(g,.4,.015,.31,-.32,.892,.03,M.ivory,.012,'prep-mat');box(g,.42,.04,.28,.32,.905,.01,M.teal,.008,'bottle-rack');
      for(const x of [.2,.32,.44])for(const z of [-.06,.07]){bottle(g,x,.93,z,M.ivory,.12);ring(g,.039,.005,x,.935,z,M.gray).rotation.x=Math.PI/2;}
      box(g,.18,.17,.18,-.38,.982,-.06,M.white,.02,'closed-supply-container');box(g,.19,.022,.19,-.38,1.078,-.06,M.teal,.008);
    },
    'equipment-charging-station'(g){
      for(const x of [-.46,.46])for(const z of [-.18,.18])cyl(g,.024,.06,x,.03,z,M.dark,12);
      box(g,.99,.1,.45,0,.11,0,M.gray,.015);box(g,.99,.06,.45,0,1.48,0,M.white,.015);
      for(const x of [-.47,.47])box(g,.05,1.34,.45,x,.78,0,M.white,.014);box(g,.9,1.31,.025,0,.79,-.216,M.teal,.01);
      for(const y of [.22,.62,1.02]){box(g,.91,.035,.42,0,y,0,M.white,.012);for(const x of [-.29,0,.29]){box(g,.23,.035,.27,x,y+.037,.01,M.dark,.008,'charging-dock');box(g,.17,.2,.11,x,y+.15,-.04,M.white,.018);controlPanel(g,x,y+.17,.021,.12,.075);tube(g,[[x,y+.12,-.11],[x+.08,y+.1,-.17],[x+.08,y+.26,-.19]],.004,M.dark,14);}}
      box(g,.7,.04,.008,0,1.42,.229,M.teal,.005,'charging-station-strip');
    },
    'soiled-equipment-rack'(g){
      mobileBase(g,.68,.49);for(const x of [-.29,.29])for(const z of [-.18,.18])bar(g,[x,.19,z],[x,1.41,z],.017,M.steel);
      for(const y of [.33,.76,1.19]){box(g,.59,.03,.39,0,y,0,M.steel,.006);box(g,.55,.08,.35,0,y+.052,0,M.gray,.014);box(g,.46,.012,.26,0,y+.098,0,M.brownDark,.008);for(const z of [-.18,.18])bar(g,[-.28,y+.15,z],[.28,y+.15,z],.009,M.steel);}
      box(g,.22,.23,.22,-.12,.49,.0,coral,.02,'covered-collection-bin');box(g,.24,.025,.24,-.12,.618,0,M.gray,.01);
      box(g,.18,.04,.19,.1,.88,.01,M.white,.016);tube(g,[[-.12,1.3,.03],[-.2,1.34,.08],[.05,1.32,.1],[.18,1.3,-.07]],.011,M.gray,24);
      box(g,.44,.17,.025,0,1.34,.205,coral,.012,'soiled-equipment-designation');box(g,.31,.025,.004,0,1.34,.222,M.paper,.003);
      handle(g,.5,1.51,-.19);
    },
    'wall-ppe-dispenser'(g){
      // Origin is the floor directly below the mounting plate; bottom of case is 1.05 m.
      box(g,.57,.73,.035,0,1.415,0,M.steel,.018,'wall-mounting-plate');
      for(const [x,m] of [[-.18,M.binBlue],[0,M.binMint],[.18,M.binSand]]){
        box(g,.165,.21,.13,x,1.18,.08,M.white,.012,'glove-box-holder');box(g,.14,.16,.015,x,1.18,.154,m,.008);
        box(g,.09,.028,.004,x,1.16,.164,M.dark,.012);box(g,.04,.024,.018,x,1.147,.172,M.ivory,.006);
      }
      box(g,.54,.19,.14,0,1.41,.08,M.white,.012,'mask-compartment');box(g,.47,.11,.008,0,1.42,.156,M.blue,.006);
      for(let i=0;i<4;i++)box(g,.39,.003,.004,0,1.39+i*.018,.163,M.ivory,.001);
      box(g,.54,.21,.15,0,1.63,.085,M.white,.012,'gown-compartment');box(g,.45,.12,.012,0,1.62,.167,M.binMint,.012);box(g,.15,.027,.005,0,1.68,.178,M.paper,.003);
    }
  };
}
