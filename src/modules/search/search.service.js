// Search by photo. Always: free visual search with CLIP on our own server (similar product photos
// and matching titles). Optional: search words from Gemini (SEARCH_IMAGE_MODE=gemini) or a fixed test
// answer (mock). The photo is never stored or logged.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { processImage } from '../../lib/images.js';
import { thumbFor } from '../../lib/storage.js';
import { embedImage, toVectorLiteral } from '../../lib/clip.js';
import { identifyProduct } from '../../lib/imageSearch.js';

const RESULTS = 12;
const TITLE_WEIGHT = 2.8; // photo-to-text similarities are naturally lower than photo-to-photo ones

// Untrusted model text: no control characters, single spaces, limited length.
const clean = (value, max) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Optional search words. Never fails the request: on any AI problem the words are simply null.
async function describe(processed) {
  const none = { query: null, label: null, category: null };
  if (env.SEARCH_IMAGE_MODE === 'off') return none;
  try {
    const categories = await prisma.category.findMany({ select: { name: true, slug: true } });
    const raw = await identifyProduct({ buffer: processed.full, mimeType: 'image/webp', categoryNames: categories.map((c) => c.name) });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none;
    const query = clean(raw.query, 100).replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (query.length < 2) return none;
    const hint = clean(raw.categoryHint, 100).toLowerCase();
    const category = hint ? categories.find((c) => c.name.toLowerCase() === hint) : null;
    return {
      query,
      label: clean(raw.label, 80) || query.slice(0, 80),
      category: category ? { slug: category.slug, name: category.name } : null,
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'search words unavailable; visual results only');
    return none;
  }
}

// Visual search: the best of photo similarity and (weighted) title similarity, active products only.
async function similarProducts(buffer) {
  let vector;
  try {
    vector = await embedImage(buffer);
  } catch (err) {
    logger.error({ err: err.message }, 'visual search model unavailable');
    throw new AppError(503, 'Search by photo is not available right now. Please try again later.');
  }
  const v = toVectorLiteral(vector);
  const rows = await prisma.$queryRaw`
    WITH photo AS (
      SELECT i."productId", MAX(1 - (i.embedding <=> ${v}::vector)) AS score
      FROM "Image" i
      WHERE i."productId" IS NOT NULL AND i.embedding IS NOT NULL
      GROUP BY i."productId"
    )
    SELECT p.id, p.slug, p.title, p.images[1] AS image, l.lowest, l.shops,
           COALESCE(photo.score, 0) AS "photoScore",
           COALESCE(1 - (p."titleEmbedding" <=> ${v}::vector), 0) AS "titleScore"
    FROM "Product" p
    JOIN LATERAL (
      SELECT MIN(sl.price) AS lowest, COUNT(*)::int AS shops
      FROM "ShopListing" sl
      JOIN "Shop" s ON s.id = sl."shopId"
      WHERE sl."productId" = p.id AND sl."isActive" = true AND s."isActive" = true
    ) l ON l.shops > 0
    LEFT JOIN photo ON photo."productId" = p.id
    WHERE p."isActive" = true AND (photo.score IS NOT NULL OR p."titleEmbedding" IS NOT NULL)
    ORDER BY GREATEST(COALESCE(photo.score, 0), COALESCE(1 - (p."titleEmbedding" <=> ${v}::vector), 0) * ${TITLE_WEIGHT}) DESC, p.id
    LIMIT ${RESULTS}`;

  return rows.map((r) => {
    const photoScore = Number(r.photoScore);
    const titleScore = Number(r.titleScore) * TITLE_WEIGHT;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      image: r.image ?? null,
      thumbnail: r.image ? thumbFor(r.image) : null,
      lowestPrice: r.lowest,
      shopCount: r.shops,
      match: photoScore >= titleScore ? 'photo' : 'title',
      score: Math.round(Math.max(photoScore, titleScore) * 1000) / 1000,
    };
  });
}

export async function searchByImage(file) {
  if (!file) throw new AppError(400, 'Send exactly one photo in the multipart field "photo"');
  // type from content + decoder check; re-encoded and small, no EXIF/GPS
  const processed = await processImage(file.buffer, 'SEARCH');
  const [words, products] = await Promise.all([describe(processed), similarProducts(processed.full)]);
  return { ...words, products };
}