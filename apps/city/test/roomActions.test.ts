import {expect,it} from 'vitest';
import {roomSeatActions} from '../src/roomActions';
import {planFor} from '../src/interiors';
import type {Person} from '../src/roomState';
it('offers real seats in each supported venue',()=>{for(const place of ['diner','roof','watch_party']){const seats=planFor(place)!.seats;const actions=roomSeatActions(place,seats,{});expect(actions.length).toBeGreaterThan(0);for(const a of actions)expect(seats).toContain(a.seat);}});
it('skips occupied seats and returns full when the group is occupied',()=>{const seats=planFor('diner')!.seats;const first=roomSeatActions('diner',seats,{})[0]!.seat!;const person:Person={userId:'a',handle:'a',pos:{x:0,y:0},seat:first.id,emote:null};expect(roomSeatActions('diner',seats,{a:person})[0]!.seat?.id).not.toBe(first.id);const full=Object.fromEntries(seats.map((s,i)=>[String(i),{...person,userId:String(i),seat:s.id}]));expect(roomSeatActions('diner',seats,full).every(a=>a.seat===null)).toBe(true);});
it('does not invent actions for homes or unsupported venues',()=>{expect(roomSeatActions('home:a',[],{})).toEqual([]);});
