import { prisma } from './prisma.js';
import { AppError } from './errors.js';

// Owner, staff of the shop, or admin may manage it. Everyone else gets 403.
export async function assertShopAccess(user, shopId) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, ownerId: true },
  });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (user.role === 'ADMIN' || shop.ownerId === user.id) return shop;

  const staff = await prisma.shopStaff.findUnique({
    where: { shopId_userId: { shopId, userId: user.id } },
  });
  if (!staff) throw new AppError(403, 'You do not manage this shop');
  return shop;
}