// Shop logo and banner: the market-photo pipeline (type from content, pixel limit, minimum size,
// re-encoded WebP + thumbnail, server-chosen names). The Image table is the source of truth;
// logoUrl / bannerUrl keep the public /media URL so every existing reader keeps working.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage, imageUrls } from '../../lib/storage.js';

const KINDS = {
  logo: { profile: 'LOGO', idField: 'logoImageId', urlField: 'logoUrl', action: 'shop.logo', label: 'logo' },
  banner: { profile: 'BANNER', idField: 'bannerImageId', urlField: 'bannerUrl', action: 'shop.banner', label: 'banner' },
};

// Only the shop's owner or an admin (staff manage listings, not the shop's look).
async function ownerOrAdmin(user, shopId) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (user.role !== 'ADMIN' && shop.ownerId !== user.id) throw new AppError(403, 'Only the shop owner can change this');
  return shop;
}

export async function setShopImage(user, shopId, kindName, file) {
  const k = KINDS[kindName];
  if (!file) throw new AppError(400, 'Send exactly one photo in the multipart field "image"');
  const shop = await ownerOrAdmin(user, shopId);
  const old = shop[k.idField] ? await prisma.image.findUnique({ where: { id: shop[k.idField] } }) : null;

  const processed = await processImage(file.buffer, k.profile);
  const staged = await stageImage(processed);
  await staged.commit(); // published before the database points at it
  const urls = imageUrls(staged.key);
  try {
    await prisma.$transaction(async (tx) => {
      const img = await tx.image.create({
        data: { key: staged.key, width: processed.width, height: processed.height, purpose: k.profile, ownerId: user.id },
      });
      await tx.shop.update({ where: { id: shopId }, data: { [k.idField]: img.id, [k.urlField]: urls.url } });
      if (old) await tx.image.delete({ where: { id: old.id } });
      await tx.auditLog.create({
        data: { actorId: user.id, action: `${k.action}_set`, entityType: 'Shop', entityId: shopId, meta: { name: shop.name } },
      });
    });
  } catch (err) {
    await removeImage(staged.key).catch(() => {});
    throw err;
  }
  if (old) await removeImage(old.key).catch(() => {}); // old files only after the database update
  return { shopId, url: urls.url, thumbUrl: urls.thumbUrl, width: processed.width, height: processed.height };
}

export async function removeShopImage(user, shopId, kindName) {
  const k = KINDS[kindName];
  const shop = await ownerOrAdmin(user, shopId);
  if (!shop[k.idField] && !shop[k.urlField]) throw new AppError(404, `This shop has no ${k.label}`);
  const img = shop[k.idField] ? await prisma.image.findUnique({ where: { id: shop[k.idField] } }) : null;
  await prisma.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: shopId }, data: { [k.idField]: null, [k.urlField]: null } });
    if (img) await tx.image.delete({ where: { id: img.id } });
    await tx.auditLog.create({
      data: { actorId: user.id, action: `${k.action}_removed`, entityType: 'Shop', entityId: shopId, meta: { name: shop.name } },
    });
  });
  if (img) await removeImage(img.key).catch(() => {});
}