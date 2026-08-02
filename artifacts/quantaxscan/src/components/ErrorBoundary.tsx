import { Component, type ErrorInfo, type ReactNode } from "react";
import { Shield } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Where the user is sent to recover. */
  actionHref?: string;
  actionLabel?: string;
}
interface State { error: Error | null }

/**
 * Catches render errors below it and shows a recoverable panel instead of a blank page.
 *
 * This exists for `/report/:id`, which is a public, shareable URL: a stored payload written by
 * an older or different scan shape (e.g. one carrying `files` rather than `fileResults`) throws
 * during render, and React unmounts the whole tree — the recipient of a shared link sees a
 * white screen with no explanation and no way out.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] render failed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const { actionHref = "/scan", actionLabel = "Run a new scan" } = this.props;
    return (
      <div className="min-h-screen bg-[#f7f8fa] flex items-center justify-center"
        style={{ background: "radial-gradient(ellipse at 50% 0%, #ffffff 0%, #f7f8fa 70%)" }}>
        <div className="text-center space-y-4 px-4">
          <Shield className="h-12 w-12 text-[#9aa3b2] mx-auto" />
          <p className="text-[#0a0e1a] font-semibold">This report could not be displayed</p>
          <p className="text-[13px] text-[#6b7280] max-w-sm mx-auto leading-relaxed">
            The stored report is in a format this page cannot read. Nothing is wrong with your
            link — the report itself needs to be regenerated.
          </p>
          <a href={actionHref}
            className="inline-block px-4 py-2 bg-[#eef0fe] border border-[#4f46e5]/25 text-[#4f46e5] text-[13px] rounded-lg hover:bg-[#e0e3fc] transition-colors">
            {actionLabel}
          </a>
        </div>
      </div>
    );
  }
}
