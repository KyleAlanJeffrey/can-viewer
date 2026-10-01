import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ViewStateContext, ViewStateStore, useViewState } from './viewState';

describe('ViewStateStore', () => {
  it('keeps values with their scope', () => {
    const store = new ViewStateStore();
    store.set('plot.markers', [1, 2], 'app');
    store.set('re.window', [0, 10], 'log');
    expect(store.get('plot.markers')).toEqual({ scope: 'app', value: [1, 2] });
    expect(store.get('re.window')).toEqual({ scope: 'log', value: [0, 10] });
    expect(store.get('missing')).toBeUndefined();
  });

  it('clears only the log scope when another log opens', () => {
    const store = new ViewStateStore();
    store.set('re.changingOnly', true, 'app');
    store.set('re.pins', ['a'], 'log');
    store.set('re.byte', { key: 1, byte: 2 }, 'log');
    store.clearScope('log');
    expect(store.snapshot()).toEqual([['re.changingOnly', { scope: 'app', value: true }]]);
  });

  it('restores a snapshot', () => {
    const store = new ViewStateStore();
    store.set('a', 1, 'app');
    store.set('b', 2, 'log');
    const copy = new ViewStateStore();
    copy.restore(store.snapshot());
    expect(copy.get('a')?.value).toBe(1);
    expect(copy.get('b')).toEqual({ scope: 'log', value: 2 });
  });

  it('tells subscribers and the shell about every change', () => {
    const store = new ViewStateStore();
    const listener = vi.fn();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.onChange = onChange;
    store.set('a', 1, 'app');
    store.clearScope('log');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.set('a', 2, 'app');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('useViewState', () => {
  function Counter({ scope }: { scope: 'app' | 'log' }) {
    const [count, setCount] = useViewState(`test.count.${scope}`, 0, scope);
    return (
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        {scope} {count}
      </button>
    );
  }

  it('starts from the initial value, survives remounting and resets with its scope', async () => {
    const store = new ViewStateStore();
    const user = userEvent.setup();
    const tree = (
      <ViewStateContext.Provider value={store}>
        <Counter scope="app" />
        <Counter scope="log" />
      </ViewStateContext.Provider>
    );
    const { unmount } = render(tree);
    await user.click(screen.getByRole('button', { name: 'app 0' }));
    await user.click(screen.getByRole('button', { name: 'log 0' }));
    await user.click(screen.getByRole('button', { name: 'log 1' }));
    expect(store.get('test.count.log')).toEqual({ scope: 'log', value: 2 });

    unmount();
    render(tree);
    expect(screen.getByRole('button', { name: 'app 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'log 2' })).toBeTruthy();

    act(() => store.clearScope('log'));
    expect(screen.getByRole('button', { name: 'app 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'log 0' })).toBeTruthy();
  });
});
