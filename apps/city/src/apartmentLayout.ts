/** Preview-only apartment model. Coordinates are world units; turns are quarter turns. */
export type Point = { x: number; z: number };
export type Footprint = Point & { w: number; d: number };
export type ApartmentItem = Footprint & { id: string; name: string; kind: string; h: number; color: string; turn: number };
export const INITIAL_ITEMS: ApartmentItem[] = [
  { id: 'bed', name: 'Sage bed', kind: 'bed', x:-3.4,z:-3,w:2.4,h:.9,d:3.1,color:'#658376',turn:0 },
  { id: 'sofa', name: 'Blush sofa', kind: 'sofa', x:-3.2,z:.15,w:3.7,h:1.03,d:1.35,color:'#d6a498',turn:0 },
  { id: 'loveseat', name: 'Blush loveseat', kind: 'sofa', x:-5,z:2.2,w:2.5,h:1.03,d:1.35,color:'#d6a498',turn:1 },
  { id: 'coffee', name: 'Coffee table', kind: 'table', x:-2.9,z:2.05,w:1.8,h:.49,d:1.05,color:'#734f37',turn:0 },
  { id: 'tv', name: 'Media console', kind: 'tv', x:-3.2,z:4.4,w:3.2,h:1.6,d:.75,color:'#283d37',turn:2 },
  { id: 'lamp', name: 'Arc lamp', kind: 'lamp', x:-.8,z:.2,w:.7,h:2.1,d:.7,color:'#f1e5cf',turn:0 },
  { id: 'fern', name: 'Lounge plant', kind: 'plant', x:-5.3,z:4.2,w:.85,h:1.6,d:.85,color:'#658376',turn:0 },
  { id: 'palm', name: 'Dining plant', kind: 'plant', x:5.1,z:4.45,w:.8,h:1.5,d:.8,color:'#658376',turn:0 },
];
export const FIXTURES: Footprint[] = [
  {x:1.1,z:-3.55,w:.14,d:2.9},{x:1.1,z:-.55,w:.14,d:1.1},
  {x:-3.7,z:-.95,w:4.5,d:.12},{x:3.1,z:-.85,w:2.3,d:.13},
  ...[-5.12,-1.65].map(x=>({x,z:-3.9,w:.7,d:.7})),
  {x:-.15,z:-4.4,w:1.7,d:1.05},{x:4.85,z:-3.65,w:1.7,d:2.25},
  {x:2.05,z:-4.25,w:1.3,d:1.1},{x:2.15,z:-2.35,w:.86,d:.9},
  {x:5.35,z:1.525,w:1.32,d:3.8},{x:3.05,z:1.1,w:1.8,d:2.8},
  ...[.25,1.75].map(z=>({x:1.77,z,w:.64,d:.64})),
  {x:2.7,z:3.85,w:2.08,d:2.08},
  ...[1.25,4.15].map(x=>({x,z:3.9,w:.65,d:.8})),
];
export const START: Point = {x:.25,z:2.75};
export const DESTINATIONS = [
  {name:'Lounge',x:-1.25,z:2.75}, {name:'Bedroom',x:0,z:-2.75},
  {name:'Bathroom',x:3.25,z:-1.75}, {name:'Kitchen',x:4.25,z:-.25},
] as const;
export const footprint = (i:ApartmentItem):Footprint => ({x:i.x,z:i.z,w:i.turn%2 ? i.d : i.w,d:i.turn%2 ? i.w : i.d});
const overlaps = (a:Footprint,b:Footprint,pad=0) => Math.abs(a.x-b.x)<(a.w+b.w)/2+pad && Math.abs(a.z-b.z)<(a.d+b.d)/2+pad;
function canWalk(items:ApartmentItem[]) {
  const solids=[...FIXTURES,...items.map(footprint)],r=.18;
  return (p:Point)=>Math.abs(p.x)<=5.9-r && Math.abs(p.z)<=4.9-r &&
    !solids.some(b=>Math.abs(p.x-b.x)<b.w/2+r && Math.abs(p.z-b.z)<b.d/2+r);
}
export function walkable(p:Point,items:ApartmentItem[]) { return canWalk(items)(p); }
/** Four-neighbour BFS prevents corner cutting. All returned segments lie on a .25 grid. */
export function walkPath(from:Point,to:Point,items:ApartmentItem[]):Point[] | null {
  const isOpen=canWalk(items);
  const snap=(n:number)=>Math.round(n*4)/4;
  const start={x:snap(from.x),z:snap(from.z)}, end={x:snap(to.x),z:snap(to.z)};
  if(!isOpen(start)||!isOpen(end)) return null;
  const key=(p:Point)=>`${p.x},${p.z}`;
  const queue=[start], prev=new Map<string,Point | null>([[key(start),null]]);
  for(let n=0;n<queue.length;n++) {
    const p=queue[n]!;
    if(key(p)===key(end)) {
      const path:Point[]=[]; let cursor:Point | null=p;
      while(cursor) { path.push(cursor); cursor=prev.get(key(cursor))!; }
      return path.reverse();
    }
    for(const [dx,dz] of [[.25,0],[-.25,0],[0,.25],[0,-.25]]) {
      const q={x:p.x+dx!,z:p.z+dz!};
      const middle={x:(p.x+q.x)/2,z:(p.z+q.z)/2};
      if(!prev.has(key(q)) && isOpen(q) && isOpen(middle)) {prev.set(key(q),p);queue.push(q);}
    }
  }
  return null;
}
export function placementError(candidate:ApartmentItem,items:ApartmentItem[]):string | null {
  const b=footprint(candidate);
  if(Math.abs(b.x)+b.w/2>5.9 || Math.abs(b.z)+b.d/2>4.9) return 'Keep furniture inside the apartment.';
  if(FIXTURES.some(f=>overlaps(b,f,.025)) || items.some(i=>i.id!==candidate.id && overlaps(b,footprint(i),.025))) return 'That space is occupied. Try another spot.';
  const next=items.map(i=>i.id===candidate.id ? candidate : i);
  if(!DESTINATIONS.every(d=>walkPath(START,d,next))) return 'Keep the doorways and room routes clear.';
  return null;
}
export function restoreLayout(raw:string):ApartmentItem[] | null {
  try {
    const saved:unknown=JSON.parse(raw);
    if(!Array.isArray(saved)||saved.length!==INITIAL_ITEMS.length) return null;
    const next=INITIAL_ITEMS.map(base=>{
      const value=saved.find(v=>v && v.id===base.id);
      if(!value || !Number.isFinite(value.x)||!Number.isFinite(value.z)||!Number.isInteger(value.turn)||value.turn<0||value.turn>3) throw new Error('Invalid layout');
      return {...base,x:value.x,z:value.z,turn:value.turn};
    });
    return next.some(i=>placementError(i,next)) ? null : next;
  } catch { return null; }
}
