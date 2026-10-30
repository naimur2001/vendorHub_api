import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';

// Only the owner (or an admin) manages the team; staff cannot add or remove each other.
async function loadShopForOwner(user, shopId) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, ownerId: true },
  });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (user.role !== 'ADMIN' && shop.ownerId !== user.id) {
    throw new AppError(403, 'Only the shop owner can manage staff');
  }
  return shop;
}

const audit = (tx, actorId, action, shopId, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType: 'Shop', entityId: shopId, meta } });

export async function listStaff(user, shopId) {
  await assertShopAccess(user, shopId);
  const [shop, staff] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { owner: { select: { id: true, name: true, email: true } } },
    }),
    prisma.shopStaff.findMany({
      where: { shopId },
      include: { user: { select: { name: true, email: true, phone: true } } },
    }),
  ]);
  return {
    owner: shop.owner,
    staff: staff.map((s) => ({
      userId: s.userId,
      name: s.user.name,
      email: s.user.email,
      phone: s.user.phone,
      title: s.title,
    })),
  };
}

export async function addStaff(user, shopId, { email, title }) {
  const shop = await loadShopForOwner(user, shopId);
  const target = await prisma.user.findUnique({ where: { email } });
  if (!target || !target.isActive) throw new AppError(404, 'No active user has that email');
  if (target.id === shop.ownerId) throw new AppError(400, 'The owner is already part of the shop team');
  if (target.role === 'ADMIN') throw new AppError(400, 'Admins already have access to every shop');

  const existing = await prisma.shopStaff.findUnique({
    where: { shopId_userId: { shopId, userId: target.id } },
  });
  if (existing) throw new AppError(409, 'This user is already on the shop team');

  // the shop routes need the SHOP_STAFF role, so a plain customer is upgraded
  const upgrade = target.role === 'CUSTOMER';
  await prisma.$transaction(async (tx) => {
    await tx.shopStaff.create({ data: { shopId, userId: target.id, title: title ?? null } });
    if (upgrade) {
      await tx.user.update({ where: { id: target.id }, data: { role: 'SHOP_STAFF' } });
      // sessions end so the next login carries the new role
      await tx.refreshToken.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit(tx, user.id, 'shop.staff_added', shopId, { userId: target.id, title: title ?? null });
  });
  return { userId: target.id, name: target.name, email: target.email, title: title ?? null, mustLogInAgain: upgrade };
}

export async function removeStaff(user, shopId, userId) {
  await loadShopForOwner(user, shopId);
  const row = await prisma.shopStaff.findUnique({ where: { shopId_userId: { shopId, userId } } });
  if (!row) throw new AppError(404, 'This user is not on the shop team');

  await prisma.$transaction(async (tx) => {
    await tx.shopStaff.delete({ where: { shopId_userId: { shopId, userId } } });

    // a user with no team memberships and no shops goes back to being a customer
    const target = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    const [memberships, owned] = await Promise.all([
      tx.shopStaff.count({ where: { userId } }),
      tx.shop.count({ where: { ownerId: userId } }),
    ]);
    if (target.role === 'SHOP_STAFF' && memberships === 0 && owned === 0) {
      await tx.user.update({ where: { id: userId }, data: { role: 'CUSTOMER' } });
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit(tx, user.id, 'shop.staff_removed', shopId, { userId });
  });
}