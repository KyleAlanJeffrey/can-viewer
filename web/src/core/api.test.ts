import { describe, expect, it } from 'vitest';
import { EXT_FLAG, FLAG_ERROR, FLAG_FD, dbcId, formatId, idLabel, isErrorFrame } from './api';

describe('formatId', () => {
  it('pads standard IDs to three hex digits', () => {
    expect(formatId(0x1f5, false)).toBe('1F5');
    expect(formatId(0x5, false)).toBe('005');
  });

  it('pads extended IDs to eight hex digits', () => {
    expect(formatId(0x18fef100, true)).toBe('18FEF100');
    expect(formatId(0x100, true)).toBe('00000100');
  });
});

describe('dbcId', () => {
  it('sets bit 31 for extended IDs only', () => {
    expect(dbcId({ id: 0x100, extended: false })).toBe(0x100);
    expect(dbcId({ id: 0x18fef100, extended: true })).toBe((0x18fef100 | EXT_FLAG) >>> 0);
    expect(dbcId({ id: 0x18fef100, extended: true })).toBeGreaterThan(0);
  });
});

describe('isErrorFrame', () => {
  it('reads the error flag and nothing else', () => {
    expect(isErrorFrame({ flags: FLAG_ERROR })).toBe(true);
    expect(isErrorFrame({ flags: FLAG_ERROR | FLAG_FD })).toBe(true);
    expect(isErrorFrame({ flags: FLAG_FD })).toBe(false);
    expect(isErrorFrame({ flags: 0 })).toBe(false);
  });
});

describe('idLabel', () => {
  it('shows a hex ID for ordinary frames', () => {
    expect(idLabel({ id: 0x1f5, extended: false, flags: 0 })).toBe('1F5');
    expect(idLabel({ id: 0x18fef100, extended: true, flags: FLAG_FD })).toBe('18FEF100');
  });

  it('shows the error class of error frames, never the error flag as an ID', () => {
    expect(idLabel({ id: 0x2000_0080, extended: false, flags: FLAG_ERROR })).toBe('Error 080');
    expect(idLabel({ id: 0x2000_0004, extended: false, flags: FLAG_ERROR })).toBe('Error 004');
    expect(idLabel({ id: 0x2000_0000, extended: false, flags: FLAG_ERROR })).toBe('Error frames');
  });
});
