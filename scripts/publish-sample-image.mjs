// DEVELOPMENT TOOL: runs one generated photo through the real pipeline and publishes it to the media
// folder, then prints its URLs. Usage: node --env-file=.env scripts/publish-sample-image.mjs
import sharp from 'sharp';
import { processImage } from '../src/lib/images.js';
import { stageImage, imageUrls } from '../src/lib/storage.js';

const input = await sharp({ create: { width: 1200, height: 700, channels: 3, background: { r: 30, g: 120, b: 200 } } })
  .jpeg()
  .toBuffer();
const processed = await processImage(input, 'MARKET');
const staged = await stageImage(processed);
await staged.commit();
console.log(JSON.stringify({ key: staged.key, ...imageUrls(staged.key) }));