import { Component, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

/**
 * Catches an error while its children render, such as a lazily loaded chunk that failed to
 * download, and offers a reload instead of leaving the page blank.
 */
export class ChunkBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert">
        <div className="empty-inner">
          <p className="lede">Couldn&rsquo;t load this view.</p>
          <button type="button" className="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
