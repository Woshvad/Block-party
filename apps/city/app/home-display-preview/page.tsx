import { notFound } from "next/navigation";
import HomeDisplayPreview from "../../src/HomeDisplayPreview";
export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <HomeDisplayPreview />; }
