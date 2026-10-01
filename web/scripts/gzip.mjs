// Usage: node scripts/gzip.mjs <in> <out.gz>
// The demo log is 55 MB, over Cloudflare's 25 MiB per-asset limit, so it ships gzipped.
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/gzip.mjs <in> <out.gz>');
  process.exit(1);
}
await pipeline(createReadStream(input), createGzip({ level: 9 }), createWriteStream(output));
