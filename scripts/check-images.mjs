// DEVELOPMENT TOOL: self-test of src/lib/images.js. Usage: node --env-file=.env scripts/check-images.mjs
// Generates every test image in memory; writes nothing to disk.
import zlib from 'node:zlib';
import sharp from 'sharp';
import { processImage } from '../src/lib/images.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` | ${detail}` : ''}`);
  }
};
const rejects = async (name, promise, status) => {
  try {
    await promise;
    check(name, false, 'was accepted');
  } catch (err) {
       const got = err.status ?? err.statusCode; // AppError keeps the HTTP status under one of these names
    check(name, got === status, `status ${got}: ${err.message}`);
  }
};

const solid = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } });

// A PNG whose header CLAIMS a huge size but carries only one row of pixels (a decompression-bomb shape).
function claimedHugePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(1 + width * 3))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- accepted: three formats, always WebP out, never enlarged ----
const jpeg = await solid(1200, 700).jpeg().toBuffer();
const outJpeg = await processImage(jpeg, 'MARKET');
check('a JPEG is accepted', outJpeg.width === 1200 && outJpeg.height === 700);
check('the output is WebP', (await sharp(outJpeg.full).metadata()).format === 'webp');
check('the thumbnail is 600 px wide', (await sharp(outJpeg.thumb).metadata()).width === 600);

const png = await solid(2000, 1000).png().toBuffer();
const outPng = await processImage(png, 'MARKET');
check('a large PNG is scaled to 1600 px', outPng.width === 1600 && outPng.height === 800);

const webp = await solid(900, 500).webp().toBuffer();
check('a WebP is accepted', (await processImage(webp, 'MARKET')).width === 900);

// ---- metadata and hidden data are gone ----
const withGps = await solid(1200, 700)
  .jpeg()
  .withExif({
    IFD0: { Artist: 'secret-artist' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '90/1 24/1 0/1' },
  })
  .toBuffer();
check('the test JPEG really carries EXIF', Boolean((await sharp(withGps).metadata()).exif));
const outGps = await processImage(withGps, 'MARKET');
check('the output has no EXIF/GPS', !(await sharp(outGps.full).metadata()).exif);
check('the output does not contain the EXIF text', !outGps.full.includes('secret-artist'));

const polyglot = Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>')]);
const outPoly = await processImage(polyglot, 'MARKET');
check('a polyglot JPEG is accepted', outPoly.width === 1200);
check('the appended script is gone', !outPoly.full.includes('<script>') && !outPoly.thumb.includes('<script>'));

// ---- rotation: stored 450 x 800 with EXIF "turn 90 degrees" = displayed 800 x 450 ----
const turned = await solid(450, 800).jpeg().withMetadata({ orientation: 6 }).toBuffer();
const outTurned = await processImage(turned, 'MARKET');
check('a turned phone photo is rotated upright', outTurned.width === 800 && outTurned.height === 450);

// ---- rejected ----
await rejects('an SVG with a script is rejected', processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'MARKET'), 400);
await rejects('an HTML page is rejected', processImage(Buffer.from('<!doctype html><html><script>alert(1)</script></html>'), 'MARKET'), 400);
await rejects('a PHP file is rejected', processImage(Buffer.from('<?php system($_GET["c"]); ?>'), 'MARKET'), 400);
await rejects('a GIF is rejected', processImage(await solid(900, 500).gif().toBuffer(), 'MARKET'), 400);
await rejects('a PDF is rejected', processImage(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF'), 'MARKET'), 400);
await rejects('an empty file is rejected', processImage(Buffer.alloc(0), 'MARKET'), 400);
await rejects('a 500 x 300 photo is too small for a market', processImage(await solid(500, 300).jpeg().toBuffer(), 'MARKET'), 422);
await rejects('a decompression bomb (30000 x 30000 claimed) is rejected', processImage(claimedHugePng(30000, 30000), 'MARKET'), 400);

// the GENERAL profile has no minimum size
check('GENERAL accepts a small photo', (await processImage(await solid(500, 300).jpeg().toBuffer(), 'GENERAL')).width === 500);

console.log(`\nPassed: ${pass}   Failed: ${fail}`);
process.exit(fail ? 1 : 0);