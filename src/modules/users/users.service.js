import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const MAX_ADDRESSES = 10;

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  avatarUrl: u.avatarUrl,
  createdAt: u.createdAt,
});

// ---------- my profile ----------

export async function updateProfile(userId, input) {
  if (input.phone) {
    const taken = await prisma.user.findFirst({
      where: { phone: input.phone, NOT: { id: userId } },
      select: { id: true },
    });
    if (taken) throw new AppError(409, 'This phone number is already used by another account');
  }
  const user = await prisma.user.update({ where: { id: userId }, data: input });
  return publicUser(user);
}

// ---------- my addresses ----------

export const listAddresses = (userId) =>
  prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] });

export async function createAddress(userId, input) {
  const count = await prisma.address.count({ where: { userId } });
  if (count >= MAX_ADDRESSES) throw new AppError(409, `You can save at most ${MAX_ADDRESSES} addresses`);

  const makeDefault = input.isDefault || count === 0; // the first address is always the default
  return prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.address.create({ data: { ...input, userId, isDefault: makeDefault } });
  });
}

export async function updateAddress(userId, id, input) {
  const address = await prisma.address.findFirst({ where: { id, userId } });
  if (!address) throw new AppError(404, 'Address not found');
  if (input.isDefault === false && address.isDefault) {
    throw new AppError(400, 'Make another address the default instead');
  }
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
    }
    return tx.address.update({ where: { id }, data: input });
  });
}

export async function deleteAddress(userId, id) {
  const address = await prisma.address.findFirst({ where: { id, userId } });
  if (!address) throw new AppError(404, 'Address not found');
  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id } });
    if (address.isDefault) {
      // another address takes over as the default
      const next = await tx.address.findFirst({ where: { userId }, orderBy: { id: 'asc' } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });
}

// ---------- admin: users ----------

const audit = (tx, actorId, action, entityId, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType: 'User', entityId, meta } });

export async function listUsers({ q, role, isActive, page, limit }) {
  const where = {
    ...(q && {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ],
    }),
    ...(role && { role }),
    ...(isActive !== undefined && { isActive }),
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { _count: { select: { ownedShops: true, checkouts: true } } },
    }),
  ]);
  return {
    items: rows.map((u) => ({
      ...publicUser(u),
      isActive: u.isActive,
      stats: { shopsOwned: u._count.ownedShops, checkouts: u._count.checkouts },
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getUser(id) {
  const u = await prisma.user.findUnique({
    where: { id },
    include: {
      ownedShops: { select: { id: true, name: true, slug: true, verificationLevel: true } },
      staffOf: { select: { title: true, shop: { select: { id: true, name: true, slug: true } } } },
      _count: { select: { addresses: true, reviews: true, checkouts: true, bargains: true } },
    },
  });
  if (!u) throw new AppError(404, 'User not found');
  return {
    ...publicUser(u),
    isActive: u.isActive,
    ownedShops: u.ownedShops,
    staffOf: u.staffOf.map((s) => ({ ...s.shop, title: s.title })),
    counts: u._count,
  };
}

// Blocking also ends the user's sessions. Their current access token still works until it expires (15 minutes).
export async function setUserStatus(admin, id, { isActive, reason }) {
  if (id === admin.id) throw new AppError(400, 'You cannot change your own status');
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } });
  if (!user) throw new AppError(404, 'User not found');
  if (user.isActive === isActive) {
    throw new AppError(409, isActive ? 'This user is already active' : 'This user is already blocked');
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { isActive } });
    if (!isActive) {
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit(tx, admin.id, isActive ? 'user.unblocked' : 'user.blocked', id, { reason });
  });
  return { userId: id, isActive };
}

export async function setUserRole(admin, id, { role, reason }) {
  if (id === admin.id) throw new AppError(400, 'You cannot change your own role');
  const user = await prisma.user.findUnique({
    where: { id },
    include: { _count: { select: { ownedShops: true } } },
  });
  if (!user) throw new AppError(404, 'User not found');
  if (user.role === role) throw new AppError(409, 'The user already has this role');
  if (user.role === 'SHOP_OWNER' && role !== 'SHOP_OWNER' && user._count.ownedShops > 0) {
    throw new AppError(409, 'This user owns shops. Deactivate or reassign them first.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { role } });
    // sessions end so the next login carries the new role
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, admin.id, 'user.role_changed', id, { from: user.role, to: role, reason });
  });
  return { userId: id, role };
}



// ---------- my shops (entry point for the owner area) ----------

const MAX_MY_SHOPS = 50;

// Only the fields the owner area needs: never the pre-check score, admin notes, documents or ownerId.
const myShopSelect = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  verificationLevel: true,
  levelFloor: true,
  shopNumber: true,
  createdAt: true,
  market: { select: { id: true, name: true, slug: true } },
  verifications: {
    orderBy: { submittedAt: 'desc' },
    take: 1,
    select: { id: true, status: true, targetLevel: true, submittedAt: true },
  },
};

const toMyShop = (shop, membership, staffTitle) => {
  const v = shop.verifications[0];
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    isActive: shop.isActive,
    membership,
    staffTitle,
    verificationLevel: shop.verificationLevel,
    market: shop.market,
    levelFloor: shop.levelFloor,
    shopNumber: shop.shopNumber,
    // ShopVerification has no createdAt; the moment it was submitted is the right "created" time
    latestVerification: v
      ? { id: v.id, status: v.status, targetLevel: v.targetLevel, createdAt: v.submittedAt }
      : null,
    createdAt: shop.createdAt,
  };
};

// The shops the user owns or works at: owned first, then staff; oldest first in each group.
// Shops deactivated by an admin are included, so the owner can see that state.
// A shop the user both owns and works at is listed once, as OWNER.
export async function listMyShops(userId) {
  const [owned, memberships] = await Promise.all([
    prisma.shop.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      take: MAX_MY_SHOPS,
      select: myShopSelect,
    }),
    prisma.shopStaff.findMany({
      where: { userId },
      orderBy: { shop: { createdAt: 'asc' } }, // ShopStaff has no createdAt; the shop's age decides the order
      take: MAX_MY_SHOPS,
      select: { title: true, shop: { select: myShopSelect } },
    }),
  ]);

  const ownedIds = new Set(owned.map((s) => s.id));
  return [
    ...owned.map((s) => toMyShop(s, 'OWNER', null)),
    ...memberships.filter((m) => !ownedIds.has(m.shop.id)).map((m) => toMyShop(m.shop, 'STAFF', m.title ?? null)),
  ].slice(0, MAX_MY_SHOPS);
}