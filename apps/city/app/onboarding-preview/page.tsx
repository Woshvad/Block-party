import { notFound } from "next/navigation";
import MoveInPreview from "../../src/MoveInPreview";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <MoveInPreview />;
}
