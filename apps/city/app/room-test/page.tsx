"use client";
import dynamic from "next/dynamic";

// WebGL only runs in the browser.
const RoomTest = dynamic(() => import("../../src/RoomTest"), { ssr: false });

export default function Page() {
  return <RoomTest />;
}