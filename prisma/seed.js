import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { processImage } from '../src/lib/images.js';
import { stageImage, removeImage, imageUrls } from '../src/lib/storage.js';

const prisma = new PrismaClient();

// ---------- seed product photos ----------
// The website only shows images from our own API (its Content-Security-Policy blocks other hosts),
// so a seed photo is never a link to another site: it is downloaded once (kept in the temp folder),
// goes through the normal pipeline (processImage + storage.js) and is served from /media like an
// uploaded photo. Without a network (and without the kept copy) the product is seeded with no photo.
const PHOTO_CACHE = path.join(os.tmpdir(), 'vendors-hub-seed-photos');
const SEED_PHOTO = { purpose: 'PRODUCT', ownerId: null }; // how the photos of an earlier seed run are found again

async function downloadPhoto(id) {
  const file = path.join(PHOTO_CACHE, `${id}.jpg`);
  try {
    return await readFile(file);
  } catch {
    // not downloaded yet
  }
  const res = await fetch(`https://images.unsplash.com/photo-${id}?w=1200&q=80`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(PHOTO_CACHE, { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}

// Returns { key, width, height }, or null when the photo cannot be loaded or is not a valid image.
async function publishPhoto(id) {
  try {
    const processed = await processImage(await downloadPhoto(id), 'PRODUCT');
    const staged = await stageImage(processed);
    await staged.commit();
    return { key: staged.key, width: processed.width, height: processed.height };
  } catch (err) {
    console.warn(`Seed photo ${id} skipped: ${err.message}`);
    return null;
  }
}

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Children first, parents last (foreign keys point child -> parent)
async function clean() {
  await prisma.$transaction([
        prisma.idempotencyKey.deleteMany(),
        prisma.emailVerificationToken.deleteMany(),
        prisma.image.deleteMany(),
    // shop photos first: they point at shops and at uploads
    prisma.shopPhoto.deleteMany(),
    // Phase 3 tables: they point at users and orders
    prisma.returnMessage.deleteMany(),
    prisma.returnRequest.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    prisma.fileUpload.deleteMany(),
    // orders and carts
    prisma.payment.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.subOrder.deleteMany(),
    prisma.checkoutSession.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    // bargains, reviews, shop relations
    prisma.bargainEvent.deleteMany(),
    prisma.bargain.deleteMany(),
    prisma.review.deleteMany(),
    prisma.shopFollow.deleteMany(),
    prisma.shopStaff.deleteMany(),
    prisma.verificationDocument.deleteMany(),
    prisma.shopVerification.deleteMany(),
    prisma.auditLog.deleteMany(),
    // catalog and shops
    prisma.shopListing.deleteMany(),
    prisma.product.deleteMany(),
    prisma.brand.deleteMany(),
    prisma.category.deleteMany(),
    prisma.shop.deleteMany(),
    prisma.market.deleteMany(),
    // users last: almost everything points at them
    prisma.address.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}
async function main() {
  console.log('Seeding...');
  // the files of the last run's seed photos are deleted once their database rows are gone
  const oldPhotos = await prisma.image.findMany({ where: SEED_PHOTO, select: { key: true } });
  await clean();
  await Promise.all(oldPhotos.map((p) => removeImage(p.key).catch(() => {})));

  const passwordHash = await bcrypt.hash('Password123!', 10);

  // ---------- Users ----------
  const admin = await prisma.user.create({
    data: { name: 'Admin', email: 'admin@vendorshub.test', passwordHash, role: 'ADMIN' },
  });
  const [owner1, owner2, owner3] = await Promise.all(
    [
      ['Rafiq Ahmed', 'owner1@vendorshub.test'],
      ['Sadia Karim', 'owner2@vendorshub.test'],
      ['Imran Hossain', 'owner3@vendorshub.test'],
    ].map(([name, email]) =>
      prisma.user.create({ data: { name, email, passwordHash, role: 'SHOP_OWNER' } }),
    ),
  );
  const customer = await prisma.user.create({
    data: {
      name: 'Test Customer',
      email: 'customer@vendorshub.test',
      phone: '01700000000',
      passwordHash,
      role: 'CUSTOMER',
      addresses: {
        create: [{ label: 'Home', line1: 'House 12, Road 5', area: 'Dhanmondi', phone: '01700000000', isDefault: true }],
      },
    },
  });

  // ---------- Markets ----------
  const jamuna = await prisma.market.create({
    data: { name: 'Jamuna Future Park', slug: 'jamuna-future-park', city: 'Dhaka', district: 'dhaka', address: 'Kuril, Progoti Sarani, Dhaka', latitude: 23.8133, longitude: 90.4246 },
  });
  const bashundhara = await prisma.market.create({
    data: { name: 'Bashundhara City', slug: 'bashundhara-city', city: 'Dhaka', district: 'dhaka', address: 'Panthapath, Dhaka', latitude: 23.7512, longitude: 90.3908 },
  });
  // Markets in other districts (no shops yet), so the frontend can group and filter by district.
  // Their names sort after "Bashundhara City", so the first market of GET /markets stays the same.
  await prisma.market.createMany({
    data: [
      { name: 'Sanmar Ocean City', slug: 'sanmar-ocean-city', city: 'Chattogram', district: 'chattogram', address: 'CDA Avenue, East Nasirabad, Chattogram', latitude: 22.3596, longitude: 91.8217 },
      { name: 'Blue Water Shopping City', slug: 'blue-water-shopping-city', city: 'Sylhet', district: 'sylhet', address: 'Zindabazar, Sylhet', latitude: 24.8967, longitude: 91.8687 },
      { name: 'Theme Omor Plaza', slug: 'theme-omor-plaza', city: 'Rajshahi', district: 'rajshahi', address: 'Alupatti, Rajshahi', latitude: 24.3667, longitude: 88.6044 },
    ],
  });

  // ---------- Shops ----------
  const techzone = await prisma.shop.create({
    data: {
      ownerId: owner1.id, marketId: jamuna.id,
      name: 'TechZone Electronics', slug: 'techzone-electronics',
      description: 'Authorized smartphone and laptop retailer.',
      levelFloor: 'Level 3', shopNumber: 'Shop 42',
      addressLine: 'Level 3, Shop 42, Jamuna Future Park, Dhaka',
      phone: '01711000001', whatsapp: '01711000001',
      socialLinks: { facebook: 'https://www.facebook.com/techzone.electronics.demo', website: 'https://techzone.example.com/' },
      verificationLevel: 'PHYSICAL_SHOP_VERIFIED', lastAuditedAt: new Date('2026-03-15'),
      avgResponseMins: 15,
    },
  });
  const mobileHouse = await prisma.shop.create({
    data: {
      ownerId: owner2.id, marketId: jamuna.id,
      name: 'Dhaka Mobile House', slug: 'dhaka-mobile-house',
      description: 'Phones, chargers and accessories at fair prices.',
      levelFloor: 'Level 2', shopNumber: 'Shop 17',
      addressLine: 'Level 2, Shop 17, Jamuna Future Park, Dhaka',
      phone: '01811000002',
      verificationLevel: 'BUSINESS_VERIFIED', avgResponseMins: 30,
    },
  });
  const gadgetGalaxy = await prisma.shop.create({
    data: {
      ownerId: owner3.id, marketId: bashundhara.id,
      name: 'Gadget Galaxy', slug: 'gadget-galaxy',
      description: 'Trusted vendor for laptops and premium gadgets.',
      levelFloor: 'Level 5', shopNumber: 'Shop 9',
      addressLine: 'Level 5, Shop 9, Bashundhara City, Dhaka',
      phone: '01911000003',
      verificationLevel: 'TRUSTED_VENDOR', lastAuditedAt: new Date('2026-02-10'),
      avgResponseMins: 10, supportsDelivery: false,
    },
  });
  const shops = [techzone, mobileHouse, gadgetGalaxy];

  await prisma.shopStaff.create({ data: { shopId: techzone.id, userId: owner2.id, title: 'Support' } });
  await prisma.shopFollow.create({ data: { shopId: techzone.id, userId: customer.id } });

  // ---------- Categories & Brands ----------
  const catPhones = await prisma.category.create({ data: { name: 'Mobile Phones', slug: 'mobile-phones' } });
  const catLaptops = await prisma.category.create({ data: { name: 'Laptops', slug: 'laptops' } });
  const catAcc = await prisma.category.create({ data: { name: 'Accessories', slug: 'accessories' } });
  const catClothing = await prisma.category.create({ data: { name: 'Clothing', slug: 'clothing' } });
  const catAudio = await prisma.category.create({ data: { name: 'Headphones & Earbuds', slug: 'headphones-earbuds' } });
  const catOther = await prisma.category.create({ data: { name: 'Other Electronics', slug: 'other-electronics' } });

  const brandNames = ['Samsung', 'Apple', 'Xiaomi', 'Dell'];
  const brands = {};
  for (const name of brandNames) {
    brands[name] = await prisma.brand.create({ data: { name } });
  }

  // ---------- Products (35, each with a real photo; the first 12 reuse fitting pictures of the list below) ----------
  // [title, brand or null, category, msrp, specs, photo (optional)]
  // The photo is the id of https://images.unsplash.com/photo-<id>; see "seed product photos" at the top.
  // New products go at the END: the listing loop below works by position, so the first 12 keep their listings.
  const productDefs = [
    ['Galaxy A55 5G (8/128GB)', 'Samsung', catPhones, 41999, { ram: '8GB', storage: '128GB', color: 'Awesome Navy' }, '1511707171634-5f897ff02aa9'],
    ['Galaxy S24 (8/256GB)', 'Samsung', catPhones, 114999, { ram: '8GB', storage: '256GB', color: 'Onyx Black' }, '1598327105666-5b89351aff97'],
    ['iPhone 15 (128GB)', 'Apple', catPhones, 119900, { storage: '128GB', color: 'Blue' }, '1592750475338-74b7b21085ab'],
    ['Redmi Note 13 Pro (8/256GB)', 'Xiaomi', catPhones, 38999, { ram: '8GB', storage: '256GB', color: 'Midnight Black' }, '1598327105666-5b89351aff97'],
    ['Poco X6 (8/256GB)', 'Xiaomi', catPhones, 32999, { ram: '8GB', storage: '256GB', color: 'Mirage Blue' }, '1511707171634-5f897ff02aa9'],
    ['Dell Inspiron 15 3520', 'Dell', catLaptops, 72000, { cpu: 'Core i5-1235U', ram: '8GB', storage: '512GB SSD' }, '1496181133206-80ce9b88a853'],
    ['Dell Latitude 5440', 'Dell', catLaptops, 118000, { cpu: 'Core i7-1355U', ram: '16GB', storage: '512GB SSD' }, '1496181133206-80ce9b88a853'],
    ['MacBook Air M2 (8/256GB)', 'Apple', catLaptops, 139900, { chip: 'Apple M2', ram: '8GB', storage: '256GB SSD' }, '1496181133206-80ce9b88a853'],
    ['AirPods Pro (2nd gen)', 'Apple', catAcc, 29900, { type: 'TWS earbuds', anc: true }, '1600294037681-c80b4cb5b434'],
    ['Galaxy Buds2 Pro', 'Samsung', catAcc, 19900, { type: 'TWS earbuds', anc: true }, '1606220945770-b5b6c2c55bf1'],
    ['Mi Power Bank 3 20000mAh', 'Xiaomi', catAcc, 3200, { capacity: '20000mAh', ports: 2 }, '1605236453806-6ff36851218e'],
    ['Samsung 25W Fast Charger', 'Samsung', catAcc, 1800, { power: '25W', cable: 'USB-C' }, '1605236453806-6ff36851218e'],
    // Clothing
    ["Men's Shirt", null, catClothing, 1450, { material: 'Cotton', fit: 'Regular', sizes: 'M, L, XL' }, '1596755094514-f87e34085b2c'],
    ['Formal Shirt', null, catClothing, 1850, { material: 'Cotton blend', fit: 'Slim', sizes: 'M, L, XL' }, '1602810318383-e386cc2a3ccf'],
    ["Men's T-Shirt", null, catClothing, 650, { material: 'Cotton', color: 'White', sizes: 'S, M, L, XL' }, '1521572163474-6864f9cf17ab'],
    ['Black T-Shirt', null, catClothing, 550, { material: 'Cotton', color: 'Black', sizes: 'S, M, L, XL' }, '1503341504253-dff4815485f1'],
    ['Denim Jeans', null, catClothing, 1950, { material: 'Denim', fit: 'Regular', sizes: '30, 32, 34, 36' }, '1542272604-787c3835535d'],
    ['Casual Pants', null, catClothing, 1650, { material: 'Cotton twill', fit: 'Regular', sizes: '30, 32, 34, 36' }, '1473966968600-fa801b869a1a'],
    ["Men's Hoodie", null, catClothing, 2200, { material: 'Fleece', sizes: 'M, L, XL' }, '1556821840-3a63f95609a7'],
    ['Jacket', null, catClothing, 3500, { material: 'Polyester', sizes: 'M, L, XL' }, '1591047139829-d91aecb6caea'],
    // Electronics - Mobile
    ['Smartphone', null, catPhones, 24999, { ram: '6GB', storage: '128GB' }, '1511707171634-5f897ff02aa9'],
    ['iPhone', 'Apple', catPhones, 99900, { storage: '128GB' }, '1592750475338-74b7b21085ab'],
    ['Android Phone', null, catPhones, 18999, { ram: '4GB', storage: '64GB' }, '1598327105666-5b89351aff97'],
    ['Smartphone Accessories', null, catPhones, 1200, { type: 'Accessory kit' }, '1605236453806-6ff36851218e'],
    // Headphones & Earbuds
    ['Wireless Headphones', null, catAudio, 6500, { type: 'Over-ear', connection: 'Bluetooth' }, '1505740420928-5e560c06d30e'],
    ['Bluetooth Headphones', null, catAudio, 4500, { type: 'Over-ear', connection: 'Bluetooth' }, '1546435770-a3e426bf472b'],
    ['Wireless Earbuds', null, catAudio, 3200, { type: 'TWS earbuds', connection: 'Bluetooth' }, '1606220945770-b5b6c2c55bf1'],
    ['AirPods', 'Apple', catAudio, 19900, { type: 'TWS earbuds', connection: 'Bluetooth' }, '1600294037681-c80b4cb5b434'],
    ['Bluetooth Earphones', null, catAudio, 1500, { type: 'In-ear', connection: 'Bluetooth' }, '1484704849700-f032a568e944'],
    ['Gaming Headset', null, catAudio, 5500, { type: 'Over-ear', microphone: true }, '1599669454699-248893623440'],
    // Other Electronics
    ['Smartwatch', null, catOther, 4500, { display: 'AMOLED', connection: 'Bluetooth' }, '1523275335684-37898b6baf30'],
    ['Laptop', null, catOther, 65000, { ram: '8GB', storage: '512GB SSD' }, '1496181133206-80ce9b88a853'],
    ['Keyboard', null, catOther, 2800, { type: 'Mechanical', connection: 'USB' }, '1587829741301-dc798b83add3'],
    ['Computer Mouse', null, catOther, 950, { type: 'Wireless', connection: 'USB receiver' }, '1527864550417-7fd91fc51a46'],
    ['Bluetooth Speaker', null, catOther, 3800, { type: 'Portable', connection: 'Bluetooth' }, '1608043152269-423dbba4e7e1'],
  ];

  // all photos at once (fast after the first run: the downloads are kept)
  // one published file per product, even when two products use the same picture
  const published = await Promise.all(productDefs.map((def) => (def[5] ? publishPhoto(def[5]) : null)));

  const products = [];
  for (const [i, [title, brand, category, msrp, specs]] of productDefs.entries()) {
    const photo = published[i];
    products.push(
      await prisma.product.create({
        data: {
          title, slug: slugify(title.replace(/'/g, '')), brandId: brand ? brands[brand].id : null, categoryId: category.id,
          description: category === catClothing ? `${title} - comfortable everyday wear.` : `${title} - genuine product with official warranty.`,
          specs, msrp,
          // the same shape an uploaded photo has: an Image row plus its /media link in Product.images
          images: photo ? [imageUrls(photo.key).url] : [],
          ...(photo && { photos: { create: { ...photo, ...SEED_PHOTO, sortOrder: 0 } } }),
        },
      }),
    );
  }

  // ---------- Listings: each product sold by 2-3 shops ----------
  const availabilityCycle = ['IN_STOCK', 'LIMITED', 'AVAILABLE', 'IN_STOCK', 'OUT_OF_STOCK'];
  const stockFor = { IN_STOCK: 25, LIMITED: 3, AVAILABLE: null, OUT_OF_STOCK: 0 };
  const discount = [0.92, 0.95, 0.9]; // per shop index
  const listingMap = {};

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const shopIdxs = i % 3 === 0 ? [0, 1, 2] : [i % 3, (i + 1) % 3];
    for (let j = 0; j < shopIdxs.length; j++) {
      const s = shopIdxs[j];
      const availability = availabilityCycle[(i + j) % availabilityCycle.length];
      let price = Math.round((p.msrp * (discount[s] + (i % 3) * 0.01)) / 100) * 100;
      if (p.slug === 'galaxy-a55-5g-8-128gb' && s === 0) price = 38500; // matches Figma spec
      const listing = await prisma.shopListing.create({
        data: {
          shopId: shops[s].id, productId: p.id, price,
          availability, stockQty: stockFor[availability],
          bargainEnabled: (i + s) % 2 === 0,
          minOfferPercent: 92,
        },
      });
      listingMap[`${p.slug}:${shops[s].slug}`] = listing;
    }
  }

  // ---------- Verification queue (admin portal) ----------
  await prisma.shopVerification.create({
    data: {
      shopId: mobileHouse.id, targetLevel: 'PHYSICAL_SHOP_VERIFIED', status: 'PENDING',
      precheckScore: 78,
      precheckDetails: { tradeLicenseOcr: true, addressGeoMatch: true, nidFaceMatch: 'pending' },
      documents: {
        create: [
          { type: 'TRADE_LICENSE', fileUrl: 'https://example.com/docs/trade-license.pdf' },
          { type: 'NID', fileUrl: 'https://example.com/docs/nid.jpg' },
          { type: 'SHOP_PHOTO', fileUrl: 'https://example.com/docs/shop.jpg', needsReupload: true },
        ],
      },
    },
  });
  await prisma.shopVerification.create({
    data: {
      shopId: techzone.id, targetLevel: 'PHYSICAL_SHOP_VERIFIED', status: 'APPROVED',
      precheckScore: 92, reviewedById: admin.id, reviewedAt: new Date('2026-03-15'),
    },
  });

  // ---------- Demo bargain (offer -> counter) ----------
  const a55Listing = listingMap['galaxy-a55-5g-8-128gb:techzone-electronics'];
  await prisma.bargain.create({
    data: {
      listingId: a55Listing.id, customerId: customer.id, status: 'COUNTERED',
      listPrice: 38500, currentOffer: 37200,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      events: {
        create: [
          { actor: 'CUSTOMER', amount: 36000 },
          { actor: 'SHOP', amount: 37200, note: 'Countered' },
        ],
      },
    },
  });

  // ---------- Reviews ----------
  await prisma.review.create({
    data: { type: 'SHOP_TRUST', userId: customer.id, shopId: techzone.id, rating: 5, comment: 'Fast response, genuine product.' },
  });
  await prisma.review.create({
    data: { type: 'PRODUCT', userId: customer.id, shopId: techzone.id, productId: products[0].id, rating: 5, comment: 'Great phone.' },
  });

  const counts = {
    users: await prisma.user.count(),
    shops: await prisma.shop.count(),
    products: await prisma.product.count(),
    listings: await prisma.shopListing.count(),
  };
  console.log('Seed finished:', counts);
  console.log('Logins (password Password123!): admin@, owner1@, owner2@, owner3@, customer@vendorshub.test');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());