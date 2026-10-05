// Renders the app icons in public/icons from public/favicon.svg with headless Chrome, which
// draws the SVG exactly as the browser does. Run from web/: node scripts/icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WARM_WHITE = '#F4F0E7';

// The mark's strokes overrun its 94 x 100 box, so it is nested in its own <svg>, which clips to it.
const mark = readFileSync('public/favicon.svg', 'utf8').replace('<svg ', '<svg overflow="hidden" ');

function icon(size, { maskable }) {
  // A maskable icon keeps the mark inside the central circle (40% radius) that every mask leaves.
  const markHeight = size * (maskable ? 0.5 : 0.58);
  const markWidth = (markHeight * 94) / 100;
  const corner = maskable ? 0 : size * 0.1875;
  const nested = mark.replace(
    '<svg ',
    `<svg x="${(size - markWidth) / 2}" y="${(size - markHeight) / 2}" width="${markWidth}" height="${markHeight}" `,
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${corner}" fill="${WARM_WHITE}"/>${nested}</svg>`
  );
}

const outputs = [
  ['icon-192.png', icon(192, { maskable: false })],
  ['icon-512.png', icon(512, { maskable: false })],
  ['icon-maskable-512.png', icon(512, { maskable: true })],
];

const scratch = mkdtempSync(join(tmpdir(), 'freecan-icons-'));
try {
  for (const [name, svg] of outputs) {
    const size = svg.match(/width="(\d+)"/)[1];
    const page = join(scratch, `${name}.html`);
    writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    execFileSync(CHROME, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${join(process.cwd(), 'public/icons', name)}`,
      `file://${page}`,
    ]);
    console.log(`public/icons/${name}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
