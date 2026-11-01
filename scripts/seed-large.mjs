// DEVELOPMENT ONLY: adds a large catalog for performance measurements. Never run it in production.
// Usage: node --env-file=.env scripts/seed-large.mjs [products=5000] [shops=300] [listingsPerProduct=4]
// The normal seed removes everything again: node --env-file=.env prisma/seed.js
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV is production.');
  process.exit(1);
}
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refusing to run: DATABASE_URL does not point at a local database.');
  process.exit(1);
}

const [PRODUCTS = 5000, SHOPS = 300, PER_PRODUCT = 4] = process.argv.slice(2).map(Number);
const AVAILABILITY = ['IN_STOCK', 'AVAILABLE', 'LIMITED', 'OUT_OF_STOCK'];
const KINDS = ['Phone', 'Laptop', 'Shirt', 'Watch', 'Speaker', 'Tablet', 'Panjabi', 'Headphones'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const prisma = new PrismaClient();
async function inChunks(rows, size, create) {
  for (let i = 0; i < rows.length; i += size) await create(rows.slice(i, i + size));
}

const categories = await prisma.category.findMany({ select: { id: true } });
const brands = await prisma.brand.findMany({ select: { id: true } });
const markets = await prisma.market.findMany({ select: { id: true } });
if (categories.length === 0) {
  console.error('No categories found. Run the normal seed first.');
  process.exit(1);
}

const tag = Date.now().toString(36);
const owner = await prisma.user.create({
  data: {
    name: 'Bulk Owner',
    email: `bulk-owner-${tag}@vendorshub.test`,
    passwordHash: await bcrypt.hash('Password123!', 10),
    role: 'SHOP_OWNER',
  },
});

const shops = Array.from({ length: SHOPS }, (_, i) => ({
  id: crypto.randomUUID(),
  ownerId: owner.id,
  marketId: markets.length ? pick(markets).id : null,
  name: `Bulk Shop ${i + 1}`,
  slug: `bulk-shop-${tag}-${i + 1}`,
  addressLine: `Bulk address ${i + 1}, Dhaka`,
  isActive: Math.random() > 0.03, // a few deactivated shops
}));
await inChunks(shops, 500, (rows) => prisma.shop.createMany({ data: rows }));

const now = Date.now();
const products = Array.from({ length: PRODUCTS }, (_, i) => ({
  id: crypto.randomUUID(),
  categoryId: pick(categories).id,
  brandId: brands.length && Math.random() > 0.1 ? pick(brands).id : null,
  title: `Bulk Product ${String(i + 1).padStart(5, '0')} ${pick(KINDS)}`,
  slug: `bulk-${tag}-${i + 1}`,
  msrp: 1000 + Math.floor(Math.random() * 90000),
  images: [`https://example.com/bulk/${i + 1}.jpg`],
  isActive: Math.random() > 0.02, // a few deactivated products
  createdAt: new Date(now - Math.floor(Math.random() * 365 * 24 * 3600 * 1000)),
}));
await inChunks(products, 1000, (rows) => prisma.product.createMany({ data: rows }));

const listings = [];
for (const p of products) {
  const used = new Set();
  for (let k = 0; k < PER_PRODUCT; k += 1) {
    const shop = pick(shops);
    if (used.has(shop.id)) continue; // one listing per shop and product
    used.add(shop.id);
    listings.push({
      id: crypto.randomUUID(),
      shopId: shop.id,
      productId: p.id,
      price: Math.max(100, Math.round(p.msrp * (0.7 + Math.random() * 0.35))),
      availability: pick(AVAILABILITY),
      stockQty: Math.floor(Math.random() * 30),
      bargainEnabled: Math.random() > 0.6,
      isActive: Math.random() > 0.05, // a few inactive listings
    });
  }
}
await inChunks(listings, 2000, (rows) => prisma.shopListing.createMany({ data: rows }));

console.log(`Added ${shops.length} shops, ${products.length} products and ${listings.length} listings.`);
await prisma.$disconnect();