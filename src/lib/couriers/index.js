// Couriers behind one interface, chosen by COURIER_MODE:
//   mock  no courier calls: fixed location lists, fixed prices, fake consignment ids (development, tests)
//   live  the provider's real adapter (only PATHAO exists; STEADFAST, REDX, PAPERFLY, ECOURIER later)
// Every adapter has: cities, zones, areas, createStore, findStore, quote, createOrder, cancel, track,
// parseWebhook. Location lists are cached in memory for COURIER_LOCATIONS_CACHE_MS.
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';
import { COURIER_LOCATIONS_CACHE_MS } from '../../config/limits.js';
import { pathao, CourierError } from './pathao.js';

export { CourierError };

// Mock: Pathao-like ids (city 1 = Dhaka). Prices: city 1 = 60, else 110 taka.
const MOCK_CITIES = [
  { id: 1, name: 'Dhaka' },
  { id: 2, name: 'Chattogram' },
  { id: 3, name: 'Gazipur' },
];
const MOCK_ZONES = {
  1: [{ id: 101, name: 'Dhanmondi' }, { id: 102, name: 'Gulshan' }, { id: 103, name: 'Savar' }],
  2: [{ id: 201, name: 'Agrabad' }],
  3: [{ id: 301, name: 'Tongi' }],
};
const mockAreas = (zoneId) => [
  { id: zoneId * 10 + 1, name: 'Road 1 area', homeDelivery: true },
  { id: zoneId * 10 + 2, name: 'Road 2 area', homeDelivery: true },
];
export const MOCK_FAIL_MARK = '[mock-fail]'; // a recipient address with this fails booking (tests)

const mock = {
  cities: async () => MOCK_CITIES,
  zones: async (_p, cityId) => MOCK_ZONES[cityId] ?? [],
  areas: async (_p, zoneId) => (Object.values(MOCK_ZONES).flat().some((z) => z.id === Number(zoneId)) ? mockAreas(Number(zoneId)) : []),
  createStore: async (_p, s) => ({ storeId: `MOCK-STORE-${crypto.createHash('sha256').update(s.name).digest('hex').slice(0, 8)}` }),
  findStore: async () => null,
  quote: async (_p, { cityId }) => ({ cost: Number(cityId) === 1 ? 60 : 110 }),
  async createOrder(_p, o) {
    if (o.recipient.address.includes(MOCK_FAIL_MARK)) throw new CourierError('MOCK_FAIL');
    const id = `MOCK${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    return { consignmentId: id, trackingCode: id, cost: Number(o.recipient.cityId) === 1 ? 60 : 110, rawStatus: 'Pending' };
  },
  cancel: async () => {},
  track: async () => ({ rawStatus: null, at: null }),
  parseWebhook: (headers, body, secret) => pathao.parseWebhook(headers, body, secret), // same format as Pathao
};

const LIVE = { PATHAO: pathao };

/** The adapter for a provider row. */
export function adapterFor(provider) {
  if (env.COURIER_MODE === 'mock') return mock;
  const a = LIVE[provider.code];
  if (!a) throw new AppError(503, 'This courier is not connected yet');
  return a;
}

/** The webhook secret for a provider (mock mode: derived from JWT_ACCESS_SECRET unless set). */
export function webhookSecret(code) {
  if (code !== 'PATHAO') return null;
  return env.PATHAO_WEBHOOK_SECRET ?? (env.COURIER_MODE === 'mock'
    ? crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update('courier-webhook-mock').digest('hex')
    : null);
}

// ---------- cached location lists ----------
const cache = new Map(); // key -> { at, rows }

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < COURIER_LOCATIONS_CACHE_MS) return hit.rows;
  const rows = await load();
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

export const locations = {
  cities: (provider) => cached(`${provider.code}:cities`, () => adapterFor(provider).cities(provider)),
  zones: (provider, cityId) => cached(`${provider.code}:zones:${cityId}`, () => adapterFor(provider).zones(provider, cityId)),
  areas: (provider, zoneId) => cached(`${provider.code}:areas:${zoneId}`, () => adapterFor(provider).areas(provider, zoneId)),
};
