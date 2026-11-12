import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { uniqueSlug } from '../../lib/slug.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage, presentImage } from '../../lib/storage.js';
import { fingerprintProductTitles, inBackground } from '../../lib/fingerprints.js';

const audit = (actorId, action, entityType, entityId, meta) =>
  prisma.auditLog.create({ data: { actorId, action, entityType, entityId, meta } });

// ---------- categories (two levels: a root and its children) ----------


async function assertRootCategory(parentId) {
  const parent = await prisma.category.findUnique({ where: { id: parentId } });
  if (!parent) throw new AppError(404, 'Parent category not found');
  if (parent.parentId !== null) throw new AppError(400, 'Categories can be nested only one level deep');
}

async function assertCategoryNameFree(name, parentId, exceptId) {
  const same = await prisma.category.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      parentId: parentId ?? null,
      ...(exceptId && { NOT: { id: exceptId } }),
    },
    select: { id: true },
  });
  if (same) throw new AppError(409, 'A category with this name already exists here');
}

export async function createCategory(admin, { name, parentId }) {
  if (parentId) await assertRootCategory(parentId);
  await assertCategoryNameFree(name, parentId, null);
  const category = await prisma.category.create({
    data: { name, slug: await uniqueSlug('category', name), parentId: parentId ?? null },
  });
  await audit(admin.id, 'catalog.category_created', 'Category', category.id, { name });
  return category;
}

export async function updateCategory(admin, id, input) {
  const category = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { children: true } } },
  });
  if (!category) throw new AppError(404, 'Category not found');

  const newParentId = input.parentId === undefined ? category.parentId : input.parentId;
  if (newParentId === id) throw new AppError(400, 'A category cannot be its own parent');
  if (newParentId !== category.parentId && newParentId !== null) {
    if (category._count.children > 0) {
      throw new AppError(409, 'A category with subcategories cannot become a subcategory');
    }
    await assertRootCategory(newParentId);
  }
  await assertCategoryNameFree(input.name ?? category.name, newParentId, id);

  // the slug stays the same so existing links keep working
  const updated = await prisma.category.update({
    where: { id },
    data: { ...(input.name && { name: input.name }), parentId: newParentId },
  });
  await audit(admin.id, 'catalog.category_updated', 'Category', id, input);
  return updated;
}

export async function deleteCategory(admin, id) {
  const category = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true, children: true } } },
  });
  if (!category) throw new AppError(404, 'Category not found');
  if (category._count.products > 0 || category._count.children > 0) {
    throw new AppError(409, 'This category still has products or subcategories', {
      products: category._count.products,
      subcategories: category._count.children,
    });
  }
  await prisma.category.delete({ where: { id } });
  await audit(admin.id, 'catalog.category_deleted', 'Category', id, { name: category.name });
}

// ---------- brands ----------

async function assertBrandNameFree(name, exceptId) {
  const same = await prisma.brand.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId && { NOT: { id: exceptId } }) },
    select: { id: true },
  });
  if (same) throw new AppError(409, 'A brand with this name already exists');
}

export async function createBrand(admin, { name }) {
  await assertBrandNameFree(name, null);
  const brand = await prisma.brand.create({ data: { name } });
  await audit(admin.id, 'catalog.brand_created', 'Brand', brand.id, { name });
  return brand;
}

export async function updateBrand(admin, id, { name }) {
  const brand = await prisma.brand.findUnique({ where: { id } });
  if (!brand) throw new AppError(404, 'Brand not found');
  await assertBrandNameFree(name, id);
  const updated = await prisma.brand.update({ where: { id }, data: { name } });
  await audit(admin.id, 'catalog.brand_updated', 'Brand', id, { name });
  return updated;
}

export async function deleteBrand(admin, id) {
  const brand = await prisma.brand.findUnique({
    where: { id },
    include: { _count: { select: { products: true } } },
  });
  if (!brand) throw new AppError(404, 'Brand not found');
  if (brand._count.products > 0) {
    throw new AppError(409, 'This brand still has products', { products: brand._count.products });
  }
  await prisma.brand.delete({ where: { id } });
  await audit(admin.id, 'catalog.brand_deleted', 'Brand', id, { name: brand.name });
}

// ---------- markets ----------

export async function createMarket(admin, input) {
  const market = await prisma.market.create({
    data: { ...input, slug: await uniqueSlug('market', input.name) },
  });
  await audit(admin.id, 'catalog.market_created', 'Market', market.id, { name: market.name });
  return market;
}

export async function updateMarket(admin, id, input) {
  const market = await prisma.market.findUnique({ where: { id } });
  if (!market) throw new AppError(404, 'Market not found');
  const updated = await prisma.market.update({ where: { id }, data: input }); // slug stays the same
  await audit(admin.id, 'catalog.market_updated', 'Market', id, input);
  return updated;
}

export async function deleteMarket(admin, id) {
  const market = await prisma.market.findUnique({
    where: { id },
    include: { _count: { select: { shops: true } } },
  });
  if (!market) throw new AppError(404, 'Market not found');
  if (market._count.shops > 0) {
    throw new AppError(409, 'This market still has shops', { shops: market._count.shops });
  }

  await prisma.market.delete({ where: { id } });
  if (market.imageId) {
    const img = await prisma.image.delete({ where: { id: market.imageId } });
    await removeImage(img.key).catch(() => {});
  }


  await audit(admin.id, 'catalog.market_deleted', 'Market', id, { name: market.name });
}

// ---------- products ----------

async function assertRefs(categoryId, brandId) {
  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!category) throw new AppError(400, 'Category not found');
  }
  if (brandId) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { id: true } });
    if (!brand) throw new AppError(400, 'Brand not found');
  }
}

const productInclude = {
  brand: { select: { id: true, name: true } },
  category: { select: { id: true, name: true, slug: true } },
};

export async function listProducts({ q, categoryId, brandId, isActive, source, locked, page, limit }) {
  const where = {
    ...(q && {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { brand: { name: { contains: q, mode: 'insensitive' } } },
      ],
    }),
    ...(categoryId && { categoryId }),
    ...(brandId && { brandId }),
    ...(isActive !== undefined && { isActive }),
    ...(source && { source }),
    ...(locked !== undefined && { lockedAt: locked ? { not: null } : null }),
  };
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        ...productInclude,
        createdByShop: { select: { id: true, name: true, slug: true } },
        _count: { select: { listings: { where: { isActive: true } } } },
      },
    }),
  ]);
  return {
    items: rows.map(({ _count, ...p }) => ({ ...p, activeListings: _count.listings })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function createProduct(admin, input) {
  await assertRefs(input.categoryId, input.brandId);
  const product = await prisma.product.create({
    data: {
      title: input.title,
      slug: await uniqueSlug('product', input.title),
      categoryId: input.categoryId,
      brandId: input.brandId ?? null,
      description: input.description ?? null,
      ...(input.specs && { specs: input.specs }),
      msrp: input.msrp ?? null,
      images: input.images,
    },
    include: productInclude,
  });
  await audit(admin.id, 'catalog.product_created', 'Product', product.id, { title: product.title });
    inBackground(() => fingerprintProductTitles([product.id]));
  return product;
}

export async function updateProduct(admin, id, input) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new AppError(404, 'Product not found');
  await assertRefs(input.categoryId, input.brandId);

  // the slug stays the same when the title changes, so links keep working
  const updated = await prisma.$transaction(async (tx) => {
    // an admin change locks the product for the shop that created it
    const p = await tx.product.update({ where: { id }, data: { ...input, lockedAt: new Date() }, include: productInclude });


    // a deactivated product takes its listings with it, so carts and storefronts stay consistent
    if (input.isActive === false) {
      await tx.shopListing.updateMany({ where: { productId: id }, data: { isActive: false } });
    }
    return p;
  });
  await audit(admin.id, 'catalog.product_updated', 'Product', id, input);
    if ('title' in input || 'brandId' in input) inBackground(() => fingerprintProductTitles([id]));
  return updated;
}

// Soft delete: orders point at products, so the product is deactivated, never removed.
export async function deactivateProduct(admin, id) {
  await updateProduct(admin, id, { isActive: false });
}




// ---------- market photo (admin) ----------
// Order: process -> publish new files -> database transaction -> delete old files.
// The new files are published BEFORE the database points at them, so a market never points at a
// missing file; if the transaction fails, the unreferenced new files are deleted again.
const marketCard = (m) => ({ id: m.id, name: m.name, slug: m.slug, image: presentImage(m.image) });

export async function setMarketImage(admin, id, file) {
  if (!file) throw new AppError(400, 'Send exactly one photo in the multipart field "image"');
  const market = await prisma.market.findUnique({ where: { id }, include: { image: true } });
  if (!market) throw new AppError(404, 'Market not found');

  const processed = await processImage(file.buffer, 'MARKET');
  const staged = await stageImage(processed);
  await staged.commit();

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const image = await tx.image.create({
        data: { key: staged.key, width: processed.width, height: processed.height, purpose: 'MARKET', ownerId: admin.id },
      });
      const m = await tx.market.update({ where: { id }, data: { imageId: image.id }, include: { image: true } });
      if (market.image) await tx.image.delete({ where: { id: market.image.id } });
      await tx.auditLog.create({
        data: { actorId: admin.id, action: 'catalog.market_image_set', entityType: 'Market', entityId: id, meta: { name: market.name } },
      });
      return m;
    });
  } catch (err) {
    await removeImage(staged.key).catch(() => {});
    throw err;
  }
  if (market.image) await removeImage(market.image.key).catch(() => {}); // old files, after success
  return marketCard(updated);
}

export async function removeMarketImage(admin, id) {
  const market = await prisma.market.findUnique({ where: { id }, include: { image: true } });
  if (!market) throw new AppError(404, 'Market not found');
  if (!market.image) throw new AppError(404, 'This market has no photo');
  await prisma.$transaction([
    prisma.market.update({ where: { id }, data: { imageId: null } }),
    prisma.image.delete({ where: { id: market.image.id } }),
    prisma.auditLog.create({
      data: { actorId: admin.id, action: 'catalog.market_image_removed', entityType: 'Market', entityId: id, meta: { name: market.name } },
    }),
  ]);
  await removeImage(market.image.key).catch(() => {});
}


// ---------- shop-made products: lock / unlock / merge (admin) ----------

export async function setProductLock(admin, id, locked) {
  const product = await prisma.product.findUnique({ where: { id }, select: { id: true, title: true } });
  if (!product) throw new AppError(404, 'Product not found');
  const updated = await prisma.product.update({
    where: { id },
    data: { lockedAt: locked ? new Date() : null },
    include: productInclude,
  });
  await audit(admin.id, locked ? 'catalog.product_locked' : 'catalog.product_unlocked', 'Product', id, { title: product.title });
  return updated;
}

// Moves every listing of a duplicate to the target product, in one transaction.
// A shop that already lists the target keeps that listing; its moved one is deactivated instead
// (one listing per shop and product). Listing ids never change, so carts and bargains stay valid;
// orders keep their own snapshot. The duplicate is then deactivated, and both products are locked.
export async function mergeProduct(admin, id, { intoProductId }) {
  if (id === intoProductId) throw new AppError(409, 'A product cannot be merged into itself');
  const [duplicate, target] = await Promise.all([
    prisma.product.findUnique({ where: { id } }),
    prisma.product.findUnique({ where: { id: intoProductId } }),
  ]);
  if (!duplicate) throw new AppError(404, 'Product not found');
  if (!target) throw new AppError(404, 'Target product not found');
  if (!target.isActive) throw new AppError(409, 'The target product is inactive');

  const result = await prisma.$transaction(async (tx) => {
    const listings = await tx.shopListing.findMany({ where: { productId: id } });
    const targetShops = new Set(
      (await tx.shopListing.findMany({ where: { productId: intoProductId }, select: { shopId: true } })).map((l) => l.shopId),
    );
    let moved = 0;
    let deactivated = 0;
    for (const l of listings) {
      if (targetShops.has(l.shopId)) {
        await tx.shopListing.update({ where: { id: l.id }, data: { isActive: false } });
        deactivated += 1;
      } else {
        await tx.shopListing.update({ where: { id: l.id }, data: { productId: intoProductId } });
        moved += 1;
      }
    }
    const now = new Date();
    await tx.product.update({ where: { id }, data: { isActive: false, lockedAt: now } });
    await tx.product.update({ where: { id: intoProductId }, data: { lockedAt: now } });
    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: 'catalog.product_merged',
        entityType: 'Product',
        entityId: id,
        meta: { title: duplicate.title, intoProductId, intoTitle: target.title, moved, deactivated },
      },
    });
    return { moved, deactivated };
  });
  return { productId: id, intoProductId, ...result };
}