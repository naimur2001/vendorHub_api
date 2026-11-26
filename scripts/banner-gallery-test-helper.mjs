// Test helper for test-banner-gallery.ps1 (never used by the app).
//   audit <sinceIso> <bannerId>   the banner audit actions for one banner since then
//   files                         how many files are in uploads/media (no file may be kept on a 409)
//   cleanup <sinceIso>            deletes the banner audit entries made since then (the suite deletes its banners itself)
import fs from 'node:fs';
import { prisma } from '../src/lib/prisma.js';

const [command, ...args] = process.argv.slice(2);
let out;
if (command === 'audit') {
  const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: new Date(args[0]) }, entityType: 'Banner', entityId: args[1] }, orderBy: { createdAt: 'asc' } });
  out = { actions: rows.map((r) => r.action).join(',') };
} else if (command === 'files') {
  out = { files: fs.readdirSync('uploads/media').length };
} else if (command === 'cleanup') {
  out = { auditLogs: (await prisma.auditLog.deleteMany({ where: { createdAt: { gte: new Date(args[0]) }, entityType: 'Banner' } })).count };
} else {
  console.error('usage: audit <sinceIso> <bannerId> | files | cleanup <sinceIso>');
  process.exitCode = 1;
}
await prisma.$disconnect();
if (out) console.log(JSON.stringify(out));
