"use client";
import dynamic from "next/dynamic";

const CityBoard = dynamic(() => import("../src/CityBoard"), { ssr: false });

export default function Page() {
  return <CityBoard />;
}