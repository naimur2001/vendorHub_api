// DEVELOPMENT TOOL: checks that CLIP works. Usage: node --env-file=.env scripts/check-clip.mjs
// The first run downloads the model (needs internet once); later runs work offline.
import sharp from 'sharp';
import { embedImage, embedTexts } from '../src/lib/clip.js';

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const square = (color) =>
  sharp({ create: { width: 300, height: 300, channels: 3, background: color } }).png().toBuffer();

const started = Date.now();
const red = await embedImage(await square('#ff0000'));
const blue = await embedImage(await square('#0000ff'));
const [redText, blueText] = await embedTexts(['a red square', 'a blue square']);
const loadAndFirst = Date.now() - started;

const t = Date.now();
await embedImage(await square('#00aa00'));
const oneImage = Date.now() - t;

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) fail += 1;
};
check('a fingerprint has 512 numbers', red.length === 512 && redText.length === 512);
check('the red picture is closer to "a red square"', dot(red, redText) > dot(red, blueText));
check('the blue picture is closer to "a blue square"', dot(blue, blueText) > dot(blue, redText));
console.log(`\nfirst run (load + 4 fingerprints): ${loadAndFirst} ms, one more picture: ${oneImage} ms`);
process.exit(fail ? 1 : 0);