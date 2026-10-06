import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi, Database } from '../../core/api';
import { fakeCore, message, signal, summary } from '../../test/fixtures';
import { renderInShell, type ShellOptions } from '../../test/shell';
import type { LoadedDbc } from '../types';
import { DatabaseView } from './DatabaseView';

const engine = summary({ id: 0x100, name: 'Engine' });
const unknown = summary({ id: 0x200 });

const car: LoadedDbc = {
  id: 'car',
  db: {
    name: 'car.dbc',
    messages: [
      message(0x100, 'Engine', { signals: [signal('EngineSpeed', { unit: 'rpm' }), signal('Throttle', { startBit: 8 })] }),
      message(0x300, 'Brakes', { signals: [signal('BrakePressure')] }),
    ],
  },
  channel: null,
  edited: false,
};
// Its 100 is decoded by car.dbc, which comes first.
const extra: LoadedDbc = {
  id: 'extra',
  db: { name: 'extra.dbc', messages: [message(0x100, 'EngineAlt'), message(0x400, 'Lights')] },
  channel: null,
  edited: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDatabase(options: Partial<ShellOptions> = {}) {
  return renderInShell(DatabaseView, { core: fakeCore(), ids: [engine, unknown], dbcs: [car, extra], ...options });
}

const sidebar = () => screen.getByRole('complementary', { name: 'Sidebar' });
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });
const dbcGroup = (name: string) => within(sidebar()).getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
const messageRow = (text: RegExp) => within(screen.getByRole('navigation', { name: 'Messages' })).getByRole('button', { name: text });
const messageOf = (dbcs: LoadedDbc[], dbc: string, id: number) => dbcs.find((d) => d.id === dbc)?.db.messages.find((m) => m.id === id);

describe('Database new message and DBC', () => {
  it('adds a message to the chosen DBC once its fields are valid', async () => {
    const { user, state } = renderDatabase();
    await user.click(within(sidebar()).getByRole('button', { name: 'New Message' }));
    const sheet = screen.getByRole('dialog', { name: 'New Message' });
    expect(within(sheet).getByRole('combobox', { name: 'DBC' })).toHaveProperty('value', 'car');

    await user.click(within(sheet).getByRole('button', { name: 'Add Message' }));
    expect(within(sheet).getByRole('textbox', { name: 'Name' }).getAttribute('aria-invalid')).toBe('true');
    expect(within(sheet).getByText('Enter a hex ID, e.g. 1F5.')).toBeTruthy();

    await user.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'Gear');
    await user.type(within(sheet).getByRole('textbox', { name: 'ID (hex)' }), '300');
    await user.click(within(sheet).getByRole('button', { name: 'Add Message' }));
    expect(within(sheet).getByText('Brakes already uses this ID.')).toBeTruthy();

    await user.clear(within(sheet).getByRole('textbox', { name: 'ID (hex)' }));
    await user.type(within(sheet).getByRole('textbox', { name: 'ID (hex)' }), '1f5');
    await user.selectOptions(within(sheet).getByRole('combobox', { name: 'DBC' }), 'extra.dbc');
    await user.click(within(sheet).getByRole('button', { name: 'Add Message' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Gear' })).toBeTruthy();
    expect(messageRow(/^1F5\s*Gear/).getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(messageOf(state.dbcs, 'extra', 0x1f5)).toMatchObject({ name: 'Gear', size: 8, signals: [] }));
    expect(messageOf(state.dbcs, 'car', 0x1f5)).toBeUndefined();
    expect(state.dbcs.find((d) => d.id === 'extra')?.edited).toBe(true);
  });

  it('describes an ID from the log that no DBC decodes', async () => {
    const { user, state } = renderDatabase();
    await user.click(within(sidebar()).getByRole('button', { name: /^Add a message for\s*200/ }));
    const sheet = screen.getByRole('dialog', { name: 'New Message' });
    expect(within(sheet).getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'MSG_200');
    expect(within(sheet).getByRole('textbox', { name: 'ID (hex)' })).toHaveProperty('value', '200');
    await user.click(within(sheet).getByRole('button', { name: 'Add Message' }));

    await waitFor(() => expect(messageOf(state.dbcs, 'car', 0x200)?.name).toBe('MSG_200'));
    expect(within(sidebar()).queryByRole('button', { name: /^Add a message for\s*200/ })).toBeNull();
    expect(state.selected).toBe(unknown.key);
  });

  it('starts a new DBC, and puts a message in a new DBC when none is open', async () => {
    const { user, state } = renderDatabase({ dbcs: [] });
    expect(screen.getByRole('heading', { name: 'No DBC open' })).toBeTruthy();

    await user.click(within(sidebar()).getByRole('button', { name: 'New Message' }));
    const sheet = screen.getByRole('dialog', { name: 'New Message' });
    expect(within(sheet).getByText('A new untitled.dbc')).toBeTruthy();
    await user.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'Gear');
    await user.type(within(sheet).getByRole('textbox', { name: 'ID (hex)' }), '1F5');
    await user.click(within(sheet).getByRole('button', { name: 'Add Message' }));
    await waitFor(() => expect(state.dbcs.map((d) => d.db.name)).toEqual(['untitled.dbc']));
    expect(state.dbcs[0].db.messages.map((m) => m.name)).toEqual(['Gear']);
    expect(await screen.findByRole('heading', { level: 2, name: 'Gear' })).toBeTruthy();

    await user.click(within(sidebar()).getByRole('button', { name: 'New DBC' }));
    await waitFor(() => expect(state.dbcs).toHaveLength(2));
    expect(state.dbcs[1]).toMatchObject({ db: { messages: [] }, channel: null, edited: true });
    expect(screen.getByText('This DBC has no messages yet.')).toBeTruthy();
  });
});

describe('Database editing', () => {
  it('commits a valid signal field to the DBC and keeps an invalid one out', async () => {
    const { user, state } = renderDatabase();
    const props = within(inspector()).getByRole('region', { name: 'Signal' });
    const factor = within(props).getByRole('textbox', { name: 'Factor' });

    await user.clear(factor);
    await user.type(factor, 'abc{Enter}');
    expect(factor.getAttribute('aria-invalid')).toBe('true');
    expect(within(props).getByText('Enter a number.')).toBeTruthy();
    expect(messageOf(state.dbcs, 'car', 0x100)?.signals[0].factor).toBe(1);

    await user.clear(factor);
    await user.type(factor, '0.25{Enter}');
    await waitFor(() => expect(messageOf(state.dbcs, 'car', 0x100)?.signals[0].factor).toBe(0.25));
    expect(factor.getAttribute('aria-invalid')).toBe('false');
    expect(state.dbcs[0].edited).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/^Edited/);

    const name = within(props).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Rpm{Enter}');
    await waitFor(() => expect(messageOf(state.dbcs, 'car', 0x100)?.signals.map((s) => s.name)).toEqual(['Rpm', 'Throttle']));
    const table = screen.getByRole('table', { name: 'Signals of Engine' });
    expect(within(table).getByRole('button', { name: 'Rpm' }).getAttribute('aria-current')).toBe('true');
  });

  it('deletes a signal only once confirmed', async () => {
    const { user, state } = renderDatabase();
    await user.click(screen.getByRole('button', { name: 'Delete Throttle' }));
    let sheet = screen.getByRole('dialog', { name: 'Delete Throttle?' });
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(messageOf(state.dbcs, 'car', 0x100)?.signals).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Delete Throttle' }));
    sheet = screen.getByRole('dialog', { name: 'Delete Throttle?' });
    await user.click(within(sheet).getByRole('button', { name: 'Delete Signal' }));
    await waitFor(() => expect(messageOf(state.dbcs, 'car', 0x100)?.signals.map((s) => s.name)).toEqual(['EngineSpeed']));
  });

  it('removes an edited DBC only once confirmed, and an unedited one at once', async () => {
    const { user, state } = renderDatabase({ dbcs: [{ ...car, edited: true }, extra] });
    await user.click(screen.getByRole('button', { name: 'Remove car.dbc' }));
    let sheet = screen.getByRole('dialog', { name: 'Remove car.dbc?' });
    expect(within(sheet).getByText("Its edits haven't been exported.")).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(state.dbcs.map((d) => d.id)).toEqual(['car', 'extra']);

    await user.click(screen.getByRole('button', { name: 'Remove car.dbc' }));
    sheet = screen.getByRole('dialog', { name: 'Remove car.dbc?' });
    await user.click(within(sheet).getByRole('button', { name: 'Remove DBC' }));
    await waitFor(() => expect(state.dbcs.map((d) => d.id)).toEqual(['extra']));
    // Focus moves to the header of the DBC that took its place.
    await waitFor(() => expect(document.activeElement).toBe(dbcGroup('extra.dbc')));

    await user.click(screen.getByRole('button', { name: 'Remove extra.dbc' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(state.dbcs).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(within(sidebar()).getByRole('button', { name: 'New DBC' })));
  });

  it('marks a message an earlier DBC decodes instead as overridden', async () => {
    const { user } = renderDatabase();
    expect(messageRow(/^100\s*Engine\d/).textContent).not.toContain('Overridden');
    const shadowed = messageRow(/^100\s*EngineAlt/);
    expect(shadowed.textContent).toContain('Overridden by car.dbc');
    expect(messageRow(/^400\s*Lights/).textContent).not.toContain('Overridden');

    expect(screen.getAllByText('Overridden by car.dbc')).toHaveLength(1);

    await user.click(shadowed);
    expect(screen.getByRole('heading', { level: 2, name: 'EngineAlt' })).toBeTruthy();
    // The message's own heading says so too.
    expect(screen.getAllByText('Overridden by car.dbc')).toHaveLength(2);
  });
});

describe('Database export', () => {
  const EXPORTED = 'VERSION ""\n\nBO_ 256 Engine: 8 Vector__XXX\n';

  /** A save dialog that resolves to a file collecting what is written, or fails with `error`. */
  function stubPicker(error?: DOMException) {
    const written: string[] = [];
    const write = vi.fn(async (text: string) => {
      written.push(text);
    });
    const close = vi.fn(async () => undefined);
    const picker = vi.fn(async () => {
      if (error) throw error;
      return { createWritable: async () => ({ write, close }) };
    });
    vi.stubGlobal('showSaveFilePicker', picker);
    return { picker, written, close };
  }

  function exportCore() {
    const exportDbc = vi.fn<CoreApi['exportDbc']>(async () => EXPORTED);
    return { core: fakeCore({ exportDbc }), exportDbc };
  }

  it('saves the text the core exports and marks the DBC clean', async () => {
    const { picker, written, close } = stubPicker();
    const { core, exportDbc } = exportCore();
    const { user, state } = renderDatabase({ core, dbcs: [{ ...car, edited: true }, extra] });
    expect(screen.getByRole('status').textContent).toBe('Edited \u00b7 Not exported');

    await user.click(screen.getByRole('button', { name: 'Export DBC\u2026' }));
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'car.dbc' }));
    await waitFor(() => expect(state.dbcs[0].edited).toBe(false));
    expect(exportDbc).toHaveBeenCalledWith(car.db);
    expect(written).toEqual([EXPORTED]);
    expect(close).toHaveBeenCalled();
    expect(state.dbcs[0].exportedAt).toEqual(expect.any(Number));
    expect(screen.getByRole('status').textContent).toBe('Exported just now');

    // Nothing left to lose, so Remove asks nothing.
    await user.click(screen.getByRole('button', { name: 'Remove car.dbc' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the DBC marked as having unexported edits when the save dialog is cancelled', async () => {
    const { written } = stubPicker(new DOMException('The user aborted a request.', 'AbortError'));
    const { core, exportDbc } = exportCore();
    const { user, state } = renderDatabase({ core, dbcs: [{ ...car, edited: true }, extra] });

    await user.click(screen.getByRole('button', { name: 'Export DBC\u2026' }));
    await waitFor(() => expect(exportDbc).toHaveBeenCalled());
    await waitFor(() => expect(state.running).toBe(0));
    expect(screen.getByRole('status').textContent).toBe('Edited \u00b7 Not exported');
    expect(written).toEqual([]);
    expect(state.dbcs[0]).toMatchObject({ edited: true });
    expect(state.dbcs[0].exportedAt).toBeUndefined();
    expect(state.error).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Remove car.dbc' }));
    expect(screen.getByRole('dialog', { name: 'Remove car.dbc?' })).toBeTruthy();
  });

  it('exports from a DBC group header too, with the edits made so far', async () => {
    stubPicker();
    const { core, exportDbc } = exportCore();
    const { user, state } = renderDatabase({ core });
    const factor = within(within(inspector()).getByRole('region', { name: 'Signal' })).getByRole('textbox', { name: 'Factor' });
    await user.clear(factor);
    await user.type(factor, '2{Enter}');

    await user.click(screen.getByRole('button', { name: 'Export extra.dbc\u2026' }));
    await waitFor(() => expect(exportDbc).toHaveBeenCalledWith(extra.db));
    await user.click(screen.getByRole('button', { name: 'Export car.dbc\u2026' }));
    await waitFor(() => expect(exportDbc).toHaveBeenCalledTimes(2));
    const exported = exportDbc.mock.calls[1][0] as Database;
    expect(exported.messages[0].signals[0].factor).toBe(2);
    await waitFor(() => expect(state.dbcs.map((d) => d.edited)).toEqual([false, false]));
  });
});

describe('Database inspector', () => {
  it('shows a signal in the inspector, which Details toggles, and collapses it for a message without signals', async () => {
    const { user, state } = renderDatabase();
    const details = () => screen.getByRole('button', { name: 'Details' });
    expect(state.inspectorHidden).toBe(false);
    expect(details().getAttribute('aria-pressed')).toBe('true');
    await user.click(details());
    expect(details().getAttribute('aria-pressed')).toBe('false');
    await user.click(details());
    expect(details().getAttribute('aria-pressed')).toBe('true');

    await user.click(messageRow(/^400\s*Lights/));
    expect(state.inspectorHidden).toBe(true);
    expect(details()).toHaveProperty('disabled', true);
    expect(details().getAttribute('title')).toBe('Add a signal to edit its details');
  });
});
