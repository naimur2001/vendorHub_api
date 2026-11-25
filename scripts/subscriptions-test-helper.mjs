// Test helper for test-subscriptions.ps1 (never used by the app).
//   snapshot <file> <shopId...>                  saves the shops' current subscription rows
//   job <hoursAhead>                             runs the subscription job as if it were that much later
//   cleanup <sinceIso> <file> <planCodePrefix> <shopId...>
//                                                deletes the test's subscriptions, requests, plans (by code
//                                                prefix), audit entries and notifications, and restores the
//                                                saved current rows
import fs from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { runSubscriptionJob } from '../src/modules/subscriptions/subscriptions.job.js';

const [command, ...args] = process.argv.slice(2);
let out;
if (command === 'snapshot') {
  const [file, ...shopIds] = args;
  const rows = await prisma.shopSubscription.findMany({ where: { shopId: { in: shopIds }, isCurrent: true } });
  fs.writeFileSync(file, JSON.stringify(rows.map((r) => ({ id: r.id, status: r.status }))));
  out = { saved: rows.length };
} else if (command === 'job') {
  out = await runSubscriptionJob(new Date(Date.now() + Number(args[0] ?? 0) * 60 * 60 * 1000));
} else if (command === 'cleanup') {
  const [sinceIso, file, prefix, ...shopIds] = args;
  const since = new Date(sinceIso);
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  out = await prisma.$transaction(async (tx) => {
    const r = {};
    r.requests = (await tx.subscriptionRequest.deleteMany({ where: { OR: [{ shopId: { in: shopIds }, createdAt: { gte: since } }, { plan: { code: { startsWith: prefix } } }] } })).count;
    r.subscriptions = (await tx.shopSubscription.deleteMany({ where: { OR: [{ shopId: { in: shopIds }, createdAt: { gte: since } }, { plan: { code: { startsWith: prefix } } }] } })).count; // payments cascade
    r.plans = (await tx.subscriptionPlan.deleteMany({ where: { code: { startsWith: prefix }, createdAt: { gte: since } } })).count;
    for (const s of saved) await tx.shopSubscription.update({ where: { id: s.id }, data: { isCurrent: true, endedAt: null, status: s.status } });
    r.restored = saved.length;
    r.auditLogs = (
      await tx.auditLog.deleteMany({
        where: { createdAt: { gte: since }, entityType: { in: ['ShopSubscription', 'SubscriptionPlan', 'SubscriptionPayment', 'SubscriptionRequest', 'PlatformSetting'] } },
      })
    ).count;
    r.notifications = (await tx.notification.deleteMany({ where: { createdAt: { gte: since }, type: { startsWith: 'SUBSCRIPTION_' } } })).count;
    return r;
  });
  if (fs.existsSync(file)) fs.unlinkSync(file);
} else {
  console.error('usage: snapshot <file> <shopId...> | job <hoursAhead> | cleanup <sinceIso> <file> <planCodePrefix> <shopId...>');
  process.exitCode = 1;
}
await prisma.$disconnect();
if (out) console.log(JSON.stringify(out));
