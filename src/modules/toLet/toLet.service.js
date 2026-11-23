// Shop To-Let: the owner's side and the public side. The admin side is in toLet.admin.service.js.
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage } from '../../lib/storage.js';
import { detectFileType } from '../../lib/fileType.js';
import {
  TOLET_MAX_OPEN, TOLET_MAX_PHOTOS, TOLET_MAX_DOCUMENTS, TOLET_EMAIL_HOURS, TOLET_INQUIRIES_PER_DAY,
} from '../../config/limits.js';
import {
  NOT_FOUND, OPEN, EDITABLE, DAY_MS, newToken, hashToken, dayToDate, listingInclude, categoriesById,
  presentCard, presentPublic, presentOwner, ownerListing, audit, mailText, notifyAdmins, notifyOwner,
  ownerThread, presentMessage, titleOf,
} from './toLet.shared.js';

const PRIVATE_DIR = path.resolve(env.UPLOAD_DIR, 'private');
const DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const safeName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'document';

async function checkPlace({ marketId, suitableFor }) {
  if (marketId) {
    const m = await prisma.market.count({ where: { id: marketId } });
    if (!m) throw new AppError(404, 'Market not found');
  }
  if (suitableFor?.length) {
    const unique = [...new Set(suitableFor)];
    const n = await prisma.category.count({ where: { id: { in: unique } } });
    if (n !== unique.length) throw new AppError(400, 'Unknown category in suitableFor');
  }
}

// "open" for the limit: waiting, published, or a confirmation link that still works
const openWhere = (now) => ({
  OR: [{ status: { in: ['SUBMITTED', 'NEEDS_INFO', 'PUBLISHED'] } }, { status: 'PENDING_EMAIL', emailTokenExpiresAt: { gt: now } }],
});

async function sendConfirmLink(l, token) {
  await mailText(l.contactEmail, 'Confirm your Shop To-Let listing', [
    `Hello ${l.contactName},`,
    '',
    'Please confirm your email so we can review your Shop To-Let listing:',
    `${env.APP_URL}/to-let/confirm?token=${token}`,
    '',
    `The link works for ${TOLET_EMAIL_HOURS} hours. If you did not send this listing, ignore this email.`,
  ]);
}

async function announceSubmitted(l, again = false) {
  await notifyOwner(l, {
    type: 'TOLET_SUBMITTED',
    title: again ? 'Your changes were sent for review' : 'Your listing was received',
    body: 'Our team will review it and contact you if anything is missing.',
  });
  await notifyAdmins({
    type: 'TOLET_SUBMITTED',
    title: again ? 'A To-Let listing was changed' : 'A new To-Let listing to review',
    body: titleOf(l),
    data: { toLetId: l.id },
  });
}

// ---------- create / confirm ----------
export async function createToLet(user, input) {
  let contact = { name: input.contactName, phone: input.contactPhone, email: input.contactEmail };
  let account = null;
  if (user) {
    account = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, email: true, phone: true, emailVerifiedAt: true } });
    contact = { name: contact.name ?? account.name, phone: contact.phone ?? account.phone, email: contact.email ?? account.email };
  }
  if (!contact.name || !contact.phone || !contact.email) throw new AppError(400, 'Give your name, a Bangladesh mobile number and an email');
  await checkPlace(input);

  // a logged-in user with a verified email, using that same email, skips the confirmation
  const verified = Boolean(account?.emailVerifiedAt && account.email && account.email.toLowerCase() === contact.email.toLowerCase());
  const now = new Date();
  const token = verified ? null : newToken();

  const listing = await prisma.$transaction(async (tx) => {
    // the same phone or email from two tabs at once cannot pass the limit
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tolet:${contact.phone}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tolet:${contact.email}`}))`;
    const open = await tx.toLetListing.count({
      where: { AND: [{ OR: [{ contactPhone: contact.phone }, { contactEmail: contact.email }] }, openWhere(now)] },
    });
    if (open >= TOLET_MAX_OPEN) {
      throw new AppError(409, `At most ${TOLET_MAX_OPEN} open listings per phone number or email`, { code: 'TOLET_LIMIT' });
    }
    const l = await tx.toLetListing.create({
      data: {
        submitterId: user?.id ?? null,
        contactName: contact.name,
        contactPhone: contact.phone,
        contactEmail: contact.email,
        marketId: input.marketId ?? null,
        marketName: input.marketId ? null : input.marketName,
        levelFloor: input.levelFloor ?? null,
        shopNumber: input.shopNumber ?? null,
        addressLine: input.addressLine,
        sizeSqft: input.sizeSqft,
        monthlyRent: input.monthlyRent,
        advance: input.advance,
        availableFrom: dayToDate(input.availableFrom),
        suitableFor: [...new Set(input.suitableFor ?? [])],
        description: input.description,
        status: verified ? 'SUBMITTED' : 'PENDING_EMAIL',
        emailTokenHash: token ? hashToken(token) : null,
        emailTokenExpiresAt: token ? new Date(now.getTime() + TOLET_EMAIL_HOURS * 3600 * 1000) : null,
      },
      include: { ...listingInclude, documents: true },
    });
    await audit(user?.id, 'tolet.created', 'ToLetListing', l.id, { status: l.status, guest: !user }, tx);
    return l;
  });

  if (token) await sendConfirmLink(listing, token);
  else await announceSubmitted(listing);
  const view = presentOwner(listing, await categoriesById([listing]));
  return { ...view, emailConfirmationRequired: Boolean(token) };
}

// The email link: PENDING_EMAIL -> SUBMITTED. A guest then gets the private manage link by email.
export async function confirmEmail(token) {
  const now = new Date();
  const l = await prisma.toLetListing.findUnique({ where: { emailTokenHash: hashToken(token) } });
  if (!l || l.status !== 'PENDING_EMAIL' || !l.emailTokenExpiresAt || l.emailTokenExpiresAt <= now) {
    throw new AppError(400, 'This link is invalid or has expired');
  }
  const manage = l.submitterId ? null : newToken();
  const done = await prisma.toLetListing.updateMany({
    where: { id: l.id, status: 'PENDING_EMAIL', emailTokenHash: l.emailTokenHash },
    data: { status: 'SUBMITTED', emailTokenHash: null, emailTokenExpiresAt: null, ...(manage && { manageTokenHash: hashToken(manage) }) },
  });
  if (done.count !== 1) throw new AppError(400, 'This link is invalid or has expired');
  await audit(l.submitterId, 'tolet.email_confirmed', 'ToLetListing', l.id);
  if (manage) {
    await mailText(l.contactEmail, 'Your private link for your Shop To-Let listing', [
      `Hello ${l.contactName},`,
      '',
      'Thank you, your email is confirmed. Use this private link to add photos and documents, edit or withdraw your listing and talk to our team:',
      `${env.APP_URL}/to-let/manage?token=${manage}`,
      '',
      'Keep it private: anyone with this link can manage your listing.',
    ]);
  }
  await announceSubmitted(l);
  return { listingId: l.id, status: 'SUBMITTED' };
}

// ---------- the owner's views ----------
export async function listMine(userId) {
  const rows = await prisma.toLetListing.findMany({
    where: { submitterId: userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { ...listingInclude, documents: true },
  });
  const cats = await categoriesById(rows);
  return rows.map((l) => presentOwner(l, cats));
}

export async function getManaged(token) {
  const l = await prisma.toLetListing.findUnique({ where: { manageTokenHash: hashToken(token) }, include: { ...listingInclude, documents: true } });
  if (!l) throw new AppError(404, NOT_FOUND);
  return presentOwner(l, await categoriesById([l]));
}

const assertEditable = (l) => {
  if (!EDITABLE.includes(l.status)) throw new AppError(409, 'This listing can no longer be changed', { code: 'TOLET_CLOSED' });
};

// An edit to a published listing (or one waiting for information) goes back to the review queue.
const backToReview = (l) => (l.status === 'PUBLISHED' || l.status === 'NEEDS_INFO' ? { status: 'SUBMITTED' } : {});

export async function updateToLet(req, id, input) {
  const l = await ownerListing(req, id);
  assertEditable(l);
  await checkPlace(input);
  const marketId = input.marketId !== undefined ? input.marketId : l.marketId;
  const marketName = input.marketName !== undefined ? input.marketName : l.marketName;
  if (!marketId && !marketName) throw new AppError(400, 'Choose a market or type its name');
  const data = {
    ...input,
    ...(input.marketId && { marketName: null }),
    ...(input.availableFrom && { availableFrom: dayToDate(input.availableFrom) }),
    ...(input.suitableFor && { suitableFor: [...new Set(input.suitableFor)] }),
    ...backToReview(l),
  };
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.toLetListing.update({ where: { id }, data, include: { ...listingInclude, documents: true } });
    await audit(req.user?.id, 'tolet.updated', 'ToLetListing', id, { fields: Object.keys(input), from: l.status, to: u.status }, tx);
    return u;
  });
  if (l.status !== updated.status) await announceSubmitted(updated, true);
  return presentOwner(updated, await categoriesById([updated]));
}

export async function withdraw(req, id) {
  const l = await ownerListing(req, id);
  if (!OPEN.includes(l.status)) throw new AppError(409, 'This listing is already closed', { code: 'TOLET_CLOSED' });
  await prisma.$transaction(async (tx) => {
    const done = await tx.toLetListing.updateMany({ where: { id, status: l.status }, data: { status: 'WITHDRAWN' } });
    if (done.count !== 1) throw new AppError(409, 'This listing just changed. Refresh and try again.');
    await tx.toLetInquiry.updateMany({ where: { listingId: id, status: { not: 'CLOSED' } }, data: { status: 'CLOSED' } });
    await audit(req.user?.id, 'tolet.withdrawn', 'ToLetListing', id, { from: l.status }, tx);
  });
  return { id, status: 'WITHDRAWN' };
}

// ---------- photos (public, WebP pipeline) and documents (private, admin only) ----------
export async function addPhoto(req, id, file) {
  if (!file) throw new AppError(400, 'Send exactly one photo in the multipart field "image"');
  const l = await ownerListing(req, id);
  assertEditable(l);
  if (l.photos.length >= TOLET_MAX_PHOTOS) throw new AppError(409, `At most ${TOLET_MAX_PHOTOS} photos`, { code: 'TOLET_PHOTO_LIMIT' });
  const processed = await processImage(file.buffer, 'TOLET');
  const staged = await stageImage(processed);
  await staged.commit();
  try {
    const photo = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tolet-photos:${id}`}))`;
      const n = await tx.toLetPhoto.count({ where: { listingId: id } });
      if (n >= TOLET_MAX_PHOTOS) throw new AppError(409, `At most ${TOLET_MAX_PHOTOS} photos`, { code: 'TOLET_PHOTO_LIMIT' });
      const image = await tx.image.create({
        data: { key: staged.key, width: processed.width, height: processed.height, purpose: 'TOLET', ownerId: req.user?.id ?? null },
      });
      const p = await tx.toLetPhoto.create({ data: { listingId: id, imageId: image.id, sortOrder: n }, include: { image: true } });
      const back = backToReview(l);
      if (back.status) await tx.toLetListing.update({ where: { id }, data: back });
      await audit(req.user?.id, 'tolet.photo_added', 'ToLetListing', id, { photoId: p.id }, tx);
      return p;
    });
    if (backToReview(l).status) await announceSubmitted({ ...l, status: 'SUBMITTED' }, true);
    const view = presentPublic({ ...l, photos: [photo] }, new Map()).photos[0];
    return view;
  } catch (err) {
    await removeImage(staged.key).catch(() => {});
    throw err;
  }
}

export async function removePhoto(req, id, photoId) {
  const l = await ownerListing(req, id);
  const photo = l.photos.find((p) => p.id === photoId);
  if (!photo) throw new AppError(404, 'Photo not found');
  await prisma.$transaction([
    prisma.image.delete({ where: { id: photo.imageId } }), // cascades to the ToLetPhoto row
    audit(req.user?.id, 'tolet.photo_removed', 'ToLetListing', id, { photoId }),
  ]);
  await removeImage(photo.image.key).catch(() => {});
}

export async function addDocument(req, id, file) {
  if (!file) throw new AppError(400, 'Send exactly one file in the multipart field "file"');
  const l = await ownerListing(req, id);
  assertEditable(l);
  if (l.documents.length >= TOLET_MAX_DOCUMENTS) throw new AppError(409, `At most ${TOLET_MAX_DOCUMENTS} documents`, { code: 'TOLET_DOCUMENT_LIMIT' });
  const type = detectFileType(file.buffer);
  if (!type || !DOC_TYPES.includes(type.mime)) throw new AppError(400, 'Only PDF, JPG or PNG files are allowed');

  const storedName = `${crypto.randomUUID()}.${type.ext}`;
  const fullPath = path.join(PRIVATE_DIR, storedName);
  await mkdir(PRIVATE_DIR, { recursive: true });
  await writeFile(fullPath, file.buffer, { flag: 'wx' });
  try {
    const doc = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tolet-docs:${id}`}))`;
      const n = await tx.toLetDocument.count({ where: { listingId: id } });
      if (n >= TOLET_MAX_DOCUMENTS) throw new AppError(409, `At most ${TOLET_MAX_DOCUMENTS} documents`, { code: 'TOLET_DOCUMENT_LIMIT' });
      const d = await tx.toLetDocument.create({
        data: { listingId: id, storedName, mimeType: type.mime, size: file.size, originalName: safeName(file.originalname) },
      });
      await audit(req.user?.id, 'tolet.document_added', 'ToLetListing', id, { documentId: d.id }, tx);
      return d;
    });
    return { id: doc.id, mimeType: doc.mimeType, size: doc.size, originalName: doc.originalName, createdAt: doc.createdAt };
  } catch (err) {
    await unlink(fullPath).catch(() => {});
    throw err;
  }
}

export const documentPath = (storedName) => path.join(PRIVATE_DIR, storedName);

// ---------- the owner's thread (with the admin only) ----------
export async function ownerMessages(req, id) {
  const l = await ownerListing(req, id);
  const thread = await ownerThread(l.id);
  const rows = await prisma.toLetMessage.findMany({ where: { threadId: thread.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 });
  await prisma.toLetMessage.updateMany({ where: { threadId: thread.id, senderRole: 'ADMIN', readAt: null }, data: { readAt: new Date() } });
  return { messages: rows.map(presentMessage('OWNER')) };
}

export async function ownerSend(req, id, body) {
  const l = await ownerListing(req, id);
  if (l.status === 'WITHDRAWN') throw new AppError(409, 'This listing was withdrawn', { code: 'TOLET_CLOSED' });
  const thread = await ownerThread(l.id);
  const m = await prisma.toLetMessage.create({ data: { threadId: thread.id, senderRole: 'OWNER', senderUserId: req.user?.id ?? null, body } });
  await notifyAdmins({ type: 'TOLET_MESSAGE', title: 'New message from a To-Let owner', body: titleOf(l), data: { toLetId: l.id } });
  return presentMessage('OWNER')(m);
}

// ---------- public ----------
const liveWhere = (now) => ({ status: 'PUBLISHED', expiresAt: { gt: now } });

const SORTS = {
  newest: [{ publishedAt: 'desc' }, { id: 'asc' }],
  rent_asc: [{ monthlyRent: 'asc' }, { id: 'asc' }],
  rent_desc: [{ monthlyRent: 'desc' }, { id: 'asc' }],
};

export async function listPublic({ marketId, minRent, maxRent, minSize, maxSize, q, sort, page, limit }) {
  const now = new Date();
  const where = {
    AND: [
      liveWhere(now),
      ...(marketId ? [{ marketId }] : []),
      ...(minRent !== undefined || maxRent !== undefined ? [{ monthlyRent: { gte: minRent, lte: maxRent } }] : []),
      ...(minSize !== undefined || maxSize !== undefined ? [{ sizeSqft: { gte: minSize, lte: maxSize } }] : []),
      ...(q
        ? [{
            OR: [
              { description: { contains: q, mode: 'insensitive' } },
              { addressLine: { contains: q, mode: 'insensitive' } },
              { marketName: { contains: q, mode: 'insensitive' } },
              { levelFloor: { contains: q, mode: 'insensitive' } },
              { market: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }]
        : []),
    ],
  };
  const [total, rows] = await Promise.all([
    prisma.toLetListing.count({ where }),
    prisma.toLetListing.findMany({ where, orderBy: SORTS[sort], skip: (page - 1) * limit, take: limit, include: listingInclude }),
  ]);
  return { items: rows.map(presentCard), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getPublic(slug) {
  const l = await prisma.toLetListing.findFirst({ where: { slug, ...liveWhere(new Date()) }, include: listingInclude });
  if (!l) throw new AppError(404, NOT_FOUND);
  return presentPublic(l, await categoriesById([l]));
}

// ---------- enquiries ----------
export async function createInquiry(user, listingId, input) {
  const now = new Date();
  const l = await prisma.toLetListing.findFirst({ where: { id: listingId, ...liveWhere(now) } });
  if (!l) throw new AppError(404, NOT_FOUND);
  const token = user ? null : newToken();

  const inq = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tolet-inquiry:${input.phone}`}))`;
    const today = await tx.toLetInquiry.count({ where: { phone: input.phone, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } });
    if (today >= TOLET_INQUIRIES_PER_DAY) {
      throw new AppError(429, `At most ${TOLET_INQUIRIES_PER_DAY} enquiries per phone number per day`, { code: 'INQUIRY_LIMIT' });
    }
    const open = await tx.toLetInquiry.count({ where: { listingId, phone: input.phone, status: { not: 'CLOSED' } } });
    if (open) throw new AppError(409, 'You already have an open enquiry for this shop', { code: 'INQUIRY_EXISTS' });
    const i = await tx.toLetInquiry.create({
      data: {
        listingId,
        userId: user?.id ?? null,
        name: input.name,
        phone: input.phone,
        email: input.email ?? null,
        message: input.message,
        followTokenHash: token ? hashToken(token) : null,
      },
    });
    const thread = await tx.toLetThread.create({ data: { listingId, kind: 'INQUIRY', inquiryId: i.id } });
    await tx.toLetMessage.create({ data: { threadId: thread.id, senderRole: 'RENTER', senderUserId: user?.id ?? null, body: input.message } });
    await audit(user?.id, 'tolet.inquiry_created', 'ToLetInquiry', i.id, { listingId, guest: !user }, tx);
    return i;
  });
  await notifyAdmins({ type: 'TOLET_INQUIRY', title: 'New enquiry for a To-Let listing', body: titleOf(l), data: { toLetId: l.id, toLetInquiryId: inq.id } });
  // the follow token is shown ONCE (only its hash is stored)
  return { inquiryId: inq.id, status: inq.status, createdAt: inq.createdAt, ...(token && { followToken: token }) };
}

// The enquirer: logged in as its author, or a guest with the follow token (?token= or X-Follow-Token).
async function ownInquiry(req, id, queryToken) {
  const inq = await prisma.toLetInquiry.findUnique({ where: { id }, include: { thread: true } });
  if (!inq) throw new AppError(404, 'Enquiry not found');
  const token = queryToken ?? req.get('x-follow-token');
  const byLogin = Boolean(req.user && inq.userId && inq.userId === req.user.id);
  const byToken = Boolean(token && /^[a-f0-9]{64}$/.test(token) && inq.followTokenHash && hashToken(token) === inq.followTokenHash);
  if (!byLogin && !byToken) throw new AppError(404, 'Enquiry not found');
  return inq;
}

export async function inquiryMessages(req, id, token) {
  const inq = await ownInquiry(req, id, token);
  const rows = await prisma.toLetMessage.findMany({ where: { threadId: inq.thread.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 });
  await prisma.toLetMessage.updateMany({ where: { threadId: inq.thread.id, senderRole: 'ADMIN', readAt: null }, data: { readAt: new Date() } });
  return { inquiryId: inq.id, status: inq.status, messages: rows.map(presentMessage('RENTER')) };
}

export async function inquirySend(req, id, token, body) {
  const inq = await ownInquiry(req, id, token);
  if (inq.status === 'CLOSED') throw new AppError(409, 'This enquiry is closed', { code: 'INQUIRY_CLOSED' });
  const m = await prisma.toLetMessage.create({ data: { threadId: inq.thread.id, senderRole: 'RENTER', senderUserId: req.user?.id ?? null, body } });
  await notifyAdmins({ type: 'TOLET_MESSAGE', title: 'New message from a To-Let enquirer', body: 'Open the enquiry to reply.', data: { toLetId: inq.listingId, toLetInquiryId: inq.id } });
  return presentMessage('RENTER')(m);
}

export { notifyOwner };
