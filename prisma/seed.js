import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Children first, parents last (foreign keys point child -> parent)
async function clean() {
  await prisma.$transaction([
    prisma.payment.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.subOrder.deleteMany(),
    prisma.checkoutSession.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.cart.deleteMany(),
    prisma.bargainEvent.deleteMany(),
    prisma.bargain.deleteMany(),
    prisma.review.deleteMany(),
    prisma.shopFollow.deleteMany(),
    prisma.shopStaff.deleteMany(),
    prisma.verificationDocument.deleteMany(),
    prisma.shopVerification.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.shopListing.deleteMany(),
    prisma.product.deleteMany(),
    prisma.brand.deleteMany(),
    prisma.category.deleteMany(),
    prisma.shop.deleteMany(),
    prisma.market.deleteMany(),
    prisma.address.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

async function main() {
  console.log('Seeding...');
  await clean();

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
    data: { name: 'Jamuna Future Park', slug: 'jamuna-future-park', city: 'Dhaka', address: 'Kuril, Progoti Sarani, Dhaka', latitude: 23.8133, longitude: 90.4246 },
  });
  const bashundhara = await prisma.market.create({
    data: { name: 'Bashundhara City', slug: 'bashundhara-city', city: 'Dhaka', address: 'Panthapath, Dhaka', latitude: 23.7512, longitude: 90.3908 },
  });

  // ---------- Shops ----------
  const techzone = await prisma.shop.create({
    data: {
      ownerId: owner1.id, marketId: jamuna.id,
      name: 'TechZone Electronics', slug: 'techzone-electronics',
      description: 'Authorized smartphone and laptop retailer.',
      levelFloor: 'Level 3', shopNumber: 'Shop 42',
      addressLine: 'Level 3, Shop 42, Jamuna Future Park, Dhaka',
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

  const brandNames = ['Samsung', 'Apple', 'Xiaomi', 'Dell'];
  const brands = {};
  for (const name of brandNames) {
    brands[name] = await prisma.brand.create({ data: { name } });
  }

  // ---------- Products (12) ----------
  const productDefs = [
    ['Galaxy A55 5G (8/128GB)', 'Samsung', catPhones, 41999, { ram: '8GB', storage: '128GB', color: 'Awesome Navy' }],
    ['Galaxy S24 (8/256GB)', 'Samsung', catPhones, 114999, { ram: '8GB', storage: '256GB', color: 'Onyx Black' }],
    ['iPhone 15 (128GB)', 'Apple', catPhones, 119900, { storage: '128GB', color: 'Blue' }],
    ['Redmi Note 13 Pro (8/256GB)', 'Xiaomi', catPhones, 38999, { ram: '8GB', storage: '256GB', color: 'Midnight Black' }],
    ['Poco X6 (8/256GB)', 'Xiaomi', catPhones, 32999, { ram: '8GB', storage: '256GB', color: 'Mirage Blue' }],
    ['Dell Inspiron 15 3520', 'Dell', catLaptops, 72000, { cpu: 'Core i5-1235U', ram: '8GB', storage: '512GB SSD' }],
    ['Dell Latitude 5440', 'Dell', catLaptops, 118000, { cpu: 'Core i7-1355U', ram: '16GB', storage: '512GB SSD' }],
    ['MacBook Air M2 (8/256GB)', 'Apple', catLaptops, 139900, { chip: 'Apple M2', ram: '8GB', storage: '256GB SSD' }],
    ['AirPods Pro (2nd gen)', 'Apple', catAcc, 29900, { type: 'TWS earbuds', anc: true }],
    ['Galaxy Buds2 Pro', 'Samsung', catAcc, 19900, { type: 'TWS earbuds', anc: true }],
    ['Mi Power Bank 3 20000mAh', 'Xiaomi', catAcc, 3200, { capacity: '20000mAh', ports: 2 }],
    ['Samsung 25W Fast Charger', 'Samsung', catAcc, 1800, { power: '25W', cable: 'USB-C' }],
  ];

  const products = [];
  for (const [title, brand, category, msrp, specs] of productDefs) {
    products.push(
      await prisma.product.create({
        data: {
          title, slug: slugify(title), brandId: brands[brand].id, categoryId: category.id,
          description: `${title} - genuine product with official warranty.`,
          specs, msrp, images: [],
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