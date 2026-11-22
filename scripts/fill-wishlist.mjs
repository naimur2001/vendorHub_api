// DEVELOPMENT TOOL for test-wishlist.ps1: gives a user exactly <count> saved items by creating
// hidden throwaway products + listings ("zz-wl-test-*", inactive, never shown anywhere).
// Usage: node --env-file=.env scripts/fill-wishlist.mjs <email> <count>
//        node --env-file=.env scripts/fill-wishlist.mjs --clean
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PREFIX = 'zz-wl-test-';

async function clean() {
  const products = await prisma.product.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } });
  const ids = products.map((p) => p.id);
  await prisma.shopListing.deleteMany({ where: { productId: { in: ids } } }); // wishlist rows cascade
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

try {
  if (process.argv[2] === '--clean') {
    console.log(`removed ${await clean()}`);
  } else {
    const [email, countText] = process.argv.slice(2);
    const count = Number(countText);
    if (!email || !Number.isInteger(count) || count < 0) throw new Error('Usage: fill-wishlist.mjs <email> <count>');
    await clean();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.wishlistItem.deleteMany({ where: { userId: user.id } });
    const shop = await prisma.shop.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const category = await prisma.category.findFirstOrThrow();
    for (let i = 0; i < count; i++) {
      const product = await prisma.product.create({
        data: { title: `WL test ${i}`, slug: `${PREFIX}${i}`, categoryId: category.id, images: [], isActive: false },
      });
      const listing = await prisma.shopListing.create({
        data: { shopId: shop.id, productId: product.id, price: 1000, isActive: false },
      });
      await prisma.wishlistItem.create({ data: { userId: user.id, listingId: listing.id, priceAtSave: 1000 } });
    }
    console.log(`filled ${count}`);
  }
} finally {
  await prisma.$disconnect();
}
