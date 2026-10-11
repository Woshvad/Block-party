import { notFound } from "next/navigation";
import CityPreview from "../../src/CityPreview";

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <CityPreview />;
}
