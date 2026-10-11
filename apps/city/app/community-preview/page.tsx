import { notFound } from "next/navigation";
import CommunityPreview from "../../src/CommunityPreview";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <CommunityPreview />;
}
