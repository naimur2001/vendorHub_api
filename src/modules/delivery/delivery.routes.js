import { Router } from 'express';
import { z } from 'zod';
import { validate, validateQuery } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { env } from '../../config/env.js';
import {
  idParam,
  reportQuery,
  timeseriesQuery,
  shipmentsQuery,
  quoteQuery,
  deliveryModeSchema,
  courierStoreSchema,
  providerUpdateSchema,
  zoneCreateSchema,
  zoneUpdateSchema,
  profitRuleCreateSchema,
  profitRuleUpdateSchema,
} from './delivery.schema.js';
import * as d from './delivery.service.js';
import * as sh from './shipments.service.js';
import * as rep from './reports.service.js';
import * as pr from './profitRules.service.js';

const router = Router();
const adminOnly = [authenticate, requireRole('ADMIN')];
const shopTeam = [authenticate, requireRole('SHOP_OWNER', 'SHOP_STAFF', 'ADMIN')];
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const list = (res, { items, pagination }) => res.json({ success: true, data: items, meta: { pagination } });

// Path ids must be UUIDs (ZodError -> 400).
const uuids = (...names) => {
  const schema = z.object(Object.fromEntries(names.map((n) => [n, z.uuid()])));
  return (req, res, next) => {
    schema.parse(req.params);
    next();
  };
};
const intId = (req, res, next) => {
  req.courierId = idParam.parse(req.params).id;
  next();
};

// ---------- public: delivery locations (names only) ----------
router.get('/delivery/locations/cities', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  ok(res, await d.cities());
});
router.get('/delivery/locations/cities/:id/zones', intId, async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  ok(res, await d.zonesOf(req.courierId));
});
router.get('/delivery/locations/zones/:id/areas', intId, async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  ok(res, await d.areasOf(req.courierId));
});

// ---------- customer: the delivery fee to one of my addresses (the admin zone fee) ----------
router.get('/delivery/quote', authenticate, validateQuery(quoteQuery), async (req, res) =>
  ok(res, await d.quoteForAddress(req.user.id, req.validated.addressId)),
);

// ---------- courier webhooks (no login; the signature is checked) ----------
router.post('/webhooks/couriers/pathao', async (req, res) => {
  const out = await sh.handleWebhook('PATHAO', req.headers, req.body);
  if (out.integration && env.PATHAO_WEBHOOK_INTEGRATION_SECRET) {
    res.set('X-Pathao-Merchant-Webhook-Integration-Secret', env.PATHAO_WEBHOOK_INTEGRATION_SECRET);
  }
  res.status(202).json({ success: true, data: out });
});

// ---------- shops ----------
router.patch('/shops/:shopId/delivery-mode', authenticate, uuids('shopId'), validate(deliveryModeSchema), async (req, res) =>
  ok(res, await d.setDeliveryMode(req.user, req.params.shopId, req.body)),
);
router.post('/shops/:shopId/orders/:orderId/ship', ...shopTeam, uuids('shopId', 'orderId'), async (req, res) =>
  ok(res, await sh.shipOrder(req.user, req.params.shopId, req.params.orderId)),
);

// ---------- admin ----------
router.post('/admin/shops/:shopId/courier-store', ...adminOnly, uuids('shopId'), validate(courierStoreSchema), async (req, res) =>
  ok(res, await d.createCourierStore(req.user, req.params.shopId, req.body)),
);

router.get('/admin/couriers', ...adminOnly, async (req, res) => ok(res, await d.listProviders()));
router.patch('/admin/couriers/:id', ...adminOnly, uuids('id'), validate(providerUpdateSchema), async (req, res) =>
  ok(res, await d.updateProvider(req.user, req.params.id, req.body)),
);

router.get('/admin/delivery-zones', ...adminOnly, async (req, res) => ok(res, await d.listZones()));
router.post('/admin/delivery-zones', ...adminOnly, validate(zoneCreateSchema), async (req, res) => ok(res, await d.createZone(req.user, req.body), 201));
router.patch('/admin/delivery-zones/:id', ...adminOnly, uuids('id'), validate(zoneUpdateSchema), async (req, res) =>
  ok(res, await d.updateZone(req.user, req.params.id, req.body)),
);
router.delete('/admin/delivery-zones/:id', ...adminOnly, uuids('id'), async (req, res) => {
  await d.deleteZone(req.user, req.params.id);
  ok(res, { message: 'Delivery zone deleted' });
});

router.get('/admin/delivery/profit-rules', ...adminOnly, async (req, res) => ok(res, await pr.listRules()));
router.post('/admin/delivery/profit-rules', ...adminOnly, validate(profitRuleCreateSchema), async (req, res) => ok(res, await pr.createRule(req.user, req.body), 201));
router.patch('/admin/delivery/profit-rules/:id', ...adminOnly, uuids('id'), validate(profitRuleUpdateSchema), async (req, res) =>
  ok(res, await pr.updateRule(req.user, req.params.id, req.body)),
);
router.delete('/admin/delivery/profit-rules/:id', ...adminOnly, uuids('id'), async (req, res) => {
  await pr.deleteRule(req.user, req.params.id);
  ok(res, { message: 'Profit rule deleted' });
});

router.get('/admin/delivery/summary', ...adminOnly, validateQuery(reportQuery), async (req, res) => ok(res, await rep.summary(req.validated)));
router.get('/admin/delivery/timeseries', ...adminOnly, validateQuery(timeseriesQuery), async (req, res) => ok(res, await rep.timeseries(req.validated)));
router.get('/admin/delivery/by-shop', ...adminOnly, validateQuery(reportQuery), async (req, res) => ok(res, await rep.byShop(req.validated)));
router.get('/admin/delivery/by-provider', ...adminOnly, validateQuery(reportQuery), async (req, res) => ok(res, await rep.byProvider(req.validated)));

router.get('/admin/shipments', ...adminOnly, validateQuery(shipmentsQuery), async (req, res) => list(res, await sh.listShipmentsAdmin(req.validated)));
router.get('/admin/shipments/:id', ...adminOnly, uuids('id'), async (req, res) => ok(res, await sh.getShipmentAdmin(req.params.id)));
router.post('/admin/shipments/:id/cancel', ...adminOnly, uuids('id'), async (req, res) => ok(res, await sh.cancelShipment(req.user, req.params.id)));
router.post('/admin/shipments/:id/rebook', ...adminOnly, uuids('id'), async (req, res) => ok(res, await sh.rebookShipment(req.user, req.params.id)));
router.post('/admin/shipments/:id/mark-cod-remitted', ...adminOnly, uuids('id'), async (req, res) => ok(res, await sh.markCodRemitted(req.user, req.params.id)));
router.post('/admin/shipments/:id/mark-shop-paid', ...adminOnly, uuids('id'), async (req, res) => ok(res, await sh.markShopPaid(req.user, req.params.id)));

export default router;
