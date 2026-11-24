// DEVELOPMENT TOOL: checks the Pathao adapter against the Pathao SANDBOX with the keys in .env
// (PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET, PATHAO_USERNAME, PATHAO_PASSWORD; optional PATHAO_BASE_URL).
// Read-only by default: token, city / zone / area lists, stores. With --price <storeId> it also asks the
// price plan for Dhaka. Never prints keys or tokens. Never run it against the live URL by accident:
// it refuses unless the base URL contains "sandbox".
// Usage: node --env-file=.env scripts/check-pathao.mjs [--price <storeId>]
import { env } from '../src/config/env.js';
import { pathao } from '../src/lib/couriers/pathao.js';

const provider = { code: 'PATHAO', sandbox: true, config: null };
const base = env.PATHAO_BASE_URL ?? 'https://courier-api-sandbox.pathao.com';
if (!base.includes('sandbox')) {
  console.error('Refusing: PATHAO_BASE_URL is not the sandbox');
  process.exit(1);
}
const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log(`OK    ${name}: ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.code ?? err.message}`);
    return null;
  }
};

const cities = await step('cities', () => pathao.cities(provider));
const city = cities?.find((c) => /dhaka/i.test(c.name)) ?? cities?.[0];
const zones = city ? await step(`zones of ${city.name} (${city.id})`, () => pathao.zones(provider, city.id)) : null;
if (zones?.[0]) await step(`areas of ${zones[0].name} (${zones[0].id})`, () => pathao.areas(provider, zones[0].id));
await step('stores (looking for "VH test")', () => pathao.findStore(provider, 'VH test'));
const i = process.argv.indexOf('--price');
if (i > 0 && city && zones?.[0]) {
  await step('price plan', () => pathao.quote(provider, { storeId: process.argv[i + 1], cityId: city.id, zoneId: zones[0].id }));
}
