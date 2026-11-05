// DEVELOPMENT TOOL: writes the image test files used by test-market-image.ps1 into a folder.
// Usage: node scripts/make-image-fixtures.mjs <folder>
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/make-image-fixtures.mjs <folder>');
  process.exit(1);
}
await mkdir(dir, { recursive: true });

const solid = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 110, b: 170 } } });

// A PNG whose header claims a huge size but carries one row of pixels (decompression-bomb shape).
function claimedHugePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(1 + width * 3))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const jpg = await solid(1200, 700).jpeg().toBuffer();
const files = {
  'valid.jpg': jpg,
  'valid.png': await solid(1000, 600).png().toBuffer(),
  'valid.webp': await solid(900, 500).webp().toBuffer(),
  'replace.jpg': await solid(1600, 900).jpeg().toBuffer(),
  'gps.jpg': await solid(1200, 700)
    .jpeg()
    .withExif({
      IFD0: { Artist: 'secret-artist' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '23/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '90/1 24/1 0/1' },
    })
    .toBuffer(),
  'polyglot.jpg': Buffer.concat([jpg, Buffer.from('<script>alert(1)</script>')]),
  'small.jpg': await solid(500, 300).jpeg().toBuffer(),
  'huge.jpg': Buffer.concat([jpg, Buffer.alloc(6 * 1024 * 1024)]),
  'bomb.png': claimedHugePng(30000, 30000),
  'plain.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500"/></svg>'),
  'script.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  'page.png': Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>'),
  'code.jpg': Buffer.from('alert(document.cookie);'),
  'shell.jpg': Buffer.from('<?php echo "not an image"; ?>'), // PHP renamed to .jpg (harmless, so antivirus leaves it alone)
  'doc.pdf': Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF'),
  'anim.gif': await solid(900, 500).gif().toBuffer(),
  'empty.jpg': Buffer.alloc(0),
  'text.png': Buffer.from('just some text, not an image'),
};
for (const [name, data] of Object.entries(files)) await writeFile(path.join(dir, name), data);
console.log(`wrote ${Object.keys(files).length} files to ${dir}`);