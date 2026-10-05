import type { SerialPortLike } from '../capture/webSerial';

/**
 * A serial port with an slcan adapter behind it. Each command written is recorded and answered
 * by `answer` (CR, "done", or a version for `V`, unless a test says otherwise); `send` delivers
 * what the adapter sends by itself, such as frames.
 */
export class FakeSerialPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  readonly commands: string[] = [];
  opened = false;
  closed = false;
  /** Set by `canable()`'s firmware when it took M1. */
  silentMode = false;
  /** What the adapter answers to a command, or null for no answer. */
  answer: (command: string) => string | null = (command) => (command === 'V' ? 'V1013\r' : '\r');
  /** Set to make `open` fail, as when another program holds the port. */
  openError: Error | null = null;
  /** Set to make writes fail, as when the adapter has hung. */
  writeError: Error | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private written = '';

  constructor(private readonly info = { usbVendorId: 0x16d0, usbProductId: 0x117e }) {}

  getInfo() {
    return this.info;
  }

  async open() {
    if (this.openError) throw this.openError;
    this.opened = true;
    this.closed = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.writeError) throw this.writeError;
        this.written += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = this.written.indexOf('\r')) >= 0) {
          const command = this.written.slice(0, end);
          this.written = this.written.slice(end + 1);
          this.commands.push(command);
          const reply = this.answer(command);
          // Answered after the write resolves, as a real adapter would.
          if (reply !== null) setTimeout(() => this.send(reply));
        }
      },
    });
  }

  /** The adapter answers no command at all. */
  silence() {
    this.answer = () => null;
  }

  /**
   * CANable's slcan firmware (canable-fw, canable2-fw): it answers `V` with a version line and
   * nothing else, ignores `L`, and takes `M1` as silent mode only while the channel is closed.
   */
  canable() {
    let busOpen = false;
    this.answer = (command) => {
      if (command === 'V') return 'b2c4e1f canable2-fw\r';
      if (command === 'O') busOpen = true;
      if (command === 'C') busOpen = false;
      if (command === 'M1' && !busOpen) this.silentMode = true;
      if (command === 'M0' && !busOpen) this.silentMode = false;
      return null;
    };
  }

  send(text: string | Uint8Array) {
    if (!this.controller || this.closed) return;
    this.controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text);
  }

  /** The device goes away: the read fails and the port has no stream to read any more. */
  unplug() {
    this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'));
    this.controller = null;
    this.readable = null;
  }

  async close() {
    this.closed = true;
    this.readable = null;
    this.writable = null;
  }
}
