// Test helper for test-to-let.ps1 (never used by the app).
//   cleanup <sinceIso> <emailSuffix> <userId...>
//     deletes every To-Let listing whose contact email ends with <emailSuffix> (with photos, files,
//     documents, threads, enquiries, notes), the notifications, audit entries and message log rows the
//     test caused, and the test users it registered.
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const [command, sinceIso, suffix, ...userIds] = process.argv.slice(2);
if (command !== 'cleanup' || !sinceIso || !suffix || !suffix.includes('@')) {
  console.error('usage: cleanup <sinceIso> <emailSuffix> <userId...>');
  process.exit(1);
}
const since = new Date(sinceIso);
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? 'uploads');

const listings = await prisma.toLetListing.findMany({
  where: { contactEmail: { endsWith: suffix } },
  include: { photos: { include: { image: true } }, documents: true, inquiries: { select: { id: true } } },
});
const listingIds = listings.map((l) => l.id);
const inquiryIds = listings.flatMap((l) => l.inquiries.map((i) => i.id));
const keys = listings.flatMap((l) => l.photos.map((p) => p.image.key));
const docs = listings.flatMap((l) => l.documents.map((d) => d.storedName));
const ids = [...listingIds, ...inquiryIds];
const none = ['-'];

const out = await prisma.$transaction(async (tx) => {
  const r = {};
  r.notifications = await tx.$executeRaw`
    DELETE FROM "Notification"
    WHERE ("createdAt" >= ${since} AND (data->>'toLetId' IN (${Prisma.join(ids.length ? ids : none)})
           OR data->>'toLetInquiryId' IN (${Prisma.join(ids.length ? ids : none)})))
       OR "userId" IN (${Prisma.join(userIds.length ? userIds : none)})`;
  r.auditLogs = (
    await tx.auditLog.deleteMany({
      where: {
        createdAt: { gte: since },
        OR: [
          { entityId: { in: [...ids, ...userIds] } },
          { action: { in: ['tolet.list_viewed', 'tolet.expired'] } },
          { actorId: { in: userIds } },
        ],
      },
    })
  ).count;
  r.messageLogs = (await tx.messageLog.deleteMany({ where: { createdAt: { gte: since }, template: { startsWith: 'TOLET_' } } })).count;
  await tx.image.deleteMany({ where: { key: { in: keys } } }); // cascades to ToLetPhoto
  r.listings = (await tx.toLetListing.deleteMany({ where: { id: { in: listingIds } } })).count; // threads, messages, enquiries, notes, documents cascade
  if (userIds.length) {
    await tx.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await tx.emailVerificationToken.deleteMany({ where: { userId: { in: userIds } } });
    await tx.userDevice.deleteMany({ where: { userId: { in: userIds } } });
    r.users = (await tx.user.deleteMany({ where: { id: { in: userIds } } })).count;
  }
  return r;
});

for (const k of keys) {
  for (const f of [`${k}.webp`, `${k}-thumb.webp`]) await unlink(path.join(uploadDir, 'media', f)).catch(() => {});
}
for (const d of docs) await unlink(path.join(uploadDir, 'private', d)).catch(() => {});
console.log(JSON.stringify({ ...out, files: keys.length * 2 + docs.length }));
await prisma.$disconnect();
