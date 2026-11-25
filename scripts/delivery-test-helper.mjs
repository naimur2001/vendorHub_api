// Test helper for test-delivery.ps1 (never used by the app; COURIER_MODE=mock only).
//   webhook <consignmentId> <event> <isoTime> [bad]   posts a signed Pathao-style webhook (bad = wrong signature)
//   integration                                       posts Pathao's webhook integration check
//   retry <minutesAhead>                              runs the booking retry job as if it were that much later
//   snapshot <file> <shopId...>                       saves the shops' delivery settings to <file>, then puts
//                                                     them on OWN without a courier store (a known start)
//   store-steps <sinceIso> <shopId>                   the courier-store audit steps since then (created, checked, ...)
//   default-mode                                      the deliveryMode a new shop gets (made and rolled back)
//   cleanup <sinceIso> <file> <shopId...>             restores the saved delivery settings and deletes the audit
//                                                     entries the test made (shops, shipments, delivery zones)
import { env } from '../src/config/env.js';
import fs from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { webhookSecret } from '../src/lib/couriers/index.js';
import { retryBookings } from '../src/modules/delivery/shipments.service.js';

if (env.COURIER_MODE !== 'mock') {
  console.error('COURIER_MODE must be mock');
  process.exit(1);
}
const url = `${env.PUBLIC_API_URL}/api/v1/webhooks/couriers/pathao`;
const SETTINGS = { deliveryMode: true, courierStoreId: true, courierStoreState: true, courierStoreLocation: true, courierStoreRequestedAt: true };
const START = { deliveryMode: 'OWN', courierStoreId: null, courierStoreState: 'NONE', courierStoreLocation: Prisma.DbNull, courierStoreRequestedAt: null };
const post = async (body, signature) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PATHAO-Signature': signature }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const [command, ...args] = process.argv.slice(2);
let out;
if (command === 'webhook') {
  const [consignmentId, event, at, bad] = args;
  const sig = bad ? 'x'.repeat(webhookSecret('PATHAO').length) : webhookSecret('PATHAO');
  out = await post({ consignment_id: consignmentId, merchant_order_id: 'test', event, updated_at: at, timestamp: at }, sig);
} else if (command === 'integration') {
  out = await post({ event: 'webhook_integration' }, webhookSecret('PATHAO'));
} else if (command === 'retry') {
  out = await retryBookings(new Date(Date.now() + Number(args[0] ?? 0) * 60 * 1000));
} else if (command === 'snapshot') {
  const [file, ...shopIds] = args;
  const rows = await prisma.shop.findMany({ where: { id: { in: shopIds } }, select: { id: true, ...SETTINGS } });
  fs.writeFileSync(file, JSON.stringify(rows));
  await prisma.shop.updateMany({ where: { id: { in: shopIds } }, data: { ...START } });
  out = { saved: rows.length };
} else if (command === 'store-steps') {
  const [sinceIso, shopId] = args;
  const rows = await prisma.auditLog.findMany({
    where: { createdAt: { gte: new Date(sinceIso) }, entityType: 'Shop', entityId: shopId, action: 'shop.courier_store_set' },
    orderBy: { createdAt: 'asc' },
  });
  out = { steps: rows.map((r) => r.meta.step).join(',') };
} else if (command === 'default-mode') {
  const owner = await prisma.user.findFirstOrThrow({ where: { role: 'SHOP_OWNER' } });
  out = await prisma
    .$transaction(async (tx) => {
      const s = await tx.shop.create({ data: { ownerId: owner.id, name: 'Default mode check', slug: `default-mode-${Date.now()}`, addressLine: 'Test' } });
      throw Object.assign(new Error('rollback'), { result: { deliveryMode: s.deliveryMode, courierStoreState: s.courierStoreState } });
    })
    .catch((err) => err.result ?? { error: err.message });
} else if (command === 'cleanup') {
  const [sinceIso, file, ...shopIds] = args;
  const since = new Date(sinceIso);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  for (const id of shopIds) {
    const s = saved.find((r) => r.id === id);
    const data = s
      ? { ...s, id: undefined, courierStoreLocation: s.courierStoreLocation ?? Prisma.DbNull, courierStoreRequestedAt: s.courierStoreRequestedAt && new Date(s.courierStoreRequestedAt) }
      : START;
    await prisma.shop.update({ where: { id }, data });
  }
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const a = await prisma.auditLog.deleteMany({
    where: {
      createdAt: { gte: since },
      OR: [{ entityType: 'Shipment' }, { entityType: 'DeliveryZone' }, { entityType: 'Shop', entityId: { in: shopIds }, action: { startsWith: 'shop.' } }],
    },
  });
  out = { auditLogs: a.count, restored: saved.length };
} else {
  console.error('usage: webhook <consignmentId> <event> <isoTime> [bad] | integration | retry <minutesAhead> | snapshot <file> <shopId...> | store-steps <sinceIso> <shopId> | default-mode | cleanup <sinceIso> <file> <shopId...>');
  process.exitCode = 1;
}
await prisma.$disconnect();
if (out) console.log(JSON.stringify(out));
