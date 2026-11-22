import { prisma } from './prisma.js';
import { AppError } from './errors.js';

// Only the shop's own team (owner or staff), not admins: daily hours, customer chats.
// 404 for an unknown shop, 403 for anyone else.
export async function assertShopTeam(user, shopId) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, ownerId: true, staff: { where: { userId: user.id }, select: { userId: true } } },
  });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (shop.ownerId !== user.id && shop.staff.length === 0) throw new AppError(403, 'You do not manage this shop');
  return shop;
}

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