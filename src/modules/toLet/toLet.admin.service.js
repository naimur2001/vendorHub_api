// Shop To-Let: the admin side (the middleman). ADMIN only; every call is written to the audit log.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { uniqueSlug } from '../../lib/slug.js';
import { maskPhone, sendPlainMessage } from '../../lib/messaging.js';
import { env } from '../../config/env.js';
import { TOLET_PUBLISH_DAYS } from '../../config/limits.js';
import {
  NOT_FOUND, DAY_MS, listingInclude, categoriesById, presentOwner, audit, notifyOwner, notifyRenter,
  ownerThread, presentMessage, titleOf,
} from './toLet.shared.js';
import { documentPath } from './toLet.service.js';

const STATUSES = ['PENDING_EMAIL', 'SUBMITTED', 'NEEDS_INFO', 'PUBLISHED', 'RENTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'];
const LISTING = 'ToLetListing';
const INQUIRY = 'ToLetInquiry';

async function findListing(id, include = {}) {
  const l = await prisma.toLetListing.findUnique({ where: { id }, include: { ...listingInclude, documents: true, ...include } });
  if (!l) throw new AppError(404, NOT_FOUND);
  return l;
}

// Moves a listing from one of `from` to `to` with a guarded update (two admins at once: one wins).
async function move(admin, l, from, data, action, meta) {
  if (!from.includes(l.status)) {
    throw new AppError(409, `A listing that is ${l.status} cannot do this`, { code: 'TOLET_WRONG_STATUS' });
  }
  await prisma.$transaction(async (tx) => {
    const done = await tx.toLetListing.updateMany({ where: { id: l.id, status: l.status }, data });
    if (done.count !== 1) throw new AppError(409, 'This listing just changed. Refresh and try again.');
    await audit(admin.id, action, LISTING, l.id, { from: l.status, to: data.status ?? l.status, ...meta }, tx);
  });
}

// ---------- list / detail ----------
export async function listAdmin(admin, { status, page, limit }) {
  const where = status ? { status } : {};
  const [total, rows, groups] = await Promise.all([
    prisma.toLetListing.count({ where }),
    prisma.toLetListing.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: { market: { select: { id: true, name: true, slug: true } }, _count: { select: { photos: true, documents: true, inquiries: true } } },
    }),
    prisma.toLetListing.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const g of groups) counts[g.status] = g._count._all;
  await audit(admin.id, 'tolet.list_viewed', LISTING, 'list', { status: status ?? null });
  return {
    items: rows.map((l) => ({
      id: l.id,
      slug: l.slug,
      title: titleOf(l),
      status: l.status,
      market: l.market,
      marketName: l.market?.name ?? l.marketName,
      monthlyRent: l.monthlyRent,
      sizeSqft: l.sizeSqft,
      contactName: l.contactName,
      contactPhone: l.contactPhone,
      guest: !l.submitterId,
      photoCount: l._count.photos,
      documentCount: l._count.documents,
      inquiryCount: l._count.inquiries,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      publishedAt: l.publishedAt,
      expiresAt: l.expiresAt,
    })),
    counts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

const presentInquiry = (i) => ({
  id: i.id,
  name: i.name,
  phone: i.phone,
  email: i.email,
  message: i.message,
  status: i.status,
  guest: !i.userId,
  contactsSharedAt: i.contactsSharedAt,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  messages: (i.thread?.messages ?? []).map(presentMessage('ADMIN')),
});

export async function getAdmin(admin, id) {
  const messages = { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] };
  const l = await findListing(id, {
    submitter: { select: { id: true, name: true, email: true, phone: true } },
    threads: { where: { kind: 'OWNER' }, include: { messages } },
    inquiries: { orderBy: { createdAt: 'desc' }, include: { thread: { include: { messages } } } },
    notes: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true } } } },
  });
  // the admin has now seen the owner's and the enquirers' messages
  const threadIds = [...l.threads.map((t) => t.id), ...l.inquiries.map((i) => i.thread?.id).filter(Boolean)];
  if (threadIds.length) {
    await prisma.toLetMessage.updateMany({ where: { threadId: { in: threadIds }, senderRole: { not: 'ADMIN' }, readAt: null }, data: { readAt: new Date() } });
  }
  await audit(admin.id, 'tolet.viewed', LISTING, id);
  return {
    ...presentOwner(l, await categoriesById([l])),
    submitter: l.submitter ?? null,
    guest: !l.submitterId,
    publishedAt: l.publishedAt,
    expiresAt: l.expiresAt,
    documents: l.documents.map((d) => ({
      id: d.id,
      mimeType: d.mimeType,
      size: d.size,
      originalName: d.originalName,
      createdAt: d.createdAt,
      url: `${env.PUBLIC_API_URL}/api/v1/admin/to-let/${l.id}/documents/${d.id}`,
    })),
    ownerThread: { messages: (l.threads[0]?.messages ?? []).map(presentMessage('ADMIN')) },
    inquiries: l.inquiries.map(presentInquiry),
    notes: l.notes.map((n) => ({ id: n.id, body: n.body, author: n.author, createdAt: n.createdAt })),
  };
}

export async function getDocument(admin, id, docId) {
  const d = await prisma.toLetDocument.findFirst({ where: { id: docId, listingId: id } });
  if (!d) throw new AppError(404, 'Document not found');
  await audit(admin.id, 'tolet.document_viewed', LISTING, id, { documentId: d.id });
  return { fullPath: documentPath(d.storedName), mimeType: d.mimeType };
}

// ---------- decisions ----------
const reload = (id) => getAdminQuiet(id);
async function getAdminQuiet(id) {
  const l = await findListing(id);
  return { ...presentOwner(l, await categoriesById([l])), publishedAt: l.publishedAt, expiresAt: l.expiresAt };
}

export async function publish(admin, id) {
  const l = await findListing(id);
  const now = new Date();
  const slug = l.slug ?? (await uniqueSlug('toLetListing', `${l.market?.name ?? l.marketName ?? 'shop'} ${l.levelFloor ?? ''} shop to let ${l.id.slice(0, 6)}`));
  await move(admin, l, ['SUBMITTED', 'NEEDS_INFO'], {
    status: 'PUBLISHED', slug, publishedAt: now, expiresAt: new Date(now.getTime() + TOLET_PUBLISH_DAYS * DAY_MS), expiryRemindedAt: null, rejectReason: null,
  }, 'tolet.published');
  await notifyOwner(l, { type: 'TOLET_PUBLISHED', title: 'Your listing is live', body: `It is shown for ${TOLET_PUBLISH_DAYS} days. We will pass on serious enquiries.`, sms: true });
  return reload(id);
}

export async function requestInfo(admin, id, message) {
  const l = await findListing(id);
  await move(admin, l, ['SUBMITTED', 'PUBLISHED'], { status: 'NEEDS_INFO' }, 'tolet.info_requested');
  const thread = await ownerThread(id);
  await prisma.toLetMessage.create({ data: { threadId: thread.id, senderRole: 'ADMIN', senderUserId: admin.id, body: message } });
  await notifyOwner(l, { type: 'TOLET_INFO_REQUESTED', title: 'We need more information', body: 'Please open your listing and reply to our message.', sms: true });
  return reload(id);
}

export async function reject(admin, id, reason) {
  const l = await findListing(id);
  await move(admin, l, ['PENDING_EMAIL', 'SUBMITTED', 'NEEDS_INFO', 'PUBLISHED'], { status: 'REJECTED', rejectReason: reason }, 'tolet.rejected', { reason });
  await prisma.toLetInquiry.updateMany({ where: { listingId: id, status: { not: 'CLOSED' } }, data: { status: 'CLOSED' } });
  await notifyOwner(l, { type: 'TOLET_REJECTED', title: 'Your listing was not accepted', body: `Reason: ${reason}`, sms: true });
  return reload(id);
}

export async function markRented(admin, id) {
  const l = await findListing(id);
  await move(admin, l, ['PUBLISHED', 'EXPIRED'], { status: 'RENTED' }, 'tolet.rented');
  await prisma.toLetInquiry.updateMany({ where: { listingId: id, status: { not: 'CLOSED' } }, data: { status: 'CLOSED' } });
  await notifyOwner(l, { type: 'TOLET_RENTED', title: 'Your listing is marked as rented', body: 'Thank you for using Vendors Hub To-Let.' });
  return reload(id);
}

export async function renew(admin, id) {
  const l = await findListing(id);
  const now = new Date();
  const fromTime = Math.max(now.getTime(), l.expiresAt?.getTime() ?? 0);
  await move(admin, l, ['PUBLISHED', 'EXPIRED'], {
    status: 'PUBLISHED', expiresAt: new Date(fromTime + TOLET_PUBLISH_DAYS * DAY_MS), expiryRemindedAt: null,
  }, 'tolet.renewed');
  await notifyOwner(l, { type: 'TOLET_PUBLISHED', title: 'Your listing was renewed', body: `It is shown for ${TOLET_PUBLISH_DAYS} more days.` });
  return reload(id);
}

export async function addNote(admin, id, body) {
  await findListing(id);
  const n = await prisma.$transaction(async (tx) => {
    const note = await tx.toLetNote.create({ data: { listingId: id, authorId: admin.id, body }, include: { author: { select: { id: true, name: true } } } });
    await audit(admin.id, 'tolet.note_added', LISTING, id, { noteId: note.id, length: body.length }, tx);
    return note;
  });
  return { id: n.id, body: n.body, author: n.author, createdAt: n.createdAt };
}

// ---------- replies ----------
export async function replyOwner(admin, id, body) {
  const l = await findListing(id);
  const thread = await ownerThread(id);
  const m = await prisma.toLetMessage.create({ data: { threadId: thread.id, senderRole: 'ADMIN', senderUserId: admin.id, body } });
  await audit(admin.id, 'tolet.owner_messaged', LISTING, id, { messageId: m.id });
  await notifyOwner(l, { type: 'TOLET_MESSAGE', title: 'New message from Vendors Hub', body: 'Open your listing to read it.' });
  return presentMessage('ADMIN')(m);
}

async function findInquiry(id) {
  const i = await prisma.toLetInquiry.findUnique({ where: { id }, include: { thread: true, listing: true } });
  if (!i) throw new AppError(404, 'Enquiry not found');
  return i;
}

export async function replyInquiry(admin, id, body) {
  const i = await findInquiry(id);
  if (i.status === 'CLOSED') throw new AppError(409, 'This enquiry is closed', { code: 'INQUIRY_CLOSED' });
  const thread = i.thread ?? (await prisma.toLetThread.create({ data: { listingId: i.listingId, kind: 'INQUIRY', inquiryId: i.id } }));
  const m = await prisma.$transaction(async (tx) => {
    const msg = await tx.toLetMessage.create({ data: { threadId: thread.id, senderRole: 'ADMIN', senderUserId: admin.id, body } });
    if (i.status === 'NEW') await tx.toLetInquiry.update({ where: { id }, data: { status: 'IN_TALKS' } }); // first answer
    await audit(admin.id, 'tolet.inquiry_messaged', INQUIRY, id, { messageId: msg.id }, tx);
    return msg;
  });
  await notifyRenter(i, { type: 'TOLET_MESSAGE', title: 'New message about the shop you asked about', body: 'Open your enquiry to read it.' });
  return presentMessage('ADMIN')(m);
}

export async function setInquiryStatus(admin, id, status) {
  const i = await findInquiry(id);
  await prisma.$transaction([
    prisma.toLetInquiry.update({ where: { id }, data: { status } }),
    audit(admin.id, 'tolet.inquiry_status', INQUIRY, id, { from: i.status, to: status }),
  ]);
  return { id, status };
}

// Only on the admin's click: each side gets the other's name and phone by SMS (messaging adapter).
// The message log keeps the numbers masked.
export async function shareContacts(admin, id) {
  const i = await findInquiry(id);
  if (i.status === 'CLOSED') throw new AppError(409, 'This enquiry is closed', { code: 'INQUIRY_CLOSED' });
  if (i.listing.status !== 'PUBLISHED') throw new AppError(409, 'The listing is not published', { code: 'TOLET_WRONG_STATUS' });
  const l = i.listing;
  const toRenter = (phone) => `Vendors Hub To-Let: you can now contact the owner of the shop you asked about. ${l.contactName}, ${phone}.`;
  const toOwner = (phone) => `Vendors Hub To-Let: someone is interested in your shop. ${i.name}, ${phone}${i.email ? `, ${i.email}` : ''}.`;
  await sendPlainMessage({ userId: i.userId, phone: i.phone, template: 'TOLET_CONTACT_SHARED', body: toRenter(l.contactPhone), logBody: toRenter(maskPhone(l.contactPhone)) });
  await sendPlainMessage({ userId: l.submitterId, phone: l.contactPhone, template: 'TOLET_CONTACT_SHARED', body: toOwner(i.phone), logBody: toOwner(maskPhone(i.phone)).replace(i.email ?? '\u0000', '***') });
  const now = new Date();
  await prisma.$transaction([
    prisma.toLetInquiry.update({ where: { id }, data: { status: 'CONNECTED', contactsSharedAt: now } }),
    audit(admin.id, 'tolet.contacts_shared', INQUIRY, id, { listingId: l.id }),
  ]);
  return { id, status: 'CONNECTED', contactsSharedAt: now, sentTo: ['RENTER', 'OWNER'] };
}
