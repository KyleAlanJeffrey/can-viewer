import { render, screen } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeCore } from './test/fixtures';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the empty state when there is no saved session', async () => {
    const core = fakeCore({ setDatabases: vi.fn(() => Promise.resolve()) });
    render(<App core={core} />);
    expect(await screen.findByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the Demo' })).toBeTruthy();
    expect(screen.getByText('Message IDs appear here once a log is open.')).toBeTruthy();
    expect(core.setDatabases).not.toHaveBeenCalled();
  });
});
