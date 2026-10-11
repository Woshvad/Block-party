import { describe, expect, it } from 'vitest';
import { INITIAL_ITEMS, START, DESTINATIONS, placementError, walkPath, walkable, restoreLayout } from '../src/apartmentLayout';
describe('apartment layout',()=>{
 it('starts with a valid layout and reachable rooms',()=>{
  for(const item of INITIAL_ITEMS) expect(placementError(item,INITIAL_ITEMS),item.id).toBeNull();
  for(const destination of DESTINATIONS) {
   const path=walkPath(START,destination,INITIAL_ITEMS);
   expect(path,destination.name).not.toBeNull();
   for(const p of path!) expect(walkable(p,INITIAL_ITEMS)).toBe(true);
  }
 });
 it('restores a moved and rotated layout from the compact save format',()=>{
  const moved=INITIAL_ITEMS.map(i=>i.id==='coffee'?{...i,x:i.x+.25,turn:1}:i);
  expect(placementError(moved[3]!,moved)).toBeNull();
  const compact=moved.map(({id,x,z,turn})=>({id,x,z,turn}));
  expect(restoreLayout(JSON.stringify(compact))).toEqual(moved);
 });
 it('keeps doorways open and checks rotated footprints',()=>{
  const lamp=INITIAL_ITEMS[5]!;
  expect(placementError({...lamp,x:1,z:-1.6},INITIAL_ITEMS)).toContain('routes');
  expect(placementError({...INITIAL_ITEMS[0]!,turn:1},INITIAL_ITEMS)).toContain('occupied');
 });
 it('rejects out-of-bounds and occupied placements',()=>{
  const item=INITIAL_ITEMS[5]!;
  expect(placementError({...item,x:6},INITIAL_ITEMS)).toContain('inside');
  expect(placementError({...item,x:-3.4,z:-3},INITIAL_ITEMS)).toContain('occupied');
  expect(placementError({...item,x:1.1,z:-3},INITIAL_ITEMS)).toContain('occupied');
 });
 it('will not walk through beds or outside the room',()=>{
  expect(walkPath(START,{x:-3.4,z:-3},INITIAL_ITEMS)).toBeNull();
  expect(walkPath(START,{x:10,z:10},INITIAL_ITEMS)).toBeNull();
 });
 it('validates saved data and trusts only catalog dimensions',()=>{
  expect(restoreLayout(JSON.stringify(INITIAL_ITEMS))).toEqual(INITIAL_ITEMS);
  expect(restoreLayout('invalid')).toBeNull();
  expect(restoreLayout('[]')).toBeNull();
  expect(restoreLayout(JSON.stringify(INITIAL_ITEMS.map(i=>({...i,x:0,z:0}))))).toBeNull();
  expect(restoreLayout(JSON.stringify(INITIAL_ITEMS.map(i=>({...i,w:999}))))).toEqual(INITIAL_ITEMS);
 });
});
