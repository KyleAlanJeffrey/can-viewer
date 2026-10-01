import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FLAG_ERROR, type IdSummary } from '../../core/api';
import { fakeCore, message, signal, summary } from '../../test/fixtures';
import { renderInShell } from '../../test/shell';
import type { LoadedDbc } from '../types';
import { OverviewView } from './OverviewView';

const engine = summary({ id: 0x100, name: 'Engine', count: 500, periodMs: 10 });
const unknownA = summary({ id: 0x200, count: 50, periodMs: 100 });
const cruise = summary({ id: 0x18fef100, extended: true, name: 'Cruise', count: 200, periodMs: 50 });
const unknownB = summary({ id: 0x300, count: 10, periodMs: 1000 });
const errors = summary({ id: 0x20000080, flags: FLAG_ERROR, count: 3 });
const ids: IdSummary[] = [cruise, unknownB, engine, errors, unknownA];

const dbc: LoadedDbc = {
  id: 'car',
  db: {
    name: 'car.dbc',
    messages: [
      message(0x100, 'Engine', { signals: [signal('EngineSpeed')] }),
      message(0x98fef100, 'Cruise', { signals: [signal('WheelSpeed')] }),
    ],
  },
  channel: null,
  edited: false,
};

const busLoadCore = () => fakeCore({ busLoad: async () => [Float64Array.of(0), Float64Array.of(0)] });

function renderOverview() {
  return renderInShell(OverviewView, { core: busLoadCore(), ids, dbcs: [dbc] });
}

const idTable = () => screen.getByRole('table', { name: /^Message IDs/ });

/** The ID column of the table's body rows, top to bottom. */
function idColumn(): string[] {
  const rows = within(idTable()).getAllByRole('row').slice(1);
  return rows.map((row) => within(row).getAllByRole('cell')[1].textContent ?? '');
}

const bodyRow = (id: string) => within(idTable()).getByRole('row', { name: new RegExp(`^can0 ${id}\\b`) });

describe('Overview ID table', () => {
  it('sorts by bus then ID, and by a clicked column in its first direction, then the other way', async () => {
    const { user } = renderOverview();
    const header = (name: string) => within(idTable()).getByRole('columnheader', { name });
    expect(header('Bus').getAttribute('aria-sort')).toBe('ascending');
    expect(idColumn()).toEqual(['100', '200', '300', '18FEF100', 'Error 080']);

    await user.click(within(header('Count')).getByRole('button'));
    expect(header('Count').getAttribute('aria-sort')).toBe('descending');
    expect(header('Bus').hasAttribute('aria-sort')).toBe(false);
    expect(idColumn()).toEqual(['100', '18FEF100', '200', '300', 'Error 080']);

    await user.click(within(header('Count')).getByRole('button'));
    expect(header('Count').getAttribute('aria-sort')).toBe('ascending');
    expect(idColumn()).toEqual(['Error 080', '300', '200', '18FEF100', '100']);

    // Unnamed IDs sort below the named ones either way.
    await user.click(within(header('Name')).getByRole('button'));
    expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
    expect(idColumn()).toEqual(['18FEF100', '100', 'Error 080', '200', '300']);
  });

  it('filters by ID as shown or as plain hex, message name and signal name', async () => {
    const { user } = renderOverview();
    const search = screen.getByRole('searchbox', { name: 'Search' });

    await user.type(search, '18fef100');
    expect(idColumn()).toEqual(['18FEF100']);

    // Error frames are shown by class, and found by the ID they arrive with too.
    await user.clear(search);
    await user.type(search, 'error 080');
    expect(idColumn()).toEqual(['Error 080']);
    await user.clear(search);
    await user.type(search, '20000080');
    expect(idColumn()).toEqual(['Error 080']);

    await user.clear(search);
    await user.type(search, 'fef1');
    expect(idColumn()).toEqual(['18FEF100']);

    await user.clear(search);
    await user.type(search, '30');
    expect(idColumn()).toEqual(['300']);

    await user.clear(search);
    await user.type(search, 'ENGINE');
    expect(idColumn()).toEqual(['100']);

    await user.clear(search);
    await user.type(search, 'wheelspeed');
    expect(idColumn()).toEqual(['18FEF100']);

    await user.clear(search);
    await user.type(search, 'nothing like it');
    expect(within(idTable()).getByText('No IDs or signals match.')).toBeTruthy();
  });

  it('selects a row by click and arrow keys, and opens it in Trace on Enter', async () => {
    const { user, state } = renderOverview();
    await user.click(bodyRow('200'));
    expect(state.selected).toBe(unknownA.key);
    expect(bodyRow('200').getAttribute('aria-current')).toBe('true');
    // The sidebar list shares the selection.
    const sidebar = screen.getByRole('navigation', { name: 'Messages' });
    expect(within(sidebar).getByRole('button', { name: /^200/ }).getAttribute('aria-current')).toBe('true');

    await user.keyboard('{ArrowDown}');
    expect(state.selected).toBe(unknownB.key);
    expect(document.activeElement).toBe(bodyRow('300'));
    expect(bodyRow('200').hasAttribute('aria-current')).toBe(false);
    expect(state.view).toBeNull();

    await user.keyboard('{Enter}');
    expect(state.view).toBe('trace');
    expect(state.selected).toBe(unknownB.key);
  });
});

describe('Overview DBC coverage', () => {
  it('counts the IDs no DBC decodes, leaving out error frames, and reverse engineers the first', async () => {
    const { user, state } = renderOverview();
    const coverage = screen.getByRole('region', { name: 'DBC coverage' });
    expect(within(coverage).getByText('2 of 4')).toBeTruthy();

    await user.click(within(coverage).getByRole('button', { name: 'Reverse Engineer 2 Unknown IDs' }));
    expect(state.view).toBe('reverse');
    expect(state.selected).toBe(unknownA.key);
  });

  it('offers Open DBC without a DBC', () => {
    renderInShell(OverviewView, { core: busLoadCore(), ids: [engine, cruise], dbcs: [] });
    const coverage = screen.getByRole('region', { name: 'DBC coverage' });
    expect(within(coverage).getByText('No DBC')).toBeTruthy();
    expect(within(coverage).getByRole('button', { name: 'Open DBC\u2026' })).toBeTruthy();
  });

  it('offers no reverse engineering once every ID but the error frames is known', () => {
    renderInShell(OverviewView, { core: busLoadCore(), ids: [engine, cruise, errors], dbcs: [dbc] });
    const coverage = screen.getByRole('region', { name: 'DBC coverage' });
    expect(within(coverage).getByText('2 of 2')).toBeTruthy();
    expect(within(coverage).queryByRole('button')).toBeNull();
  });
});
