// Pathao Merchant API ("aladdin") adapter.
// Confirmed (paths and request fields, from the open-source codeboxrcodehub/pathao-courier SDK):
//   POST aladdin/api/v1/issue-token, GET countries/1/city-list, cities/:id/zone-list, zones/:id/area-list,
//   POST/GET aladdin/api/v1/stores, POST aladdin/api/v1/orders, GET aladdin/api/v1/orders/:consignmentId,
//   POST aladdin/api/v1/merchant/price-plan, POST aladdin/api/v1/orders/:consignmentId/cancel.
// TO CONFIRM with the sandbox (official docs could not be read): response field names (data.data[]
// city_id/city_name ..., consignment_id, delivery_fee, final_price, order_status_slug, store_id),
// the refresh_token grant, and the webhook signature (header X-PATHAO-Signature = the webhook secret).
// Secrets come only from env and are never returned or logged.
import crypto from 'node:crypto';
import { env } from '../../config/env.js';

const SANDBOX_URL = 'https://courier-api-sandbox.pathao.com';
const LIVE_URL = 'https://api-hermes.pathao.com';
const TIMEOUT_MS = 15000;

export class CourierError extends Error {
  constructor(code, status) {
    super(`Courier request failed (${code})`); // fixed text: never the courier's answer or our payload
    this.code = code;
    this.status = status;
  }
}

let token = null; // { access, refresh, expiresAt, baseUrl } kept in memory only

const baseUrl = (provider) => env.PATHAO_BASE_URL ?? (provider.sandbox ? SANDBOX_URL : LIVE_URL);

async function call(url, { method = 'GET', body, auth } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(auth && { Authorization: `Bearer ${auth}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    throw new CourierError('NETWORK');
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new CourierError(`HTTP_${res.status}`, res.status);
  return json;
}

async function issueToken(provider, grant) {
  const url = `${baseUrl(provider)}/aladdin/api/v1/issue-token`;
  const body = {
    client_id: env.PATHAO_CLIENT_ID,
    client_secret: env.PATHAO_CLIENT_SECRET,
    ...(grant === 'refresh'
      ? { grant_type: 'refresh_token', refresh_token: token.refresh }
      : { grant_type: 'password', username: env.PATHAO_USERNAME, password: env.PATHAO_PASSWORD }),
  };
  const json = await call(url, { method: 'POST', body });
  if (!json?.access_token) throw new CourierError('TOKEN');
  token = {
    access: json.access_token,
    refresh: json.refresh_token ?? null,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 - 60 * 1000, // a minute early
    baseUrl: baseUrl(provider),
  };
}

async function accessToken(provider) {
  if (token && token.baseUrl === baseUrl(provider) && Date.now() < token.expiresAt) return token.access;
  if (token?.refresh && token.baseUrl === baseUrl(provider)) {
    try {
      await issueToken(provider, 'refresh');
      return token.access;
    } catch {
      // fall back to a new password grant
    }
  }
  await issueToken(provider, 'password');
  return token.access;
}

async function api(provider, path, opts = {}) {
  const url = `${baseUrl(provider)}/aladdin/api/v1${path}`;
  try {
    return await call(url, { ...opts, auth: await accessToken(provider) });
  } catch (err) {
    if (err.status !== 401) throw err;
    token = null; // expired early or revoked: one new token, one retry
    return call(url, { ...opts, auth: await accessToken(provider) });
  }
}

const list = (json) => json?.data?.data ?? json?.data ?? [];
const cfg = (provider) => ({ deliveryType: 48, itemType: 2, itemWeight: 0.5, ...(provider.config ?? {}) });
const toInt = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v)));

export const pathao = {
  async cities(provider) {
    return list(await api(provider, '/countries/1/city-list')).map((c) => ({ id: Number(c.city_id), name: c.city_name }));
  },
  async zones(provider, cityId) {
    return list(await api(provider, `/cities/${Number(cityId)}/zone-list`)).map((z) => ({ id: Number(z.zone_id), name: z.zone_name }));
  },
  async areas(provider, zoneId) {
    return list(await api(provider, `/zones/${Number(zoneId)}/area-list`)).map((a) => ({
      id: Number(a.area_id),
      name: a.area_name,
      homeDelivery: a.home_delivery_available !== false,
    }));
  },

  /** Creates the shop's pickup store; Pathao approves it later, so the id may only come from findStore. */
  async createStore(provider, s) {
    const json = await api(provider, '/stores', {
      method: 'POST',
      body: {
        name: s.name,
        contact_name: s.contactName,
        contact_number: s.phone,
        address: s.address,
        city_id: s.cityId,
        zone_id: s.zoneId,
        area_id: s.areaId,
      },
    });
    const id = json?.data?.store_id;
    return { storeId: id ? String(id) : null };
  },
  async findStore(provider, name) {
    for (let page = 1; page <= 10; page++) {
      const rows = list(await api(provider, `/stores?page=${page}`));
      const hit = rows.find((r) => r.store_name === name);
      if (hit) return { storeId: String(hit.store_id), active: hit.is_active !== 0 && hit.is_active !== false };
      if (rows.length === 0) break;
    }
    return null;
  },

  async quote(provider, { storeId, cityId, zoneId }) {
    const c = cfg(provider);
    const json = await api(provider, '/merchant/price-plan', {
      method: 'POST',
      body: { store_id: Number(storeId), item_type: c.itemType, delivery_type: c.deliveryType, item_weight: c.itemWeight, recipient_city: cityId, recipient_zone: zoneId },
    });
    return { cost: toInt(json?.data?.final_price ?? json?.data?.price) };
  },

  async createOrder(provider, o) {
    const c = cfg(provider);
    const json = await api(provider, '/orders', {
      method: 'POST',
      body: {
        store_id: Number(o.storeId),
        merchant_order_id: o.merchantOrderId,
        recipient_name: o.recipient.name,
        recipient_phone: o.recipient.phone,
        recipient_address: o.recipient.address,
        recipient_city: o.recipient.cityId,
        recipient_zone: o.recipient.zoneId,
        recipient_area: o.recipient.areaId,
        delivery_type: c.deliveryType,
        item_type: c.itemType,
        item_quantity: o.itemQuantity,
        item_weight: c.itemWeight,
        amount_to_collect: o.codAmount,
        item_description: o.description,
      },
    });
    const d = json?.data ?? {};
    if (!d.consignment_id) throw new CourierError('NO_CONSIGNMENT');
    return { consignmentId: String(d.consignment_id), trackingCode: String(d.consignment_id), cost: toInt(d.delivery_fee), rawStatus: d.order_status ?? null };
  },

  async cancel(provider, consignmentId) {
    await api(provider, `/orders/${encodeURIComponent(consignmentId)}/cancel`, { method: 'POST' });
  },

  async track(provider, consignmentId) {
    const json = await api(provider, `/orders/${encodeURIComponent(consignmentId)}`);
    const d = json?.data ?? {};
    return { rawStatus: d.order_status_slug ?? d.order_status ?? null, at: d.updated_at ? new Date(d.updated_at) : null };
  },

  /**
   * Checks the signature and reads a webhook. Returns { integration } for Pathao's setup check, else
   * { events: [{ consignmentId, rawStatus, at, reason, cost, raw }] }. Throws 'BAD_SIGNATURE'.
   */
  parseWebhook(headers, body, secret) {
    const got = String(headers['x-pathao-signature'] ?? '');
    const a = Buffer.from(got);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new CourierError('BAD_SIGNATURE', 401);
    if (body?.event === 'webhook_integration') return { integration: true, events: [] };
    if (!body?.consignment_id || !body?.event) return { integration: false, events: [] };
    const at = new Date(body.updated_at ?? body.timestamp ?? Date.now());
    return {
      integration: false,
      events: [
        {
          consignmentId: String(body.consignment_id),
          rawStatus: String(body.event),
          at: Number.isNaN(at.getTime()) ? new Date() : at,
          reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null,
          cost: toInt(body.delivery_fee),
          raw: body,
        },
      ],
    };
  },
};
