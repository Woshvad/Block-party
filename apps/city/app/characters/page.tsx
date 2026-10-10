"use client";
import dynamic from "next/dynamic";

// The character sheet, for our artist: drafts of every face, hairstyle and body.
const CharacterSheet = dynamic(() => import("../../src/CharacterSheet"), { ssr: false });

export default function Page() {
  return <CharacterSheet />;
}
