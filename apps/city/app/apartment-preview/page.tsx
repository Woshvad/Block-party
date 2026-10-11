import { notFound } from "next/navigation";
import ApartmentClient from "./view";
export default function Page(){ if(process.env.NODE_ENV !== "development") notFound(); return <ApartmentClient/>; }
