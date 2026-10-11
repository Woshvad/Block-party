"use client";
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useMemo, useRef, useState } from 'react';
import Interior from './Interior';
import { layoutFor, planFor } from './interiors';
import { toWorld, nearestFree } from './plan';
import { RoomCamera, RoomLighting } from './RoomLighting';
import ChibiCrowd, {type ChibiPerson} from './chibi/Crowd';
import { PerfProbe } from './PerfHud';
import RoomPanel from './RoomPanel';
import {roomSeatActions} from './roomActions';
import {emptyRoom, type RoomState} from './roomState';
import type {SocketStatus} from './roomSocket';
import {placeName,roomSize} from './places';
function fixture(place:string):RoomState {
 const plan=planFor(place)!;
 const people=Object.fromEntries(['you','sol','ada','jo'].map((id,i)=>[id,{userId:id,handle:id==='you'?'amigo':id,pos:nearestFree(plan,{x:4+i*2,y:5})!,seat:null,emote:null}]));
 return {...emptyRoom(),you:'you',people,headcount:{here:4,npc:0,away:0},lines:[{id:'hello',userId:'ada',handle:'ada',text:'Found our spot. Who’s staying for the bell?',at:Date.now()},{id:'reply',userId:'sol',handle:'sol',text:'I’m here. Saved you a seat.',at:Date.now()}]};
}
function RoomStudy({place}:{place:string}) {
 const [room,setRoom]=useState(()=>fixture(place)),[text,setText]=useState(''),[clean,setClean]=useState(false),[status,setStatus]=useState<SocketStatus>({kind:'live'}),[notice,setNotice]=useState('');
 const plan=planFor(place)!,size=roomSize(place)!,layout=layoutFor(place)!,span=Math.max(size.w,size.h);
 const perf=useRef<HTMLDivElement>(null);
 const people=useRef<ChibiPerson[]>([]);
 people.current=useMemo(()=>Object.values(room.people).map((p,i)=>{const seat=plan.seats.find(s=>s.id===p.seat);const world=toWorld(plan,seat??p.pos);return {id:p.userId,look:null,x:world.x,z:world.z,yaw:seat?.facing??.5,phase:i,moving:false,sitY:seat?seat.h??.45:null};}),[room.people,plan]);
 const actions=roomSeatActions(place,plan.seats,room.people).map(({label,seat})=>({id:label,label:seat?label:`${label} · full`,disabled:!seat,run:()=>{if(seat){setRoom(r=>({...r,people:{...r.people,you:{...r.people.you!,seat:seat.id,pos:{x:seat.x,y:seat.y}}}}));setNotice('Sample resident seated. Live rooms send this action to the room server.');}}}));
 return <>
 <div className={`stage room-stage social-live-stage ${clean ? "is-clean" : ""}`}><Canvas shadows dpr={[1,1.5]} camera={{position:[14,15,17],fov:45}}><RoomLighting span={span} outdoor={place==='roof'}/><Interior layout={layout} w={size.w} h={size.h} low={place==='roof'}/><ChibiCrowd people={people} cap={4}/><RoomCamera w={size.w} h={size.h}/><OrbitControls enablePan={false} minPolarAngle={.5} maxPolarAngle={1.15} minDistance={span*.65} maxDistance={span*8}/><PerfProbe target={perf}/></Canvas></div>
 <div className="social-preview-perf" ref={perf}/>
 <RoomPanel preview name={placeName(place)} room={room} status={status} text={text} pending={false} clean={clean} onClean={()=>setClean(v=>!v)} onLeave={()=>{window.location.href='/';}} onText={setText} onSend={()=>{if(!text.trim()||status.kind!=='live')return;setRoom(r=>({...r,lines:[...r.lines,{id:crypto.randomUUID(),userId:'you',handle:'amigo',text:text.trim(),at:Date.now()}].slice(-80)}));setText('');setNotice('Sample message added. Open Conversation to read it.');}} onEmote={e=>setNotice(`Sample reaction: ${e.replace(/_/g,' ')}`)} onPerson={id=>setNotice(`@${room.people[id]?.handle??id} · Sample profile. Live rooms open the resident profile with block/report controls.`)} actions={actions}/>
 <select className="social-state-select" aria-label="Preview connection" value={status.kind} onChange={e=>{setStatus(e.target.value==='live'?{kind:'live'}:e.target.value==='reconnecting'?{kind:'reconnecting',attempt:2}:{kind:'stopped',reason:'The room is unavailable.'});}}><option value="live">Connected</option><option value="reconnecting">Reconnecting</option><option value="stopped">Stopped</option></select>
 {notice&&!clean&&<div className="social-preview-notice" role="status"><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss preview feedback">×</button></div>}
 </>;
}
export default function RoomSocialPreview(){const [place,setPlace]=useState('diner');return <main className="social-room-demo"><RoomStudy key={place} place={place}/><div className="social-preview-switch"><select aria-label="Preview venue" value={place} onChange={e=>setPlace(e.target.value)}>{['diner','roof','watch_party'].map(p=><option key={p} value={p}>{placeName(p)}</option>)}</select></div></main>;}
