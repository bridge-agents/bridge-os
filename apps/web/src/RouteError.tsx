import { CircleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";

/**
 * Keeps one broken page from taking the whole application with it.
 *
 * Without this, any error thrown while rendering a route unmounts the entire
 * tree — sidebar, header and all — and what the user gets is a blank grey
 * window with nothing to click and nothing explaining why. That is the worst
 * possible failure: it hides which page broke, and it removes the navigation
 * they would use to get somewhere else.
 *
 * The boundary resets on navigation, so leaving the broken page is enough to
 * recover; a stuck error that survives a route change would be its own bug.
 */
interface Props {
  children: ReactNode;
  /** Changing this clears the error — the route path, in practice. */
  resetKey: string;
}

interface State {
  error: Error | null;
  shownFor: string;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, shownFor: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.error && state.shownFor !== props.resetKey) return { error: null };
    return state.shownFor === props.resetKey ? null : { shownFor: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only way to find a production render bug after the fact.
    console.error("Route render failed:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <p className="flex items-center gap-2 font-medium text-destructive">
          <CircleAlert className="size-4" /> This page could not be shown
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          Something went wrong rendering it. The rest of Bridge is still working — use the sidebar
          to go elsewhere, or try again.
        </p>
        <code className="max-w-full overflow-x-auto rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
          {error.message}
        </code>
        <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
