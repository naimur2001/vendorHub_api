// Sets logoUrl / bannerUrl to null when they are not on our own API origin (old typed links).
// Usage: node --env-file=.env scripts/clean-shop-image-links.mjs   (production: once after deploying)
import { PrismaClient } from '@prisma/client';

const origin = `${process.env.PUBLIC_API_URL ?? 'http://localhost:4000'}/media/`;
const prisma = new PrismaClient();
const logos = await prisma.shop.updateMany({
  where: { logoUrl: { not: null }, NOT: { logoUrl: { startsWith: origin } } },
  data: { logoUrl: null },
});
const banners = await prisma.shop.updateMany({
  where: { bannerUrl: { not: null }, NOT: { bannerUrl: { startsWith: origin } } },
  data: { bannerUrl: null },
});
console.log(`Cleared ${logos.count} logo links and ${banners.count} banner links not on ${origin}`);
await prisma.$disconnect();