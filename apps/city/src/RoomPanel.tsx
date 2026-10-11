"use client";
import { useRef, useState } from 'react';
import { EMOTES } from '@bp/core';
import type { RoomState } from './roomState';
import type { SocketStatus } from './roomSocket';
import { EMOTE_ICON } from './emoteIcons';
export type RoomAction = {id:string;label:string;disabled?:boolean;run:()=>void};
type Props={name:string;room:RoomState;status:SocketStatus;text:string;pending:boolean;clean:boolean;onClean:()=>void;onLeave:()=>void;onText:(s:string)=>void;onSend:()=>void;onEmote:(s:string)=>void;onPerson:(id:string)=>void;actions:RoomAction[];preview?:boolean};
export default function RoomPanel(p:Props) {
  const [tab,setTab]=useState<'chat'|'people'|'emotes'|null>(null);
  const cleanButton=useRef<HTMLButtonElement>(null),chatButton=useRef<HTMLButtonElement>(null);
  const live=p.status.kind==='live';
  const connection=live ? (p.preview?`${p.room.headcount.here} simulated residents`:`${p.room.headcount.here} here`) : p.status.kind==='connecting'?'Connecting…':p.status.kind==='reconnecting'?`Reconnecting · attempt ${p.status.attempt}`:p.status.kind==='stopped'?p.status.reason:'Connected';
  return <>
    <div className="social-room-top"><button onClick={p.onLeave}>‹ City</button><span>{p.preview?'ROOM STUDY · SAMPLE PEOPLE':p.name}</span><button ref={cleanButton} aria-pressed={p.clean} onClick={()=>{setTab(null);p.onClean();}}>{p.clean?'Show controls':'Clean view'}</button></div>
    {!live && <div className="social-room-connection" role="status">{connection} <span>Live counts unavailable. Your draft is kept.</span></div>}
    {!p.clean && <section className="social-room-panel" aria-label="Room controls" onKeyDown={e=>{if(e.key==='Escape'&&tab){setTab(null);chatButton.current?.focus();}}}>
      <header><div><span className="eyebrow">{p.preview?'SOCIAL ROOM PREVIEW':'YOUR CORNER OF THE CITY'}</span><h2>{p.name}</h2><p><span className={`social-presence ${live?'online':''}`}/>{live?connection:p.status.kind==='connecting'?'Joining the room…':'Live presence unavailable'}{live&&p.room.headcount.npc>0?` · ${p.room.headcount.npc} NPC`:''}{live&&p.room.headcount.away>0?` · ${p.room.headcount.away} away`:''}</p></div><button className="social-room-minimize" aria-label="Hide room controls" onClick={()=>{setTab(null);p.onClean();cleanButton.current?.focus();}}>⌄</button></header>
      <div className="social-room-tabs" aria-label="Room conversations">
        <button ref={chatButton} aria-expanded={tab==='chat'} aria-controls="room-chat-history" onClick={()=>setTab(tab==='chat'?null:'chat')}>Conversation{p.room.lines.length?` · ${p.room.lines.length}`:''}</button>
        <button aria-expanded={tab==='people'} aria-controls="room-people" onClick={()=>setTab(tab==='people'?null:'people')}>People</button>
        <button aria-expanded={tab==='emotes'} aria-controls="room-emotes" onClick={()=>setTab(tab==='emotes'?null:'emotes')}>Reactions</button>
      </div>
      {tab==='chat'&&<div className="social-room-history" id="room-chat-history" tabIndex={0} aria-label="Recent room messages">{p.room.lines.length?p.room.lines.slice(-12).map(l=><p key={l.id}><button onClick={()=>p.onPerson(l.userId)} disabled={l.userId===p.room.you}>@{l.handle}</button><span>{l.text}</span></p>):<p className="social-room-empty">A quiet corner. Say hello when you’re ready.</p>}</div>}
      {tab==='people'&&<div className="social-room-people" id="room-people">{!live&&<p>Last known residents · connection unavailable</p>}{Object.values(p.room.people).map(person=><button key={person.userId} disabled={person.userId===p.room.you} onClick={()=>p.onPerson(person.userId)}><span>@{person.handle}</span><small>{person.userId===p.room.you?(person.seat?'You · seated':'You'):person.seat?'Seated':'View profile'}</small></button>)}{!Object.keys(p.room.people).length&&<p>Residents appear when the room connects.</p>}</div>}
      {tab==='emotes'&&<div className="social-room-emotes" id="room-emotes">{EMOTES.map(e=><button key={e} disabled={!live} aria-label={e.replace(/_/g,' ')} title={e.replace(/_/g,' ')} onClick={()=>{p.onEmote(e);setTab(null);chatButton.current?.focus();}}>{EMOTE_ICON[e]??'✨'}</button>)}</div>}
      <form className="social-room-compose" onSubmit={e=>{e.preventDefault();if(live&&!p.pending&&p.text.trim())p.onSend();}}><input aria-label="Message the room" value={p.text} onChange={e=>p.onText(e.target.value)} maxLength={280} disabled={p.pending} placeholder={live?'Say something to the room…':p.status.kind==='stopped'?'Connection unavailable · draft here…':'Draft a message while reconnecting…'} enterKeyHint="send"/><button disabled={!live||p.pending||!p.text.trim()} aria-label={p.pending?'Sending message':'Send message'}>{p.pending?'…':'↑'}</button></form>
      {!!p.actions.length&&<div className="social-room-actions" aria-label="Things to do here">{p.actions.map(a=><button key={a.id} disabled={!live||a.disabled} onClick={a.run}>{a.label}</button>)}</div>}
      <footer>{p.preview?'Preview only · messages and actions stay in this tab':p.pending?'Waiting for delivery confirmation…':'Tap the floor to walk · tap a neighbour to meet them'}</footer>
    </section>}
  </>;
}
