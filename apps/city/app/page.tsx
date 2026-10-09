"use client";
import dynamic from "next/dynamic";

// The city needs WebGL and the browser's storage, so it renders on the client only.
const App = dynamic(() => import("../src/App"), { ssr: false });

export default function Page() {
  return <App />;
}
