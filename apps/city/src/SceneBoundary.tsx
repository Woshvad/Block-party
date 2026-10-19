"use client";
import { Component, Fragment, type ReactNode } from "react";
import { type SceneFallbackCopy, sceneFallback, webglSupported } from "./sceneHealth";

// Wraps a 3D view (a Canvas). If the device can't do WebGL, or something in
// the scene throws (most often a model that failed to download on a flaky
// connection), the player sees a plain message with Try again instead of
// the whole app being replaced by an error page. Everything outside the
// Canvas (the HUD, the tabs, a room's chat) keeps working. When the failure
// is one no retry can fix, because the game was updated since the page
// opened, it offers Reload instead.

type Props = {
  children: ReactNode;
  what: string; // "the city map", "this room"
  note?: string; // what still works without the 3D view
  onRetry?: (error: unknown) => void; // clear whatever the failure left cached
  outdated?: (error: unknown) => Promise<boolean>; // whether only a reload can fix it
};
type State = { error: unknown; attempt: number; outdated: boolean };

export default class SceneBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0, outdated: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("the 3D view failed") };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
    // Once out of date, the page stays so until it reloads.
    void this.props.outdated?.(error).then((yes) => yes && this.setState({ outdated: true }));
  }

  retry = () => {
    this.props.onRetry?.(this.state.error);
    // A new key mounts a fresh Canvas.
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const shown = sceneFallback(this.props.what, this.props.note, { webgl: webglSupported(), failed: !!this.state.error, outdated: this.state.outdated });
    if (!shown) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    return <SceneFallback {...shown} onAction={shown.action === "reload" ? () => location.reload() : this.retry} />;
  }
}

function SceneFallback({ title, detail, action, onAction }: SceneFallbackCopy & { onAction: () => void }) {
  return (
    <div className="scene-fallback" role="alert">
      <div>
        <b>{title}</b>
        {detail && <p>{detail}</p>}
        {action && (
          <button className="btn" onClick={onAction}>
            {action === "reload" ? "Reload" : "Try again"}
          </button>
        )}
      </div>
    </div>
  );
}
