"use client";
import { Component, Fragment, type ReactNode } from "react";
import { webglSupported } from "./sceneHealth";

// Wraps a 3D view (a Canvas). If the device can't do WebGL, or something in
// the scene throws (most often a model that failed to download on a flaky
// connection), the player sees a plain message with Try again instead of
// the whole app being replaced by an error page. Everything outside the
// Canvas (the HUD, the tabs, a room's chat) keeps working.

type Props = {
  children: ReactNode;
  what: string; // "the city map", "this room"
  note?: string; // what still works without the 3D view
  onRetry?: (error: unknown) => void; // clear whatever the failure left cached
};
type State = { error: unknown; attempt: number };

export default class SceneBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("the 3D view failed") };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  retry = () => {
    this.props.onRetry?.(this.state.error);
    // A new key mounts a fresh Canvas.
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { what, note } = this.props;
    if (!webglSupported()) return <SceneFallback title={`This device can't show ${what} in 3D.`} detail={note} />;
    if (this.state.error) return <SceneFallback title={`Couldn't draw ${what}.`} detail={["A download failed or the 3D view stopped.", note].filter(Boolean).join(" ")} onRetry={this.retry} />;
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

function SceneFallback({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="scene-fallback" role="alert">
      <div>
        <b>{title}</b>
        {detail && <p>{detail}</p>}
        {onRetry && (
          <button className="btn" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
