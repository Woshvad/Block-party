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
import {applyEvent, emptyRoom, liveMoments, type RoomState} from './roomState';
import type {SocketStatus} from './roomSocket';
import {placeName,roomSize} from './places';
import {useNow} from './clock';
import MomentCard from './MomentCard';
import {momentBoard} from './moments';
import {roofBoards,type RoofFeed} from './roomfeeds';
// A sample big moment, sent the way the Watch Party's room sends one: a swing, then a result.
const MARKET='00000000-0000-4000-8000-000000000001',QUESTION='Will Lagos FC beat Enugu Rangers tonight?';
const sampleMoment=(n:number)=>({t:'moment',showForMs:120_000,moment:n%2?{id:`sample-${n}`,kind:'swing',marketId:MARKET,question:QUESTION,from:41,to:63,at:Date.now()}:{id:`sample-${n}`,kind:'settled',marketId:MARKET,question:QUESTION,outcome:'yes',from:63,at:Date.now()}});
// Sample Roof boards (never real data): the full boards, then each honest state.
const DAY=86_400_000,ROOF_STATES=['full','empty','loading','failed','stale'] as const;
type RoofState=(typeof ROOF_STATES)[number];
function sampleRoof(state:RoofState,now:number):RoofFeed{
 if(state==='loading')return {roof:null,failed:false};
 if(state==='failed')return {roof:null,failed:true};
 const bell=Math.floor(now/DAY)*DAY,empty=state==='empty';
 return {failed:false,roof:{bellAt:new Date(state==='stale'?bell-DAY:bell).toISOString(),season:3,
  rightList:{rows:empty?[]:[{rank:1,handle:'ada',npc:null,perCall:6.2,spread:3.1,rusty:false},{rank:2,handle:'sol',npc:null,perCall:4.8,spread:2.6,rusty:false},{rank:3,handle:'jo',npc:null,perCall:3.9,spread:2.2,rusty:true},{rank:4,handle:'The Contrarian',npc:'NPC · AI',perCall:1.1,spread:1.9,rusty:false},{rank:6,handle:'amigo',npc:null,perCall:0.4,spread:1.5,rusty:false},{rank:7,handle:'kemi',npc:null,perCall:0.2,spread:1.2,rusty:false}],bot:empty?null:{rank:9,perCall:-2.4,spread:0.8}},
  seasonStack:{rows:empty?[]:[{rank:1,handle:'sol',profit:1240},{rank:2,handle:'ada',profit:610},{rank:3,handle:'amigo',profit:95},{rank:4,handle:'jo',profit:-80}]},
  crews:{bellDay:new Date(bell-DAY).toISOString().slice(0,10),bellScores:empty?[]:[{rank:1,name:'Night Owls',score:7.5},{rank:2,name:'gm Gang',score:4.5},{rank:3,name:'Roof Rats',score:2.25}],league:empty?null:{week:new Date(bell-8*DAY).toISOString().slice(0,10),champions:[{sizeGroup:'small',name:'Night Owls'},{sizeGroup:'medium',name:'Lagos Callers'}]}}}};
}
const sampleRoofBoards=(state:RoofState,now:number)=>Object.fromEntries(Object.entries(roofBoards(sampleRoof(state,now),now)).map(([k,b])=>[k,{...b,title:`${b.title} · SAMPLE`}]));
function fixture(place:string):RoomState {
 const plan=planFor(place)!;
 const people=Object.fromEntries(['you','sol','ada','jo'].map((id,i)=>[id,{userId:id,handle:id==='you'?'amigo':id,pos:nearestFree(plan,{x:4+i*2,y:5})!,seat:null,emote:null}]));
 return {...emptyRoom(),you:'you',people,headcount:{here:4,npc:0,away:0},lines:[{id:'hello',userId:'ada',handle:'ada',text:'Found our spot. Who’s staying for the bell?',at:Date.now()},{id:'reply',userId:'sol',handle:'sol',text:'I’m here. Saved you a seat.',at:Date.now()}]};
}
function RoomStudy({place}:{place:string}) {
 const [room,setRoom]=useState(()=>fixture(place)),[text,setText]=useState(''),[clean,setClean]=useState(false),[status,setStatus]=useState<SocketStatus>({kind:'live'}),[notice,setNotice]=useState('');
 const plan=planFor(place)!,size=roomSize(place)!,layout=layoutFor(place)!,span=Math.max(size.w,size.h);
 const perf=useRef<HTMLDivElement>(null);
 const now=useNow(1000),sent=useRef(0),[hidden,setHidden]=useState<string[]>([]),[roofState,setRoofState]=useState<RoofState>('full');
 const moments=place==='watch_party'?liveMoments(room,now).filter(m=>!hidden.includes(m.id)):[];
 const people=useRef<ChibiPerson[]>([]);
 people.current=useMemo(()=>Object.values(room.people).map((p,i)=>{const seat=plan.seats.find(s=>s.id===p.seat);const world=toWorld(plan,seat??p.pos);return {id:p.userId,look:null,x:world.x,z:world.z,yaw:seat?.facing??.5,phase:i,moving:false,sitY:seat?seat.h??.45:null};}),[room.people,plan]);
 const actions=roomSeatActions(place,plan.seats,room.people).map(({label,seat})=>({id:label,label:seat?label:`${label} · full`,disabled:!seat,run:()=>{if(seat){setRoom(r=>({...r,people:{...r.people,you:{...r.people.you!,seat:seat.id,pos:{x:seat.x,y:seat.y}}}}));setNotice('Sample resident seated. Live rooms send this action to the room server.');}}}));
 if(place==='watch_party')actions.push({id:'moment',label:'Simulate a big moment',disabled:false,run:()=>{const ev=sampleMoment(++sent.current);setRoom(r=>applyEvent(r,ev,Date.now()));}});
 if(place==='roof')actions.push({id:'boards',label:`Boards: ${roofState}`,disabled:false,run:()=>setRoofState(s=>ROOF_STATES[(ROOF_STATES.indexOf(s)+1)%ROOF_STATES.length]!)});
 const feeds=place==='roof'?sampleRoofBoards(roofState,now):moments[0]?{match:momentBoard(moments[0],'Sample odds · Not real')}:{};
 return <>
 <div className={`stage room-stage social-live-stage ${clean ? "is-clean" : ""}`}><Canvas shadows dpr={[1,1.5]} camera={{position:[14,15,17],fov:45}}><RoomLighting span={span} outdoor={place==='roof'}/><Interior layout={layout} w={size.w} h={size.h} low={place==='roof'} feeds={feeds}/><ChibiCrowd people={people} cap={4}/><RoomCamera w={size.w} h={size.h}/><OrbitControls enablePan={false} minPolarAngle={.5} maxPolarAngle={1.15} minDistance={span*.65} maxDistance={span*8}/><PerfProbe target={perf}/></Canvas></div>
 <div className="social-preview-perf" ref={perf}/>
 <RoomPanel preview name={placeName(place)} room={room} status={status} text={text} pending={false} clean={clean} onClean={()=>setClean(v=>!v)} onLeave={()=>{window.location.href='/';}} onText={setText} onSend={()=>{if(!text.trim()||status.kind!=='live')return;setRoom(r=>({...r,lines:[...r.lines,{id:crypto.randomUUID(),userId:'you',handle:'amigo',text:text.trim(),at:Date.now()}].slice(-80)}));setText('');setNotice('Sample message added. Open Conversation to read it.');}} onEmote={e=>setNotice(`Sample reaction: ${e.replace(/_/g,' ')}`)} onPerson={id=>setNotice(`@${room.people[id]?.handle??id} · Sample profile. Live rooms open the resident profile with block/report controls.`)} actions={actions}/>
 <select className="social-state-select" aria-label="Preview connection" value={status.kind} onChange={e=>{setStatus(e.target.value==='live'?{kind:'live'}:e.target.value==='reconnecting'?{kind:'reconnecting',attempt:2}:{kind:'stopped',reason:'The room is unavailable.'});}}><option value="live">Connected</option><option value="reconnecting">Reconnecting</option><option value="stopped">Stopped</option></select>
 {!clean&&<MomentCard moments={moments} now={now} live={status.kind==='live'} onReact={e=>setNotice(`Sample reaction: ${e.replace(/_/g,' ')}. Live rooms send it as an emote.`)} onCall={()=>setNotice('Live rooms open this market’s call sheet here.')} onDismiss={id=>setHidden(h=>[...h,id])}/>}
 {notice&&!clean&&<div className="social-preview-notice" role="status"><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss preview feedback">×</button></div>}
 </>;
}
export default function RoomSocialPreview(){const [place,setPlace]=useState('diner');return <main className="social-room-demo"><RoomStudy key={place} place={place}/><div className="social-preview-switch"><select aria-label="Preview venue" value={place} onChange={e=>setPlace(e.target.value)}>{['diner','roof','watch_party'].map(p=><option key={p} value={p}>{placeName(p)}</option>)}</select></div></main>;}
