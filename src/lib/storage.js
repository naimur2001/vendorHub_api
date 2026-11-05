// Storage helper for processed public images. Today: the local disk (a Docker volume in production).
// Later: S3-compatible object storage behind the same functions, so callers do not change.
//
// Rules: every name is chosen here (randomUUID + ".webp"); no user input ever reaches a path.
// New files are written to a staging folder first and only become public on commit(), so a
// failed database update never leaves a public file behind, and a market never points at a
// missing file.
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { env } from '../config/env.js';

const MEDIA_DIR = path.resolve(env.UPLOAD_DIR, 'media');
const STAGING_DIR = path.resolve(env.UPLOAD_DIR, 'staging');

// The ONLY names that can ever be served: <uuid>.webp and <uuid>-thumb.webp.
const MEDIA_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-thumb)?\.webp$/;

const namesFor = (key) => [`${key}.webp`, `${key}-thumb.webp`];

async function removeQuietly(file) {
  try {
    await unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Writes the processed files into the staging folder. Nothing is public until commit().
 * @returns {Promise<{ key: string, commit: () => Promise<void>, discard: () => Promise<void> }>}
 */
export async function stageImage({ full, thumb }) {
  const key = crypto.randomUUID();
  const [fullName, thumbName] = namesFor(key);
  await mkdir(STAGING_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });

  const staged = [path.join(STAGING_DIR, fullName), path.join(STAGING_DIR, thumbName)];
  const published = [path.join(MEDIA_DIR, fullName), path.join(MEDIA_DIR, thumbName)];
  try {
    await writeFile(staged[0], full, { flag: 'wx' }); // wx: never overwrite an existing file
    await writeFile(staged[1], thumb, { flag: 'wx' });
  } catch (err) {
    await Promise.all(staged.map(removeQuietly));
    throw err;
  }

  return {
    key,
    // Moves both files into the public folder (same disk, so every move is atomic).
    async commit() {
      try {
        await rename(staged[0], published[0]);
        await rename(staged[1], published[1]);
      } catch (err) {
        await Promise.all([...staged, ...published].map(removeQuietly));
        throw err;
      }
    },
    async discard() {
      await Promise.all(staged.map(removeQuietly));
    },
  };
}

/** Deletes both files of a published image (missing files are fine). */
export async function removeImage(key) {
  if (!key) return;
  await Promise.all(namesFor(key).map((name) => removeQuietly(path.join(MEDIA_DIR, name))));
}

/** Maps a requested name to a file inside the media folder, or null when the name is not allowed. */
export function mediaFilePath(name) {
  return typeof name === 'string' && MEDIA_NAME.test(name) ? path.join(MEDIA_DIR, name) : null;
}

/** Public URLs on our own API origin, built from the key (never stored). */
export function imageUrls(key) {
  return {
    url: `${env.PUBLIC_API_URL}/media/${key}.webp`,
    thumbUrl: `${env.PUBLIC_API_URL}/media/${key}-thumb.webp`,
  };
}


/** The public "image" object for API answers, or null. */
export const presentImage = (img) => (img ? { ...imageUrls(img.key), width: img.width, height: img.height } : null);