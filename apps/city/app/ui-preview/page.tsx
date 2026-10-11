import { notFound } from "next/navigation";
import UIPreview from "../../src/UIPreview";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <UIPreview />;
}
