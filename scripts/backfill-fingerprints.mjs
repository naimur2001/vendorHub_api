// Makes the missing fingerprints: product titles, and product photos stored in our media folder.
// Usage: node --env-file=.env scripts/backfill-fingerprints.mjs  (after a seed, or once on a server)
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma.js';
import { mediaFilePath } from '../src/lib/storage.js';
import { fingerprintProductTitles, fingerprintImage } from '../src/lib/fingerprints.js';

const started = Date.now();
let titles = 0;
for (;;) {
  const rows = await prisma.$queryRaw`SELECT id FROM "Product" WHERE "titleEmbedding" IS NULL LIMIT 32`;
  if (!rows.length) break;
  titles += await fingerprintProductTitles(rows.map((r) => r.id));
}

let photos = 0;
let missing = 0;
const images = await prisma.$queryRaw`SELECT id, key FROM "Image" WHERE "productId" IS NOT NULL AND embedding IS NULL`;
for (const img of images) {
  const file = mediaFilePath(`${img.key}.webp`);
  try {
    await fingerprintImage(img.id, await readFile(file));
    photos += 1;
  } catch {
    missing += 1; // file not on this machine
  }
}
console.log(`Fingerprints made: ${titles} titles, ${photos} photos (${missing} photo files missing) in ${Date.now() - started} ms`);
await prisma.$disconnect();