import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

const MAX_PHOTOS = 12;

const present = (p) => ({
  id: p.id,
  kind: p.kind,
  caption: p.caption,
  url: p.url,
  isCover: p.isCover,
  sortOrder: p.sortOrder,
  verified: p.verifiedAt !== null,
  verifiedAt: p.verifiedAt,
  createdAt: p.createdAt,
});

// Photos are part of the shop profile, so only the owner (or an admin) manages them, like PATCH /shops/:shopId.
async function assertShopOwner(user, shopId) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (user.role !== 'ADMIN' && shop.ownerId !== user.id) {
    throw new AppError(403, 'Only the shop owner can manage shop photos');
  }
}

async function findPhoto(shopId, photoId) {
  const photo = await prisma.shopPhoto.findFirst({ where: { id: photoId, shopId } });
  if (!photo) throw new AppError(404, 'Photo not found');
  return photo;
}

// ---------- public ----------

export async function listPhotos(slug) {
  const shop = await prisma.shop.findFirst({ where: { slug, isActive: true }, select: { id: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  const photos = await prisma.shopPhoto.findMany({
    where: { shopId: shop.id },
    orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return photos.map(present);
}

// ---------- shop owner ----------

export async function addPhoto(user, shopId, { uploadId, kind, caption, isCover }) {
  await assertShopOwner(user, shopId);

  // The photo must be a public image uploaded through our own upload endpoint by this user
  // (admins may use any upload): no hotlinked images, and the file type was already checked.
  const file = await prisma.fileUpload.findUnique({ where: { id: uploadId } });
  if (!file || file.purpose !== 'PUBLIC_IMAGE' || (file.ownerId !== user.id && user.role !== 'ADMIN')) {
    throw new AppError(400, 'Upload the photo first with POST /uploads?purpose=PUBLIC_IMAGE and send its id');
  }

  const count = await prisma.shopPhoto.count({ where: { shopId } });
  if (count >= MAX_PHOTOS) throw new AppError(409, `A shop can have at most ${MAX_PHOTOS} photos`);
  const duplicate = await prisma.shopPhoto.findFirst({ where: { shopId, fileId: uploadId }, select: { id: true } });
  if (duplicate) throw new AppError(409, 'This photo is already in the gallery');

  const makeCover = isCover === true || count === 0; // the first photo is always the cover
  const photo = await prisma.$transaction(async (tx) => {
    if (makeCover) await tx.shopPhoto.updateMany({ where: { shopId, isCover: true }, data: { isCover: false } });
    return tx.shopPhoto.create({
      data: {
        shopId,
        fileId: uploadId,
        url: `${env.PUBLIC_API_URL}/uploads/public/${file.storedName}`,
        kind,
        caption: caption ?? null,
        sortOrder: count,
        isCover: makeCover,
      },
    });
  });
  return present(photo);
}

export async function updatePhoto(user, shopId, photoId, input) {
  await assertShopOwner(user, shopId);
  await findPhoto(shopId, photoId);
  const photo = await prisma.$transaction(async (tx) => {
    if (input.isCover) await tx.shopPhoto.updateMany({ where: { shopId, isCover: true }, data: { isCover: false } });
    return tx.shopPhoto.update({ where: { id: photoId }, data: input });
  });
  return present(photo);
}

// The uploaded file itself stays on disk; only the gallery entry is removed.
export async function deletePhoto(user, shopId, photoId) {
  await assertShopOwner(user, shopId);
  const photo = await findPhoto(shopId, photoId);
  await prisma.$transaction(async (tx) => {
    await tx.shopPhoto.delete({ where: { id: photoId } });
    if (photo.isCover) {
      // another photo takes over as the cover
      const next = await tx.shopPhoto.findFirst({ where: { shopId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      if (next) await tx.shopPhoto.update({ where: { id: next.id }, data: { isCover: true } });
    }
  });
}

// ---------- admin ----------

// An admin marks a photo as checked against the real shop (for example during physical verification).
export async function verifyPhoto(admin, shopId, photoId, { verified }) {
  await findPhoto(shopId, photoId);
  const photo = await prisma.$transaction(async (tx) => {
    const updated = await tx.shopPhoto.update({
      where: { id: photoId },
      data: { verifiedAt: verified ? new Date() : null, verifiedById: verified ? admin.id : null },
    });
    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: verified ? 'shop.photo_verified' : 'shop.photo_unverified',
        entityType: 'Shop',
        entityId: shopId,
        meta: { photoId },
      },
    });
    return updated;
  });
  return present(photo);
}