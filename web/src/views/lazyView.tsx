import { lazy, Suspense, type ComponentType } from 'react';
import { ChunkBoundary } from '../components/ChunkBoundary';
import type { ViewProps } from './types';

/** A view whose code (and stylesheet) loads the first time it is shown, keeping it out of the main bundle. */
export function lazyView(load: () => Promise<ComponentType<ViewProps>>): ComponentType<ViewProps> {
  const View = lazy(() => load().then((Component) => ({ default: Component })));
  return function LazyView(props: ViewProps) {
    return (
      <ChunkBoundary>
        <Suspense fallback={null}>
          <View {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  };
}
