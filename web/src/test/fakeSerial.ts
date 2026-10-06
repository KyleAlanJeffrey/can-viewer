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
  /** The baud rate of the last open. */
  baudRate: number | null = null;
  /** Set by `canable()`'s firmware when it took M1. */
  silentMode = false;
  /** Set by `lawicel()`'s firmware while its CAN channel is open. */
  channelOpen = false;
  /** What the adapter answers to a command, or null for no answer. */
  answer: (command: string) => string | null = (command) => (command === 'V' ? 'V1013\r' : '\r');
  /** Set to make `open` fail, as when another program holds the port. */
  openError: Error | null = null;
  /** Set to make writes fail, as when the adapter has hung. */
  writeError: Error | null = null;
  /** Set to make writes never finish, as when the USB serial link has hung; abort ends them. */
  hangWrites = false;
  /** Set to make each write take this long, as over a slow link. */
  writeDelayMs = 0;
  private opening: Promise<void> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private written = '';

  constructor(private readonly info = { usbVendorId: 0x16d0, usbProductId: 0x117e }) {}

  getInfo() {
    return this.info;
  }

  /** Makes the next `open` wait until the returned function is called. */
  delayOpen(): () => void {
    let release = () => {};
    this.opening = new Promise((resolve) => (release = resolve));
    return release;
  }

  async open(options: { baudRate: number }) {
    this.baudRate = options.baudRate;
    if (this.opening) {
      const opening = this.opening;
      this.opening = null;
      await opening;
    }
    if (this.openError) throw this.openError;
    this.opened = true;
    this.closed = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.hangWrites) return new Promise<void>(() => {});
        if (this.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
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

  /**
   * A Lawicel adapter (CANUSB, USBtin): `O` and `L` open the channel and `C` closes it; while it
   * is open, every command but `C` and `V` is refused with BEL. `V` is answered with `version`.
   */
  lawicel(version: string | null = 'V1013\r') {
    this.answer = (command) => {
      if (command === 'V') return version;
      if (command === 'C') {
        const wasOpen = this.channelOpen;
        this.channelOpen = false;
        return wasOpen ? '\r' : '\x07';
      }
      if (this.channelOpen) return '\x07';
      if (command === 'O' || command === 'L') this.channelOpen = true;
      return '\r';
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
