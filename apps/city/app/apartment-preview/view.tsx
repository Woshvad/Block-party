"use client";
import dynamic from "next/dynamic";
const Apartment = dynamic(()=>import("../../src/ShowcaseApartment"),{ssr:false});
export default function ApartmentClient(){ return <Apartment/>; }
