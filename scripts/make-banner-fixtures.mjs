// DEVELOPMENT TOOL: writes the test files used by test-banners.ps1 into a folder.
// Usage: node scripts/make-banner-fixtures.mjs <folder>
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/make-banner-fixtures.mjs <folder>');
  process.exit(1);
}
await mkdir(dir, { recursive: true });

const solid = (w, h, r, g, b) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } });
const frame = (r) => solid(1200, 400, r, 80, 160).png().toBuffer();

const files = {
  'banner.png': await solid(1800, 600, 20, 90, 160).png().toBuffer(),
  'mobile.jpg': await solid(900, 1200, 160, 60, 40).jpeg().toBuffer(),
  // two frames -> must stay animated (stored as animated WebP)
  'anim.gif': await sharp([await frame(30), await frame(200)], { join: { animated: true } })
    .gif({ delay: [300, 300], loop: 0 })
    .toBuffer(),
  'small.png': await solid(600, 200, 0, 0, 0).png().toBuffer(),
  // side advertisement: tall 2:3, and one below its 300 x 400 minimum
  'side.png': await solid(600, 900, 90, 30, 120).png().toBuffer(),
  'side-small.png': await solid(280, 420, 90, 30, 120).png().toBuffer(),
  // gallery: square 1200 x 1200 (recommended), and one below its 600 x 600 minimum
  'gallery.png': await solid(1200, 1200, 40, 140, 90).png().toBuffer(),
  'gallery-small.png': await solid(500, 700, 40, 140, 90).png().toBuffer(),
  // random noise does not compress: well over 5 MB
  'big.png': await sharp(crypto.randomBytes(2600 * 1000 * 3), { raw: { width: 2600, height: 1000, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer(),
  'evil.svg': Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="600" onload="alert(1)">' +
      '<script>alert(document.cookie)</script><rect width="1800" height="600" fill="red"/></svg>',
  ),
  'fake.png': Buffer.from('this is not an image, only a renamed text file'),
};
for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
console.log(Object.keys(files).join(' '));
