// DEVELOPMENT TOOL. Records (or compares) the answers of GET /products for many queries.
// Usage, always on freshly seeded data (node --env-file=.env prisma/seed.js) with the API running:
//   node scripts/catalog-golden.mjs record    -> saves logs/catalog-golden.json (before a change)
//   node scripts/catalog-golden.mjs compare   -> checks the current API against it (after a change)
// Queries use slugs and names; ids are looked up at run time because they change on every reseed.
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const BASE = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const FILE = 'logs/catalog-golden.json';
const mode = process.argv[2];
if (!['record', 'compare'].includes(mode)) {
  console.error('Usage: node scripts/catalog-golden.mjs record|compare');
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// The fields that must stay identical (ids and createdAt change on every reseed, so they are left out).
const normalize = (p) => ({
  slug: p.slug,
  title: p.title,
  brand: p.brand?.name ?? null,
  category: p.category?.slug ?? null,
  image: p.image,
  msrp: p.msrp,
  lowestPrice: p.lowestPrice,
  highestPrice: p.highestPrice,
  shopCount: p.shopCount,
  availability: p.availability,
  bargainAvailable: p.bargainAvailable,
});

async function buildQueries() {
  const categories = (await get('/categories')).json.data;
  const brands = (await get('/brands')).json.data;
  const markets = (await get('/markets')).json.data;
  const shops = [];
  const seen = new Set();
  for (const m of markets) {
    const detail = (await get(`/markets/${m.slug}`)).json.data;
    for (const s of detail.shops ?? []) {
      if (!seen.has(s.slug)) {
        seen.add(s.slug);
        shops.push(s);
      }
    }
  }

  const list = [];
  const add = (name, params) => list.push({ name, params });
  for (const sort of ['newest', 'price_asc', 'price_desc']) add(`all ${sort}`, { sort });
  for (const c of categories) {
    add(`category ${c.slug}`, { category: c.slug });
    add(`category ${c.slug} price_asc`, { category: c.slug, sort: 'price_asc' });
  }
  for (const b of brands) add(`brand ${b.name.toLowerCase()}`, { brand: b.name.toLowerCase() });
  for (const m of markets) {
    add(`market ${m.slug}`, { marketId: m.id });
    add(`market ${m.slug} price_asc`, { marketId: m.id, sort: 'price_asc' });
  }
  for (const s of shops) add(`shop ${s.slug}`, { shopId: s.id });
  add('minPrice 20000', { minPrice: 20000 });
  add('maxPrice 40000', { maxPrice: 40000 });
  add('price 20000-40000 price_desc', { minPrice: 20000, maxPrice: 40000, sort: 'price_desc' });
  add('availableOnly', { availableOnly: 'true' });
  add('availableOnly price_asc', { availableOnly: 'true', sort: 'price_asc' });
  for (const text of ['galaxy', 'SAMSUNG', 'a5', '100%', 'a_5', '%', '_']) add(`q ${text}`, { q: text });
  add('q galaxy availableOnly price_asc', { q: 'galaxy', availableOnly: 'true', sort: 'price_asc' });
  add('unknown category', { category: 'no-such-category' });
  return list;
}

const qs = (params) => new URLSearchParams({ ...params, limit: '50' }).toString();

async function run(query) {
  const r = await get(`/products?${qs(query.params)}`);
  return {
    status: r.status,
    total: r.json?.meta?.pagination?.total ?? null,
    items: (r.json?.data ?? []).map(normalize),
    raw: r.json?.data ?? [],
  };
}

const queries = await buildQueries();

if (mode === 'record') {
  const saved = [];
  for (const query of queries) {
    const { status, total, items } = await run(query);
    saved.push({ name: query.name, status, total, items });
  }
  await mkdir('logs', { recursive: true });
  await writeFile(FILE, JSON.stringify(saved, null, 2));
  console.log(`Recorded ${saved.length} queries into ${FILE}`);
  process.exit(0);
}

// ---------- compare ----------
const golden = JSON.parse(await readFile(FILE, 'utf8'));
const byName = new Map(golden.map((g) => [g.name, g]));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` | ${detail}` : ''}`);
  }
};

const sortKey = { newest: (p) => -Date.parse(p.createdAt), price_asc: (p) => p.lowestPrice, price_desc: (p) => -p.lowestPrice };

for (const query of queries) {
  const old = byName.get(query.name);
  if (!old) {
    check(query.name, false, 'not in the recorded file (record again on fresh seed data)');
    continue;
  }
  const now = await run(query);
  check(`${query.name}: status`, now.status === old.status, `${now.status} vs ${old.status}`);
  check(`${query.name}: total`, now.total === old.total, `${now.total} vs ${old.total}`);
  const oldMap = new Map(old.items.map((p) => [p.slug, JSON.stringify(p)]));
  const newMap = new Map(now.items.map((p) => [p.slug, JSON.stringify(p)]));
  const sameSet = oldMap.size === newMap.size && [...oldMap.keys()].every((k) => newMap.has(k));
  check(`${query.name}: same products`, sameSet);
  for (const [slug, json] of oldMap) {
    if (newMap.has(slug)) check(`${query.name}: ${slug} values`, newMap.get(slug) === json, `${newMap.get(slug)} vs ${json}`);
  }
  const key = sortKey[query.params.sort ?? 'newest'];
  const keys = now.raw.map(key);
  check(`${query.name}: sort order`, keys.every((k, i) => i === 0 || keys[i - 1] <= k));
}

// pagination: pages of 5 must add up to the full list, without overlaps or gaps
for (const params of [{ sort: 'newest' }, { sort: 'price_asc' }, { sort: 'price_desc' }]) {
  const full = (await get(`/products?${qs(params)}`)).json;
  const total = full.meta.pagination.total;
  const pages = Math.ceil(total / 5);
  const slugs = [];
  for (let page = 1; page <= pages; page += 1) {
    const r = (await get(`/products?${new URLSearchParams({ ...params, page: String(page), limit: '5' })}`)).json;
    check(`pages ${params.sort}: page ${page} totalPages`, r.meta.pagination.totalPages === pages);
    slugs.push(...r.data.map((p) => p.slug));
  }
  check(`pages ${params.sort}: pages add up to the full list`, JSON.stringify(slugs) === JSON.stringify(full.data.map((p) => p.slug)));
  check(`pages ${params.sort}: no duplicates`, new Set(slugs).size === slugs.length);
}
check('limit 51 is rejected', (await get('/products?limit=51')).status === 400);

console.log(`\nPassed: ${pass}   Failed: ${fail}`);
process.exit(fail ? 1 : 0);