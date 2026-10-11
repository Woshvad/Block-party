"use client";
export type AppTab = "city" | "home" | "today" | "tower" | "more";
const ITEMS: { id: AppTab; label: string; path: string }[] = [
  { id: "city", label: "City", path: "M3 21V9h6V3h6v10h6v8M6 12v2m6-8v2m0 3v2m6 3v2M2 21h20" },
  { id: "home", label: "Home", path: "m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" },
  { id: "today", label: "Today", path: "M8 2v4m8-4v4M3 9h18M4 4h16v17H4zM8 13h3m2 0h3m-8 4h3" },
  { id: "tower", label: "Tower", path: "M6 21V8h12v13M9 8V4h6v4m-3-4V1M3 21h18M10 12h4m-4 4h4" },
  { id: "more", label: "More", path: "M4 4h5v5H4zm11 0h5v5h-5zM4 15h5v5H4zm11 0h5v5h-5z" },
];
export default function AppNavigation({ active, onSelect }: { active: AppTab; onSelect: (tab: AppTab) => void }) {
  return <nav className="tabs app-navigation" aria-label="Main navigation">
    {ITEMS.map(({ id, label, path }) => <button key={id} className={active === id ? "on" : ""} aria-current={active === id ? "page" : undefined} onClick={() => onSelect(id)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg><span>{label}</span>
    </button>)}
  </nav>;
}
