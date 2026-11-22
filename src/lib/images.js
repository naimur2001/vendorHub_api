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
// Animated GIFs (only for profiles with animated: true) become animated WebP.
// All frames together are limited, and so is the number of frames.
export const MAX_ANIMATED_PIXELS = 60_000_000;
export const MAX_FRAMES = 150;

// Size profiles: the main and thumbnail widths, and the smallest accepted photo.
export const IMAGE_PROFILES = Object.freeze({
  MARKET: Object.freeze({ width: 1600, thumbWidth: 600, minWidth: 480, minHeight: 270 }),
  GENERAL: Object.freeze({ width: 2048, thumbWidth: 600, minWidth: 1, minHeight: 1 }),
  PRODUCT: Object.freeze({ width: 1600, thumbWidth: 600, minWidth: 480, minHeight: 270 }),
  // logo: square, center-cropped to exactly 512 x 512 (+128 thumbnail)
  LOGO: Object.freeze({ width: 512, height: 512, thumbWidth: 128, thumbHeight: 128, minWidth: 200, minHeight: 200, crop: true, enlarge: true }),
  // banner: exactly 1600 wide (+800 thumbnail)
  BANNER: Object.freeze({ width: 1600, thumbWidth: 800, minWidth: 1200, minHeight: 300, enlarge: true }),
  // home page billboard: landscape, 3:1 recommended (e.g. 1800 x 600); GIFs stay animated
  HOME_BANNER: Object.freeze({ width: 1800, thumbWidth: 900, minWidth: 900, minHeight: 300, animated: true }),
  // a buyer's photo on a review
  REVIEW: Object.freeze({ width: 1600, thumbWidth: 400, minWidth: 300, minHeight: 300 }),
  // home page side advertisement: tall, 2:3 recommended (e.g. 600 x 900); GIFs stay animated
  SIDE_AD: Object.freeze({ width: 900, thumbWidth: 450, minWidth: 300, minHeight: 400, animated: true }),
  // optional phone version of a home banner (portrait or smaller)
  HOME_BANNER_MOBILE: Object.freeze({ width: 1080, thumbWidth: 540, minWidth: 400, minHeight: 300, animated: true }),
    // search by photo: never stored; re-encoded (no EXIF/GPS) and made small before it goes to the AI
  SEARCH: Object.freeze({ width: 1024, thumbWidth: 64, minWidth: 1, minHeight: 1 }),
});

// Fixed messages: the uploaded file name or content is never echoed back.
const NOT_ALLOWED = 'Only JPG, PNG or WebP photos are allowed';
const NOT_ALLOWED_ANIMATED = 'Only JPG, PNG, WebP or GIF images are allowed';
const UNREADABLE = 'The photo could not be read';
const TOO_LARGE = 'The photo is too large to process';

// Every decoder instance gets the same safety options.
// failOn 'error': real decoding errors abort; harmless warnings (common in phone photos) do not.
const decoder = (buffer) => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });

/**
 * Validates an uploaded image and re-encodes it into a main WebP and a thumbnail WebP.
 * @param {Buffer} buffer        the uploaded bytes (kept in memory by multer)
 * @param {keyof IMAGE_PROFILES} profileName
 * @returns {Promise<{ full: Buffer, thumb: Buffer, width: number, height: number, animated: boolean }>}
 */
export async function processImage(buffer, profileName) {
  const profile = IMAGE_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown image profile: ${profileName}`);
  const notAllowed = profile.animated ? NOT_ALLOWED_ANIMATED : NOT_ALLOWED;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AppError(400, notAllowed);

  // 1a. our allow-list, from the first bytes
  const type = detectFileType(buffer);
  const gif = Boolean(profile.animated && type?.mime === 'image/gif');
  if (!type || (!ALLOWED_MIME.has(type.mime) && !gif)) throw new AppError(400, notAllowed);
  if (gif) return processGif(buffer, profile);

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
  const render = (targetWidth, targetHeight) =>
    decoder(buffer)
      .rotate()
      .resize({
        width: targetWidth,
        ...(targetHeight && { height: targetHeight }),
        fit: profile.crop ? 'cover' : 'inside', // cover = center crop to the exact size
        position: 'centre',
        withoutEnlargement: !profile.enlarge,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

  try {
      const [full, thumb] = await Promise.all([
      render(profile.width, profile.height),
      render(profile.thumbWidth, profile.thumbHeight),
    ]);
    return { full: full.data, thumb: thumb.data, width: full.info.width, height: full.info.height, animated: false };
  } catch {
    throw new AppError(400, UNREADABLE);
  }
}

// A GIF: every frame is decoded and re-encoded as an (animated) WebP; the thumbnail is the first frame.
// The GIF bytes themselves are never stored or served.
const gifDecoder = (buffer, animated) =>
  sharp(buffer, { animated, limitInputPixels: MAX_ANIMATED_PIXELS, failOn: 'error' });

async function processGif(buffer, profile) {
  let meta;
  try {
    meta = await gifDecoder(buffer, true).metadata();
  } catch {
    throw new AppError(400, UNREADABLE);
  }
  if (meta.format !== 'gif') throw new AppError(400, NOT_ALLOWED_ANIMATED);
  const pages = meta.pages ?? 1;
  const width = meta.width;
  const height = meta.pageHeight ?? meta.height; // the height of ONE frame
  if (!width || !height) throw new AppError(400, UNREADABLE);
  if (pages > MAX_FRAMES || width * height * pages > MAX_ANIMATED_PIXELS) throw new AppError(400, TOO_LARGE);
  if (width < profile.minWidth || height < profile.minHeight) {
    throw new AppError(422, `The photo is too small (at least ${profile.minWidth} x ${profile.minHeight} pixels)`);
  }

  const resize = (w) => ({ width: w, fit: 'inside', withoutEnlargement: true });
  try {
    const [full, thumb] = await Promise.all([
      gifDecoder(buffer, true).resize(resize(profile.width)).webp({ quality: WEBP_QUALITY }).toBuffer({ resolveWithObject: true }),
      gifDecoder(buffer, false).resize(resize(profile.thumbWidth)).webp({ quality: WEBP_QUALITY }).toBuffer(),
    ]);
    const outWidth = full.info.width;
    return {
      full: full.data,
      thumb,
      width: outWidth,
      height: Math.round((height * outWidth) / width),
      animated: pages > 1,
    };
  } catch {
    throw new AppError(400, UNREADABLE);
  }
}