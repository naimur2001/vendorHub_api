// Product photos for shops and admins: the same pipeline as market photos (type from content,
// pixel limit, minimum 480 x 270, re-encoded WebP + thumbnail, server-chosen names).
// The Image table is the source of truth; Product.images keeps the public URLs in the same order,
// so every existing reader of product.images keeps working unchanged.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage, imageUrls } from '../../lib/storage.js';

const MAX_PHOTOS = 6;

const present = (productId, photos) => ({
  productId,
  images: photos.map((p) => imageUrls(p.key).url),
  photos: photos.map((p) => ({ id: p.id, ...imageUrls(p.key), width: p.width, height: p.height })),
});

const loadProduct = (productId) =>
  prisma.product.findUnique({ where: { id: productId }, include: { photos: { orderBy: { sortOrder: 'asc' } } } });

/**
 * Adds one photo. `check(product)` decides who may change the product (shop rule or admin);
 * `lock` = true when an admin changes it (an admin change locks the product for shops).
 */
export async function addPhoto(actor, productId, file, { check, lock }) {
  if (!file) throw new AppError(400, 'Send exactly one photo in the multipart field "image"');
  const product = await loadProduct(productId);
  await check(product);
  if (product.photos.length >= MAX_PHOTOS) throw new AppError(409, `A product can have at most ${MAX_PHOTOS} photos`);

  const processed = await processImage(file.buffer, 'PRODUCT');
  const staged = await stageImage(processed);
  await staged.commit(); // published before the database points at it (never a missing file)

  const url = imageUrls(staged.key).url;
  const nextOrder = product.photos.length ? product.photos[product.photos.length - 1].sortOrder + 1 : 0;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.image.create({
        data: { key: staged.key, width: processed.width, height: processed.height, purpose: 'PRODUCT', ownerId: actor.id, productId, sortOrder: nextOrder },
      });
      await tx.product.update({
        where: { id: productId },
        data: { images: { push: url }, ...(lock && { lockedAt: new Date() }) },
      });
      await tx.auditLog.create({
        data: { actorId: actor.id, action: 'catalog.product_photo_added', entityType: 'Product', entityId: productId, meta: { key: staged.key } },
      });
    });
  } catch (err) {
    await removeImage(staged.key).catch(() => {});
    throw err;
  }
  const after = await loadProduct(productId);
  return present(productId, after.photos);
}

export async function removePhoto(actor, productId, imageId, { check, lock }) {
  const product = await loadProduct(productId);
  await check(product);
  const photo = product.photos.find((p) => p.id === imageId);
  if (!photo) throw new AppError(404, 'Photo not found');

  const url = imageUrls(photo.key).url;
  await prisma.$transaction([
    prisma.image.delete({ where: { id: imageId } }),
    prisma.product.update({
      where: { id: productId },
      data: { images: product.images.filter((u) => u !== url), ...(lock && { lockedAt: new Date() }) },
    }),
    prisma.auditLog.create({
      data: { actorId: actor.id, action: 'catalog.product_photo_removed', entityType: 'Product', entityId: productId, meta: { key: photo.key } },
    }),
  ]);
  await removeImage(photo.key).catch(() => {}); // files go after the database no longer points at them
  const after = await loadProduct(productId);
  return present(productId, after.photos);
}