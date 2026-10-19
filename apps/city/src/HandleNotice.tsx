"use client";
import type { HandleNotice as Notice } from "./api";
import { handleNoticeText } from "./renameNotice";

// Staff renamed your @handle: a short note from the city, once, until Got it
// (or Appeal, which takes you to Me, where the appeal is).
export default function HandleNotice({ notice, onOk, onAppeal }: { notice: Notice; onOk: () => void; onAppeal: () => void }) {
  const t = handleNoticeText(notice);
  return (
    <div className="backdrop">
      <div className="callsheet" role="dialog" aria-modal="true" aria-labelledby="handle-notice-title">
        <span className="eyebrow">FROM THE CITY</span>
        <p className="q" id="handle-notice-title">
          {t.title}
        </p>
        <p>{t.changed}</p>
        <p className="notice">{t.why}</p>
        {t.links && <p className="muted">{t.links}</p>}
        {t.appeal && <p className="muted">{t.appeal}</p>}
        <button className="cta" onClick={onOk} autoFocus>
          Got it
        </button>
        {t.appeal && (
          <button className="btn light" onClick={onAppeal}>
            Appeal
          </button>
        )}
      </div>
    </div>
  );
}
