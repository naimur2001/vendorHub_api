// Test helper for test-delivery.ps1 (never used by the app; COURIER_MODE=mock only).
//   webhook <consignmentId> <event> <isoTime> [bad]   posts a signed Pathao-style webhook (bad = wrong signature)
//   integration                                       posts Pathao's webhook integration check
//   retry <minutesAhead>                              runs the booking retry job as if it were that much later
//   cleanup <sinceIso> <shopId>                       puts the shop back to OWN without a courier store and
//                                                     deletes the audit entries the test made for it and its shipments
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { webhookSecret } from '../src/lib/couriers/index.js';
import { retryBookings } from '../src/modules/delivery/shipments.service.js';

if (env.COURIER_MODE !== 'mock') {
  console.error('COURIER_MODE must be mock');
  process.exit(1);
}
const url = `${env.PUBLIC_API_URL}/api/v1/webhooks/couriers/pathao`;
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
} else if (command === 'cleanup') {
  const [sinceIso, shopId] = args;
  const since = new Date(sinceIso);
  await prisma.shop.update({ where: { id: shopId }, data: { deliveryMode: 'OWN', courierStoreId: null } });
  const a = await prisma.auditLog.deleteMany({
    where: { createdAt: { gte: since }, OR: [{ entityType: 'Shipment' }, { entityType: 'Shop', entityId: shopId, action: { startsWith: 'shop.' } }] },
  });
  out = { auditLogs: a.count };
} else {
  console.error('usage: webhook <consignmentId> <event> <isoTime> [bad] | integration | retry <minutesAhead> | cleanup <sinceIso> <shopId>');
  process.exitCode = 1;
}
await prisma.$disconnect();
if (out) console.log(JSON.stringify(out));
