// Stores CLIP fingerprints for visual search: product titles (text) and product photos (image).
// Always in the background and best-effort: a failure is logged, the backfill script fills gaps.
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { embedImage, embedTexts, toVectorLiteral } from './clip.js';

const titleText = (p) => `${p.brand?.name ?? ''} ${p.title}`.trim();

export async function fingerprintProductTitles(productIds) {
  if (!productIds.length) return 0;
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, title: true, brand: { select: { name: true } } },
  });
  if (!products.length) return 0;
  const vectors = await embedTexts(products.map(titleText));
  for (let i = 0; i < products.length; i += 1) {
    await prisma.$executeRaw`UPDATE "Product" SET "titleEmbedding" = ${toVectorLiteral(vectors[i])}::vector WHERE id = ${products[i].id}`;
  }
  return products.length;
}

export async function fingerprintImage(imageId, buffer) {
  const vector = await embedImage(buffer);
  await prisma.$executeRaw`UPDATE "Image" SET "embedding" = ${toVectorLiteral(vector)}::vector WHERE id = ${imageId}`;
}

/** Runs a fingerprint job without making the caller wait or fail. */
export function inBackground(job) {
  Promise.resolve()
    .then(job)
    .catch((err) => logger.warn({ err: err.message }, 'fingerprint failed (the backfill script will retry)'));
}