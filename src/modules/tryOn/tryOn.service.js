import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { detectFileType } from '../../lib/fileType.js';
import { runTryOn } from '../../lib/tryOn.js';
import { VIEWS } from './tryOn.schema.js';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_GARMENT_BYTES = 8 * 1024 * 1024;

const BASE_PROMPT =
  'The first image shows a customer. The second image shows a clothing product. ' +
  "Create a photorealistic, full-body picture of THIS customer wearing THIS product. Keep the customer's face, " +
  'skin tone, hair and body shape exactly. Keep the garment colour, pattern, logo and details exactly. ' +
  'Plain light background, natural light, no text.';

const VIEW_PROMPT = {
  LEFT: 'View: the customer is turned 90 degrees so the camera sees their LEFT side (left profile).',
  LEFT_45: 'View: the customer is turned about 45 degrees to their left (three-quarter view, left side visible).',
  FRONT: 'View: the customer faces the camera (front view).',
  RIGHT_45: 'View: the customer is turned about 45 degrees to their right (three-quarter view, right side visible).',
  RIGHT: 'View: the customer is turned 90 degrees so the camera sees their RIGHT side (right profile).',
};

const REFERENCE_PROMPT =
  'The third image shows the same customer already wearing the product. Keep the person and the garment identical to it.';

// In-memory daily counter per customer (protects the free AI quota). It resets when the server restarts.
const usage = new Map();

function takeQuota(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const u = usage.get(userId);
  const count = u && u.day === today ? u.count : 0;
  if (count >= env.TRYON_DAILY_LIMIT) {
    throw new AppError(429, `You can create ${env.TRYON_DAILY_LIMIT} try-on pictures per day`);
  }
  usage.set(userId, { day: today, count: count + 1 });
}

function giveBackQuota(userId) {
  const u = usage.get(userId);
  if (u && u.count > 0) u.count -= 1;
}

// The customer photo (and the optional reference) must really be an image.
function readImage(file, label) {
  if (!file) return null;
  const type = detectFileType(file.buffer);
  if (!type || !PHOTO_TYPES.includes(type.mime)) {
    throw new AppError(400, `The ${label} must be a JPEG, PNG or WEBP image`);
  }
  return { buffer: file.buffer, mimeType: type.mime };
}

// The product photo: from our own upload folder, or downloaded (with a time and size limit).
async function loadGarment(url) {
  const ownPrefix = `${env.PUBLIC_API_URL}/uploads/public/`;
  let buffer;
  try {
    if (url.startsWith(ownPrefix)) {
      const name = path.basename(url.slice(ownPrefix.length)); // basename: no "../" tricks
      buffer = await readFile(path.resolve(env.UPLOAD_DIR, 'public', name));
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    }
  } catch {
    throw new AppError(409, 'The product photo could not be loaded');
  }
  if (buffer.length > MAX_GARMENT_BYTES) throw new AppError(409, 'The product photo is too large');
  const type = detectFileType(buffer);
  if (!type || !PHOTO_TYPES.includes(type.mime)) throw new AppError(409, 'The product photo is not a usable image');
  return { buffer, mimeType: type.mime };
}

// ---------- public ----------

export async function tryOnInfo(slug) {
  const product = await prisma.product.findFirst({
    where: { slug, isActive: true },
    select: { images: true, category: { select: { virtualTryOn: true } } },
  });
  if (!product) throw new AppError(404, 'Product not found');
  const available = product.category.virtualTryOn && product.images.length > 0;
  return {
    available,
    views: available ? VIEWS : [], // rolling order, left side to right side
    startView: 'FRONT',
    createOrder: available ? ['FRONT', 'LEFT_45', 'RIGHT_45', 'LEFT', 'RIGHT'] : [],
    dailyLimit: env.TRYON_DAILY_LIMIT,
    note: 'AI preview: fit and colour may differ. Your photo is not stored by Vendors Hub.',
  };
}

// ---------- customer ----------

export async function generate(user, { productId, view }, files) {
  const product = await prisma.product.findFirst({
    where: { id: productId, isActive: true },
    select: { title: true, images: true, category: { select: { virtualTryOn: true } } },
  });
  if (!product) throw new AppError(404, 'Product not found');
  if (!product.category.virtualTryOn) throw new AppError(409, 'Virtual try-on is not available for this product');
  if (product.images.length === 0) throw new AppError(409, 'This product has no photo to try on');

  const person = readImage(files?.photo?.[0], 'photo');
  if (!person) throw new AppError(400, 'Attach your photo in a multipart field named "photo"');
  const reference = readImage(files?.reference?.[0], 'reference picture');

  takeQuota(user.id);
  try {
    // in mock mode the product photo is not needed (seed products may have placeholder links)
    const garment = env.TRYON_MODE === 'mock' ? person : await loadGarment(product.images[0]);
    const prompt = [BASE_PROMPT, VIEW_PROMPT[view], reference ? REFERENCE_PROMPT : ''].join(' ');
    const image = await runTryOn({ person, garment, reference, prompt });
    return {
      view,
      product: product.title,
      image: `data:${image.mimeType};base64,${image.data}`, // shown directly by the browser, never stored
      note: 'AI preview: fit and colour may differ.',
    };
  } catch (err) {
    giveBackQuota(user.id); // a failed picture does not count
    throw err;
  }
}

// ---------- admin ----------

export async function setCategoryTryOn(admin, id, { enabled }) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw new AppError(404, 'Category not found');
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.category.update({ where: { id }, data: { virtualTryOn: enabled } });
    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: enabled ? 'catalog.try_on_enabled' : 'catalog.try_on_disabled',
        entityType: 'Category',
        entityId: id,
        meta: { name: category.name },
      },
    });
    return c;
  });
  return { id: updated.id, name: updated.name, virtualTryOn: updated.virtualTryOn };
}