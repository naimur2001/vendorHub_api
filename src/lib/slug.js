import { prisma } from './prisma.js';

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// `model` is a Prisma delegate name such as 'product'. Appends -2, -3 ... until the slug is free.
export async function uniqueSlug(model, text) {
  const base = slugify(text) || 'item';
  let slug = base;
  let n = 1;
  for (;;) {
    const found = await prisma[model].findUnique({ where: { slug }, select: { id: true } });
    if (!found) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}