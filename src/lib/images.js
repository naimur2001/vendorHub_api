// The single image pipeline for every PUBLIC image (markets, shop photos, avatars, product images).
//
// Security model:
//   1. The type comes from the CONTENT: our magic-byte allow-list (JPEG, PNG, WebP), and the decoder
//      must independently agree. Names, extensions and Content-Type headers are never trusted.
//   2. The header is read first; images claiming more than MAX_INPUT_PIXELS are refused BEFORE any
//      pixel is decoded (decompression bombs).
//   3. Every image is DECODED and RE-ENCODED as new WebP files. Only decoded pixels are written, so
//      EXIF/GPS metadata and any data hidden in or appended to the original (polyglots) are dropped.
//      The original bytes are never stored or served.
import sharp from 'sharp';
import { AppError } from './errors.js';
import { detectFileType } from './fileType.js';

export const MAX_INPUT_PIXELS = 40_000_000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const WEBP_QUALITY = 82;

// Size profiles: the main and thumbnail widths, and the smallest accepted photo.
export const IMAGE_PROFILES = Object.freeze({
  MARKET: Object.freeze({ width: 1600, thumbWidth: 600, minWidth: 480, minHeight: 270 }),
  GENERAL: Object.freeze({ width: 2048, thumbWidth: 600, minWidth: 1, minHeight: 1 }),
});

// Fixed messages: the uploaded file name or content is never echoed back.
const NOT_ALLOWED = 'Only JPG, PNG or WebP photos are allowed';
const UNREADABLE = 'The photo could not be read';
const TOO_LARGE = 'The photo is too large to process';

// Every decoder instance gets the same safety options.
// failOn 'error': real decoding errors abort; harmless warnings (common in phone photos) do not.
const decoder = (buffer) => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });

/**
 * Validates an uploaded image and re-encodes it into a main WebP and a thumbnail WebP.
 * @param {Buffer} buffer        the uploaded bytes (kept in memory by multer)
 * @param {keyof IMAGE_PROFILES} profileName
 * @returns {Promise<{ full: Buffer, thumb: Buffer, width: number, height: number }>}
 */
export async function processImage(buffer, profileName) {
  const profile = IMAGE_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown image profile: ${profileName}`);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AppError(400, NOT_ALLOWED);

  // 1a. our allow-list, from the first bytes
  const type = detectFileType(buffer);
  if (!type || !ALLOWED_MIME.has(type.mime)) throw new AppError(400, NOT_ALLOWED);

  // 2. header only: the format according to the decoder, and the CLAIMED size
  let meta;
  try {
    meta = await decoder(buffer).metadata();
  } catch {
    throw new AppError(400, UNREADABLE);
  }
  // 1b. the decoder must independently agree on the format
  if (!ALLOWED_FORMATS.has(meta.format)) throw new AppError(400, NOT_ALLOWED);
  if (!meta.width || !meta.height) throw new AppError(400, UNREADABLE);
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new AppError(400, TOO_LARGE);

  // EXIF orientation 5-8 means the photo is stored turned by 90 degrees: compare the size as displayed
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;
  if (width < profile.minWidth || height < profile.minHeight) {
    throw new AppError(422, `The photo is too small (at least ${profile.minWidth} x ${profile.minHeight} pixels)`);
  }

  // 3. decode and RE-ENCODE (auto-rotate from EXIF, never enlarge, no metadata in the output)
  const render = (targetWidth) =>
    decoder(buffer)
      .rotate()
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

  try {
    const [full, thumb] = await Promise.all([render(profile.width), render(profile.thumbWidth)]);
    return { full: full.data, thumb: thumb.data, width: full.info.width, height: full.info.height };
  } catch {
    throw new AppError(400, UNREADABLE);
  }
}