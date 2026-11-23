// Shop To-Let: shared helpers (presenting, access, notifications).
// Privacy: contactName / contactPhone / contactEmail, inquiry contacts and documents appear ONLY in
// the owner's own view (presentOwner) and in the admin routes. The public shape never has them.
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { sendMail } from '../../lib/mailer.js';
import { sendPlainMessage } from '../../lib/messaging.js';
import { presentImage } from '../../lib/storage.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';

export const NOT_FOUND = 'Listing not found';
export const OPEN = ['PENDING_EMAIL', 'SUBMITTED', 'NEEDS_INFO', 'PUBLISHED'];
export const EDITABLE = OPEN;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const newToken = () => crypto.randomBytes(32).toString('hex');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// availableFrom is a Dhaka calendar day
export const dayToDate = (day) => new Date(`${day}T00:00:00+06:00`);
const DHAKA_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });
export const dateToDay = (d) => (d ? DHAKA_DAY.format(d) : null);

export const listingInclude = {
  market: { select: { id: true, name: true, slug: true } },
  photos: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { image: true } },
};

export async function categoriesById(listings) {
  const ids = [...new Set(listings.flatMap((l) => l.suitableFor ?? []))];
  if (!ids.length) return new Map();
  const rows = await prisma.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
  return new Map(rows.map((c) => [c.id, c]));
}

const placeName = (l) => l.market?.name ?? l.marketName ?? null;
export const titleOf = (l) => `Shop space for rent${l.levelFloor ? `, ${l.levelFloor}` : ''}${placeName(l) ? ` - ${placeName(l)}` : ''}`;
const photoOf = (p) => ({ id: p.id, ...presentImage(p.image) });

/** The public card (list). No contact fields, no documents. */
export const presentCard = (l) => ({
  id: l.id,
  slug: l.slug,
  title: titleOf(l),
  market: l.market ?? null,
  marketName: placeName(l),
  levelFloor: l.levelFloor,
  addressLine: l.addressLine,
  sizeSqft: l.sizeSqft,
  monthlyRent: l.monthlyRent,
  advance: l.advance,
  availableFrom: dateToDay(l.availableFrom),
  cover: l.photos[0] ? photoOf(l.photos[0]) : null,
  photoCount: l.photos.length,
  publishedAt: l.publishedAt,
  expiresAt: l.expiresAt,
});

/** The public detail page. No contact fields, no documents. */
export const presentPublic = (l, cats) => ({
  ...presentCard(l),
  shopNumber: l.shopNumber,
  suitableFor: (l.suitableFor ?? []).map((id) => cats.get(id)).filter(Boolean),
  description: l.description,
  photos: l.photos.map(photoOf),
});

/** The owner's own view: the public fields plus status, their contact and their documents (metadata only). */
export const presentOwner = (l, cats) => ({
  ...presentPublic(l, cats),
  marketId: l.marketId,
  status: l.status,
  rejectReason: l.rejectReason,
  contactName: l.contactName,
  contactPhone: l.contactPhone,
  contactEmail: l.contactEmail,
  documents: (l.documents ?? []).map((d) => ({ id: d.id, mimeType: d.mimeType, size: d.size, originalName: d.originalName, createdAt: d.createdAt })),
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

/**
 * The owner of a listing: the logged-in submitter, or a guest with the manage token
 * (header X-Manage-Token). Anyone else gets 404, so listing ids cannot be probed.
 */
export async function ownerListing(req, id, include = {}) {
  const l = await prisma.toLetListing.findUnique({ where: { id }, include: { ...listingInclude, documents: true, ...include } });
  if (!l) throw new AppError(404, NOT_FOUND);
  const token = req.get('x-manage-token');
  const byLogin = Boolean(req.user && l.submitterId && l.submitterId === req.user.id);
  const byToken = Boolean(token && /^[a-f0-9]{64}$/.test(token) && l.manageTokenHash && hashToken(token) === l.manageTokenHash);
  if (!byLogin && !byToken) throw new AppError(404, NOT_FOUND);
  return l;
}

export const audit = (actorId, action, entityType, entityId, meta, tx = prisma) =>
  tx.auditLog.create({ data: { actorId: actorId ?? null, action, entityType, entityId, meta: meta ?? undefined } });

// ---------- notifications (in the app, plus email or SMS; all best effort, never throw) ----------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function mailText(to, subject, lines) {
  if (!to) return;
  try {
    const text = lines.join('\n');
    const html = lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')).join('');
    await sendMail({ to, subject, text, html });
  } catch (err) {
    logger.error({ err: err.message }, 'to-let email not sent'); // no address in the log
  }
}

export async function adminIds() {
  const rows = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function notifyAdmins({ type, title, body, data }) {
  await notify(await adminIds(), { type, title, body, data });
}

/** The owner: in the app (if they have an account), by email, and by SMS when `sms` is set. */
export async function notifyOwner(l, { type, title, body, sms = false }) {
  const data = { toLetId: l.id };
  if (l.submitterId) await notify([l.submitterId], { type, title, body, data });
  const manage = l.submitterId ? `${env.APP_URL}/me/to-let` : `${env.APP_URL}/to-let/manage`;
  await mailText(l.contactEmail, `Vendors Hub To-Let: ${title}`, [`Hello ${l.contactName},`, '', body, '', `Your listing: ${manage}`]);
  if (sms) await sendPlainMessage({ userId: l.submitterId, phone: l.contactPhone, template: type, body: `Vendors Hub: ${title}. ${body}` });
}

/** An enquirer: in the app (if logged in), by email if given, else by SMS. */
export async function notifyRenter(inq, { type, title, body }) {
  const data = { toLetInquiryId: inq.id };
  if (inq.userId) await notify([inq.userId], { type, title, body, data });
  if (inq.email) await mailText(inq.email, `Vendors Hub To-Let: ${title}`, [`Hello ${inq.name},`, '', body]);
  else if (!inq.userId) await sendPlainMessage({ phone: inq.phone, template: type, body: `Vendors Hub: ${title}. ${body}` });
}

// ---------- threads ----------
export async function ownerThread(listingId, tx = prisma) {
  const found = await tx.toLetThread.findFirst({ where: { listingId, kind: 'OWNER' } });
  return found ?? tx.toLetThread.create({ data: { listingId, kind: 'OWNER' } });
}

export const presentMessage = (readerRole) => (m) => ({
  id: m.id,
  senderRole: m.senderRole,
  mine: m.senderRole === readerRole,
  body: m.body,
  createdAt: m.createdAt,
  readAt: m.readAt,
});
