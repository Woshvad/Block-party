import type { Seat } from './plan';
import type { Person } from './roomState';
const GROUPS: Record<string, {label:string;prefix:string}[]> = {
  diner:[{label:'Take a booth',prefix:'booth'},{label:'Sit at the counter',prefix:'stool'}],
  roof:[{label:'Front-row bench',prefix:'front'},{label:'Back-row bench',prefix:'back'}],
  watch_party:[{label:'Front-row sofa',prefix:'sofa'},{label:'Grab a beanbag',prefix:'bean'}],
};
export function roomSeatActions(place:string,seats:Seat[],people:Record<string,Person>) {
  const occupied=new Set(Object.values(people).map(p=>p.seat).filter(Boolean));
  return (GROUPS[place]??[]).map(g=>({label:g.label,seat:seats.find(s=>s.id.startsWith(g.prefix)&&!occupied.has(s.id))??null}));
}
