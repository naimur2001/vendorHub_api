// Shop-made catalog products: a verified shop adds a new product together with its own listing.
// Owners keep them up to date; admins check now and then and lock or hide bad products.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { uniqueSlug } from '../../lib/slug.js';
import { assertShopAccess } from '../../lib/shopAccess.js';
import { deriveAvailability } from '../listings/listings.service.js';
import { fingerprintProductTitles, inBackground } from '../../lib/fingerprints.js';
const DAILY_LIMIT = 20;
const LEVEL_RANK = { UNVERIFIED: 0, DOCUMENTS_VERIFIED: 1, BUSINESS_VERIFIED: 2, PHYSICAL_SHOP_VERIFIED: 3, TRUSTED_VENDOR: 4 };
const MIN_LEVEL_TO_CREATE = 'DOCUMENTS_VERIFIED';
const LOCKED = 'Only Vendors Hub can change this product now';
const IDENTITY_FIELDS = ['title', 'categoryId', 'brandId'];

const productInclude = {
  brand: { select: { id: true, name: true } },
  category: { select: { id: true, name: true, slug: true } },
};

const presentProduct = (p) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  description: p.description,
  specs: p.specs,
  msrp: p.msrp,
  images: p.images,
  brand: p.brand,
  category: p.category,
  source: p.source,
  createdByShopId: p.createdByShopId,
  lockedAt: p.lockedAt,
  isActive: p.isActive,
  createdAt: p.createdAt,
});

// The owner view of a listing includes the private fields, like GET /shops/:shopId/listings.
const presentListing = (l) => ({
  id: l.id,
  price: l.price,
  stockQty: l.stockQty,
  availability: l.availability,
  bargainEnabled: l.bargainEnabled,
  minOfferPercent: l.minOfferPercent,
  isActive: l.isActive,
});

// The user must belong to the shop (or be an admin), and the shop must be active.
export async function activeShop(user, shopId) {
  await assertShopAccess(user, shopId);
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, isActive: true, verificationLevel: true },
  });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (!shop.isActive) throw new AppError(403, 'This shop is deactivated');
  return shop;
}

async function assertRefs(categoryId, brandId) {
  if (categoryId && !(await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }))) {
    throw new AppError(400, 'Category not found');
  }
  if (brandId && !(await prisma.brand.findUnique({ where: { id: brandId }, select: { id: true } }))) {
    throw new AppError(400, 'Brand not found');
  }
}

// "Did you mean ...?": up to 5 active products with a similar title (trigram similarity or contains).
export async function findSimilar(user, shopId, { title }) {
  await activeShop(user, shopId);
  const contains = `%${title.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await prisma.$queryRaw`
    SELECT p.id, similarity(p.title, ${title}) AS score
    FROM "Product" p
    WHERE p."isActive" = true
      AND (p.title % ${title} OR p.title ILIKE ${contains} ESCAPE '\\')
    ORDER BY score DESC, p.title ASC, p.id ASC
    LIMIT 5`;
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [products, mine] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, include: productInclude }),
    prisma.shopListing.findMany({ where: { shopId, productId: { in: ids }, isActive: true }, select: { productId: true } }),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const listed = new Set(mine.map((l) => l.productId));
  return ids.map((id) => {
    const p = byId.get(id);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      brand: p.brand,
      category: p.category,
      image: p.images[0] ?? null,
      alreadyListedByYou: listed.has(id),
    };
  });
}

export async function createShopProduct(user, shopId, input) {
  const shop = await activeShop(user, shopId);
  if (LEVEL_RANK[shop.verificationLevel] < LEVEL_RANK[MIN_LEVEL_TO_CREATE]) {
    throw new AppError(403, 'Your shop must be at least Documents Verified to add new products');
  }
  const recent = await prisma.product.count({
    where: { createdByShopId: shopId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  if (recent >= DAILY_LIMIT) throw new AppError(429, `A shop can add at most ${DAILY_LIMIT} new products per 24 hours`);
  await assertRefs(input.categoryId, input.brandId);

  const slug = await uniqueSlug('product', input.title); // made once, never changes
  const l = input.listing;
  const { product, listing } = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        title: input.title,
        slug,
        categoryId: input.categoryId,
        brandId: input.brandId ?? null,
        description: input.description ?? null,
        ...(input.specs && { specs: input.specs }),
        msrp: input.msrp ?? null,
        images: [],
        source: 'SHOP',
        createdByShopId: shopId,
      },
      include: productInclude,
    });
    const listing = await tx.shopListing.create({
      data: {
        shopId,
        productId: product.id,
        price: l.price,
        stockQty: l.stockQty ?? null,
        availability: l.availability ?? deriveAvailability(l.stockQty),
        bargainEnabled: l.bargainEnabled,
        minOfferPercent: l.minOfferPercent,
      },
    });
    await tx.auditLog.create({
      data: { actorId: user.id, action: 'catalog.shop_product_created', entityType: 'Product', entityId: product.id, meta: { title: product.title, shopId } },
    });
    return { product, listing };
  });
  inBackground(() => fingerprintProductTitles([product.id]));
  return { product: presentProduct(product), listing: presentListing(listing) };
}

// The creating shop keeps its product up to date, unless an admin locked or hid it.
// Title, category and brand change only while no other shop sells the product.
export async function assertShopCanEdit(shopId, product) {
  if (!product) throw new AppError(404, 'Product not found');
  if (product.source !== 'SHOP' || product.createdByShopId !== shopId || product.lockedAt || !product.isActive) {
    throw new AppError(403, LOCKED);
  }
}

export async function updateShopProduct(user, shopId, productId, input) {
  await activeShop(user, shopId);
  const product = await prisma.product.findUnique({ where: { id: productId } });
  await assertShopCanEdit(shopId, product);

  const identityChange = IDENTITY_FIELDS.some((k) => k in input && input[k] !== product[k]);
  if (identityChange) {
    const others = await prisma.shopListing.count({ where: { productId, shopId: { not: shopId }, isActive: true } });
    if (others > 0) throw new AppError(403, 'Other shops sell this product, so its title, category and brand can no longer change');
  }
  await assertRefs(input.categoryId, input.brandId);

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.product.update({ where: { id: productId }, data: input, include: productInclude }); // slug never changes
    await tx.auditLog.create({
      data: { actorId: user.id, action: 'catalog.shop_product_updated', entityType: 'Product', entityId: productId, meta: { shopId, fields: Object.keys(input) } },
    });
    return p;
  });
  if ('title' in input || 'brandId' in input) inBackground(() => fingerprintProductTitles([productId]));
  return presentProduct(updated);
}