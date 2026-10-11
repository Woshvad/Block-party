"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera, Html } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { box, cyl, ball, type Part } from "./geo";
import { furnitureGeometry } from "./furnitureGeometry";
import { PerfProbe } from "./PerfHud";
import { INITIAL_ITEMS, START, DESTINATIONS, placementError, restoreLayout, walkPath, type ApartmentItem, type Point } from "./apartmentLayout";
import HomeDisplay from "./HomeDisplay";
import { previewHomeApi } from "./homeDisplayFixture";

// Static shell; editable furniture is rendered from the shared preview layout model.
function apartmentGeometry() {
  const parts: Part[] = [];
  const cream = "#f1e5cf", oak = "#ac7950", green = "#658376", pink = "#d6a498", brass = "#b69553";
  const b = (x:number,y:number,z:number,w:number,h:number,d:number,c:string) => parts.push(box(x,y,z,w,h,d,c));
  const c = (x:number,y:number,z:number,r:number,h:number,col:string) => parts.push(cyl(x,y,z,r,r,h,col,20));
  const item = (id:string,x:number,z:number,w:number,h:number,d:number,color:string,rot=0) => {
    parts.push(furnitureGeometry(id,w,h,d,color).rotateY(rot).translate(x,h/2+.04,z));
  };
  // Raised dollhouse foundation, oak parquet and contrasting terrazzo service rooms.
  b(0,-.22,0,12.3,.42,10.3,"#bb9c80");
  b(0,-.02,0,12,.12,10,oak);
  for(let x=0;x<24;x++) for(let z=0;z<10;z++) b(-5.75+x*.5,.05,-4.5+z,.48,.025,.98,["#c9996c","#d0a479","#c39165"][(x+z)%3]!);
  b(3.6,.075,-2.9,4.7,.05,4.1,"#d6d8c9");
  for(let x=0;x<7;x++) for(let z=0;z<6;z++) b(1.45+x*.69,.105,-4.62+z*.64,.665,.018,.615,(x+z)%2 ? "#f0ebde" : "#d8dcd0");
  // Tall back/left walls, low front edge, and internal partitions with real gaps.
  b(0,1.5,-5,12.2,3,.16,"#d8b299"); b(-6,1.5,0,.16,3,10,"#e1bda5");
  b(0,.12,5,12.2,.24,.14,cream); b(6,.12,0,.14,.24,10,cream);
  b(0,3.02,-5,12.3,.12,.23,cream); b(-6,3.02,0,.23,.12,10.1,cream);
  b(1.1,1.1,-3.55,.14,2.2,2.9,"#ded2bb"); b(1.1,.65,-.55,.14,1.3,1.1,"#ded2bb");
  b(-3.7,.58,-.95,4.5,1.16,.12,"#dfc6b0");
  b(3.1,.6,-.85,2.3,1.2,.13,"#ded2bb");
  for(const x of [-4.4,-2.3,3.9]) {
    b(x,1.85,-4.89,1.55,1.55,.08,cream); b(x,1.85,-4.83,1.35,1.35,.035,"#a7c6c5");
    b(x,1.85,-4.79,.055,1.38,.045,cream); b(x,1.85,-4.79,1.4,.05,.045,cream);
    b(x,1.08,-4.69,1.72,.1,.35,cream);
  }
  // Bedroom: upholstered bed, blanket stripes, bedside lamps, open wardrobe.


  for(const x of [-5.12,-1.65]) { item("table",x,-3.9,.7,.6,.7,oak); c(x,.71,-3.9,.11,.18,brass); c(x,.94,-3.9,.23,.3,cream); }
  b(-.15,1.2,-4.45,1.7,2.4,.8,cream); b(-.15,1.2,-4,1.5,2.14,.05,"#97724e");
  for(let i=0;i<6;i++) b(-.75+i*.23,1.55,-3.92,.16,.93,.23,[green,pink,cream,"#3e5655"][i%4]!);
  b(-.15,.48,-3.86,1.5,.09,.4,cream); b(-.15,2.15,-3.86,1.5,.09,.4,cream);
  // Bathroom: inset bath, basin, mirror, toilet and folded towels.
  b(4.85,.38,-3.65,1.7,.7,2.25,cream); b(4.85,.75,-3.65,1.4,.1,1.95,"#bdd3ce");
  b(4.85,.78,-3.65,1.17,.055,1.64,"#91b9b2"); c(5.5,1,-4.2,.045,.45,brass);
  b(2.05,.48,-4.25,1.2,.96,1,oak); b(2.05,.98,-4.25,1.3,.12,1.1,cream); b(2.05,1.05,-4.23,.78,.05,.58,"#a1bbb4");
  b(2.05,1.94,-4.85,1.2,1.32,.12,brass); b(2.05,1.94,-4.76,1.07,1.19,.03,"#c5d9d2");
  c(2.15,.3,-2.2,.37,.5,cream); b(2.15,.9,-2.6,.7,.7,.22,cream); c(2.15,.58,-2.1,.43,.12,"#faf4e4");
  // Living room: generous rug, sectional, nested tables and media wall.
  item("rug",-3,2,4.8,.04,4.8,"#ddd7b8");
  for(const x of [-5.1,-.9]) b(x,.095,2,.04,.015,4.3,"#738376");







  // Kitchen: sage cabinets with brass pulls, hob, sink and island stools.
  for(let i=0;i<4;i++) {
    const z=.1+i*.95; b(5.35,.5,z,1.2,1,.91,green); b(5.35,1.06,z,1.32,.13,.95,cream);
    b(4.72,.6,z,.025,.06,.28,brass);
  }
  b(5.33,1.14,.2,.85,.035,.7,"#263e39");
  for(const x of [5.1,5.55]) for(const z of [-.02,.4]) c(x,1.17,z,.13,.018,"#777e73");
  b(5.34,1.14,2.02,.85,.03,.68,"#9bb9b1"); c(5.7,1.32,2,.025,.38,brass);
  b(3.15,.51,1.1,1.45,1.02,2.55,"#7c6248"); b(3.05,1.08,1.1,1.8,.15,2.8,cream);
  for(const z of [.25,1.75]) { c(1.77,.43,z,.035,.86,brass); c(1.77,.14,z,.3,.05,brass); c(1.77,.87,z,.32,.1,pink); }
  c(3,1.22,.45,.15,.2,"#b4754e"); parts.push(ball(3,1.45,.45,.24,green,1));
  // Dining nook, flowers and framed receipt collection.
  c(2.7,.47,3.85,.17,.94,oak); c(2.7,.98,3.85,1.04,.12,oak);
  for(const x of [1.25,4.15]) { item("stool",x,3.85,.65,.6,.65,green); b(x,.87,4.12,.65,.58,.08,green); }
  c(2.7,1.14,3.85,.12,.24,cream); parts.push(ball(2.7,1.4,3.85,.2,pink,1));
  for(let i=0;i<3;i++) { b(-5.87,1.95,-.05+i*.65,.06,.52,.46,brass); b(-5.82,1.95,-.05+i*.65,.03,.43,.37,cream); }

  const merged = mergeGeometries(parts,false)!; parts.forEach((p)=>p.dispose()); return merged;
}
function Fit() {
  const {camera,size} = useThree();
  useEffect(()=>{camera.position.set(13,15,18);camera.lookAt(0,.3,0);},[camera]);
  useEffect(()=> { (camera as THREE.OrthographicCamera).zoom = Math.min(size.width/18.5,size.height/16); camera.updateProjectionMatrix(); },[camera,size]);
  return null;
}
function Apartment({night,labels}:{night:boolean;labels:boolean}) {
  const geometry = useMemo(apartmentGeometry,[]);
  useEffect(()=>{ return ()=>geometry.dispose(); },[geometry]);
  return <>
    <color attach="background" args={[night ? "#283c3e" : "#dce5d6"]}/>
    <hemisphereLight args={[night ? "#b4c8e2" : "#fff9e9","#a08060",night ? .9 : 1.9]}/>
    <directionalLight position={[-3,12,8]} intensity={night ? .6 : 2.6} color="#ffe2b6" castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={12} shadow-camera-bottom={-12} shadow-normalBias={.035}/>
    {night && <><pointLight position={[-3,3,-2]} intensity={28} distance={10} color="#ffd19b"/><pointLight position={[3,3,2]} intensity={22} distance={9} color="#ffdaa5"/></>}
    <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial vertexColors roughness={.82}/></mesh>
    <mesh rotation-x={-Math.PI/2} position-y={-.46} receiveShadow><circleGeometry args={[15,64]}/><meshStandardMaterial color={night ? "#334847" : "#cedbc3"}/></mesh>
    {labels && ([[-3,-3,"01 / REST"],[3.9,-3,"02 / RESET"],[-3,2,"03 / CONNECT"],[3,2,"04 / GATHER"]] as const).map(([x,z,t])=><Html key={t} position={[x,2.7,z]} center><span className="apartment-label">{t}</span></Html>)}
  </>;
}
function Movable({item,selected,onSelect}:{item:ApartmentItem;selected:boolean;onSelect:()=>void}) {
  const geometry=useMemo(()=>{
    const parts=[furnitureGeometry(item.kind,item.w,item.h,item.d,item.color).translate(0,item.h/2+.04,0)];
    if(item.id==='bed') for(let i=0;i<5;i++) parts.push(box(-.95+i*.47,.83,.57,.035,.01,1.6,"#a7b9a2"));
    if(item.id==='sofa') for(const x of [-1.05,1.1]) parts.push(box(x,.82,.11,.5,.4,.2,"#f1e5cf"));
    if(item.id==='coffee') parts.push(box(-.3,.57,-.05,.55,.07,.4,"#f1e5cf"),box(-.25,.64,-.05,.46,.06,.34,"#658376"),cyl(.5,.68,0,.11,.11,.28,"#b69553"));
    const g=mergeGeometries(parts,false)!;parts.forEach(p=>p.dispose());return g;
  },[item.id,item.kind,item.w,item.h,item.d,item.color]);
  useEffect(()=>{ return ()=>geometry.dispose(); },[geometry]);
  return <group position={[item.x,0,item.z]} rotation-y={item.turn*Math.PI/2}>
    <mesh geometry={geometry} castShadow receiveShadow onClick={e=>{e.stopPropagation();if(e.delta<5)onSelect();}}><meshStandardMaterial vertexColors roughness={.82}/></mesh>
    {selected && <mesh rotation-x={-Math.PI/2} position-y={.14}><planeGeometry args={[item.w+.15,item.d+.15]}/><meshBasicMaterial color="#d2e96b" transparent opacity={.45} depthWrite={false}/></mesh>}
  </group>;
}
function Resident({path,onArrive}:{path:Point[];onArrive:(p:Point)=>void}) {
  const group=useRef<THREE.Group>(null), index=useRef(1), notified=useRef(false);
  const residentGeometry=useMemo(()=>{
    const parts=[cyl(0,.52,0,.14,.2,.52,"#658376"),ball(0,.97,0,.18,"#d8a17c"),ball(0,1.07,-.02,.18,"#45372e",.6),box(-.1,.19,0,.12,.32,.15,"#3e4944"),box(.1,.19,0,.12,.32,.15,"#3e4944")];
    const g=mergeGeometries(parts,false)!;parts.forEach(p=>p.dispose());return g;
  },[]);
  useEffect(()=>{ return ()=>residentGeometry.dispose(); },[residentGeometry]);
  useEffect(()=>{index.current=1;notified.current=false;if(group.current && path[0])group.current.position.set(path[0].x,.12,path[0].z);},[path]);
  useFrame((_,delta)=>{
    const g=group.current, target=path[index.current];if(!g||!target)return;
    const dx=target.x-g.position.x,dz=target.z-g.position.z,dist=Math.hypot(dx,dz),step=Math.min(delta,.05)*2.2;
    if(dist<=step){g.position.x=target.x;g.position.z=target.z;index.current++;if(index.current===path.length&&!notified.current){notified.current=true;onArrive(target);}}
    else {g.position.x+=dx/dist*step;g.position.z+=dz/dist*step;g.rotation.y=Math.atan2(dx,dz);}
  });
  return <group ref={group} position={[START.x,.12,START.z]}><mesh geometry={residentGeometry} castShadow><meshStandardMaterial vertexColors roughness={.9}/></mesh><mesh rotation-x={-Math.PI/2} position-y={.015}><ringGeometry args={[.23,.29,24]}/><meshBasicMaterial color="#faf8df"/></mesh></group>;
}
const SAVE_KEY='block-party:apartment-preview:v1';
export default function ShowcaseApartment() {
  const [night,setNight]=useState(false), [labels,setLabels]=useState(false), [reset,setReset]=useState(0);
  const [items,setItems]=useState<ApartmentItem[]>(INITIAL_ITEMS),[selected,setSelected]=useState('coffee'),[editing,setEditing]=useState(false);
  const [history,setHistory]=useState<ApartmentItem[][]>([]),[status,setStatus]=useState('Choose a destination, or tap an open floor to walk.');
  const [position,setPosition]=useState<Point>(START),[path,setPath]=useState<Point[]>([START]),[walking,setWalking]=useState(false);
  const [display,setDisplay]=useState<'tv'|'trophy_wall'|null>(null);
  const perf=useRef<HTMLDivElement>(null);
  useEffect(()=>{try{const raw=localStorage.getItem(SAVE_KEY);if(raw){const saved=restoreLayout(raw);if(saved){setItems(saved);setStatus('Your saved preview layout is ready.');}else setStatus('Saved layout was incompatible. Loaded the original apartment.');}}catch{setStatus('Browser storage unavailable. You can still edit this session.');}},[]);
  const active=items.find(i=>i.id===selected)!;
  function update(candidate:ApartmentItem) {
    const error=placementError(candidate,items);if(error){setStatus(error);return;}
    setHistory(h=>[...h.slice(-29),items]);setItems(items.map(i=>i.id===candidate.id?candidate:i));setStatus(`${candidate.name} moved. Save to keep this layout on this browser.`);
  }
  function walk(to:Point) {
    if(walking)return;
    const next=walkPath(position,to,items);if(!next){setStatus('That spot is blocked. Choose an open floor or a room below.');return;}
    setPath(next);setWalking(next.length>1);setStatus(next.length>1?'On my way…':'Already here.');
  }
  function toggleEdit() {if(walking)return;setEditing(!editing);setPosition(START);setPath([START]);setStatus(editing?'Tap an open floor to walk.':'Choose furniture, then tap a new floor position or use the move buttons.');}
  function save() {try{localStorage.setItem(SAVE_KEY,JSON.stringify(items.map(({id,x,z,turn})=>({id,x,z,turn}))));setStatus('Saved on this browser. Resident homes are unchanged.');}catch{setStatus('Could not save: browser storage is unavailable. Your current edits are still here.');}}
  const onFloor=(p:Point)=>{if(editing)update({...active,x:Math.round(p.x*4)/4,z:Math.round(p.z*4)/4});else walk(p);};
  return <main className={`apartment-preview ${night ? "is-night" : ""}`}>
    <Canvas shadows dpr={[1,1.5]}><OrthographicCamera makeDefault position={[13,15,18]} near={.1} far={100}/><Fit key={`fit-${reset}`}/><Apartment night={night} labels={labels}/>
      <mesh rotation-x={-Math.PI/2} position-y={.13} onClick={e=>{if(e.delta<5){e.stopPropagation();onFloor({x:e.point.x,z:e.point.z});}}}><planeGeometry args={[11.8,9.8]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/></mesh>
      {items.map(item=><Movable key={item.id} item={item} selected={editing&&selected===item.id} onSelect={()=>{if(editing){setSelected(item.id);setStatus(`${item.name} selected.`);}else if(item.id==='tv')setDisplay('tv');else setStatus('Choose Arrange to move furniture.');}}/>)}
      <Resident path={path} onArrive={p=>{setPosition(p);setWalking(false);setStatus('Made it. Where next?');}}/>
      <mesh position={[-5.77,1.95,.6]} onClick={e=>{e.stopPropagation();if(e.delta<5&&!editing)setDisplay('trophy_wall');}}><boxGeometry args={[.08,.6,1.9]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/></mesh>
      <OrbitControls key={`orbit-${reset}`} target={[0,.3,0]} minPolarAngle={.3} maxPolarAngle={1.18} minZoom={8} maxZoom={100} enablePan={false}/><PerfProbe target={perf}/>
    </Canvas>
    <header className="apartment-header"><span className="eyebrow">BLOCK PARTY / HOME STUDIES / 001</span><h1>The Sunday Apartment.</h1><p>Warm oak. Soft sage. A place for your people.</p><span className="apartment-prototype">Interactive study · saved on this browser</span></header>
    <section className="apartment-tools" aria-label={editing?'Furniture editor':'Explore the apartment'}>
      <div className="apartment-mode"><button aria-pressed={!editing} disabled={walking} onClick={()=>{if(editing)toggleEdit();}}>Explore</button><button aria-pressed={editing} disabled={walking} onClick={()=>{if(!editing)toggleEdit();}}>Arrange</button></div>
      {editing ? <><label className="apartment-select">Furniture<select value={selected} onChange={e=>{setSelected(e.target.value);setStatus(`${items.find(i=>i.id===e.target.value)!.name} selected.`);}}>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <div className="apartment-moves" aria-label="Move selected furniture"><button aria-label="Move west" onClick={()=>update({...active,x:active.x-.25})}>←</button><button aria-label="Move north" onClick={()=>update({...active,z:active.z-.25})}>↑</button><button aria-label="Move south" onClick={()=>update({...active,z:active.z+.25})}>↓</button><button aria-label="Move east" onClick={()=>update({...active,x:active.x+.25})}>→</button><button onClick={()=>update({...active,turn:(active.turn+1)%4})}>Rotate</button></div>
        <div className="apartment-actions"><button disabled={!history.length} onClick={()=>{setItems(history[history.length-1]!);setHistory(history.slice(0,-1));setStatus('Last change undone. Save to keep it.');}}>Undo</button><button onClick={()=>{setHistory(h=>[...h.slice(-29),items]);setItems(INITIAL_ITEMS);setStatus('Original layout restored. Save to keep it.');}}>Reset layout</button><button className="apartment-save" onClick={save}>Save layout</button></div>
      </> : <><div className="apartment-destinations">{DESTINATIONS.map(d=><button key={d.name} disabled={walking} onClick={()=>walk(d)}>{d.name}</button>)}</div><div className="apartment-actions"><button onClick={()=>setDisplay('tv')}>Watch TV ↗</button><button onClick={()=>setDisplay('trophy_wall')}>Trophy wall ↗</button></div><small>TV & receipts use sample data in this study.</small></>}
      <p role="status" className="apartment-status">{status}</p>
    </section>
    <nav className="apartment-dock" aria-label="Apartment preview"><button onClick={()=>setNight(!night)}>{night ? "Daylight" : "Evening"}</button><button aria-pressed={labels} onClick={()=>setLabels(!labels)}>Room labels</button><button onClick={()=>{setReset(reset+1);}}>Reset orbit</button><a href="/home-display-preview">Displays ↗</a></nav>
    <div className="apartment-perf" ref={perf}/>
    {display&&<HomeDisplay preview api={previewHomeApi} owner="preview" kind={display} onClose={()=>setDisplay(null)}/>}
  </main>;
}
