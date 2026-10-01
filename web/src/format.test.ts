import { describe, expect, it } from 'vitest';
import { formatFirstRejection, formatSkipped, noFramesMessage } from './format';
import { logInfo } from './test/fixtures';

describe('noFramesMessage', () => {
  it('names the format and the first reason a file gave no frames', () => {
    const log = logInfo({ name: 'x.mf4', format: 'mf4', frames: 0, rejected: 1, firstRejection: [1, 'data larger than 1 GiB'] });
    expect(noFramesMessage(log)).toMatch(/^No CAN frames in x\.mf4 \(MF4\): data larger than 1 GiB\. FreeCAN Studio reads /);
  });

  it('explains a binary log that holds only other data', () => {
    const log = logInfo({ name: 'lin.blf', format: 'blf', frames: 0, rejected: 0, lines: 0 });
    expect(noFramesMessage(log)).toBe('No CAN frames in lin.blf (BLF). It holds no CAN, CAN FD or error frames, only other data such as LIN, FlexRay or Ethernet.');
  });

  it('leaves logs with frames, and empty text logs, alone', () => {
    expect(noFramesMessage(logInfo())).toBeNull();
    expect(noFramesMessage(logInfo({ frames: 0, rejected: 0 }))).toBeNull();
  });
});

describe('formatSkipped and formatFirstRejection', () => {
  it('count lines in text logs and records in binary ones', () => {
    const text = logInfo({ rejected: 1, firstRejection: [3, 'bad CAN ID'] });
    expect(formatSkipped(text)).toBe("1 line wasn't a CAN frame and was skipped.");
    expect(formatFirstRejection(text)).toBe('First at line 3: bad CAN ID');
    const binary = logInfo({ format: 'blf', rejected: 1200, firstRejection: [1234, 'bad object header'] });
    expect(formatSkipped(binary)).toBe("1,200 records weren't CAN frames and were skipped.");
    expect(formatFirstRejection(binary)).toBe('First at record 1,234: bad object header');
    expect(formatFirstRejection(logInfo())).toBeNull();
  });
});
