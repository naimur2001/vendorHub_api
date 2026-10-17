import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { assertShopAccess } from '../../lib/shopAccess.js';

const LEVELS = [
  'UNVERIFIED',
  'DOCUMENTS_VERIFIED',
  'BUSINESS_VERIFIED',
  'PHYSICAL_SHOP_VERIFIED',
  'TRUSTED_VENDOR',
];
const OPEN_FOR_ADMIN = ['PENDING', 'AUTO_FLAGGED']; // waiting for an admin decision
const OPEN = [...OPEN_FOR_ADMIN, 'CORRECTION_REQUESTED']; // not finished yet
const FLAG_BELOW = 60; // pre-check scores under this are auto-flagged

const REQUIRED_DOCS = {
  DOCUMENTS_VERIFIED: ['TRADE_LICENSE', 'NID'],
  BUSINESS_VERIFIED: ['TRADE_LICENSE', 'NID'],
  PHYSICAL_SHOP_VERIFIED: ['TRADE_LICENSE', 'NID', 'SHOP_PHOTO'],
  TRUSTED_VENDOR: ['TRADE_LICENSE', 'NID', 'SHOP_PHOTO'],
};

const levelIndex = (level) => LEVELS.indexOf(level);
const nextLevel = (level) => LEVELS[levelIndex(level) + 1] ?? null;

// PLACEHOLDER for real OCR, face-match and geolocation services: a simple, explainable score.
// Replace the body later; callers only need { score, details }.
function runPrecheck(shop, docs) {
  const has = (type) => docs.some((d) => d.type === type);
  const details = {
    tradeLicenseOcr: has('TRADE_LICENSE'),
    nidUploaded: has('NID'),
    nidFaceMatch: has('NID') ? 'pending' : 'missing',
    shopPhotoUploaded: has('SHOP_PHOTO'),
    addressGeoMatch: shop.latitude !== null && shop.longitude !== null,
    marketLinked: shop.marketId !== null,
  };
  const score =
    (details.tradeLicenseOcr ? 30 : 0) +
    (details.nidUploaded ? 25 : 0) +
    (details.shopPhotoUploaded ? 20 : 0) +
    (details.addressGeoMatch ? 15 : 0) +
    (details.marketLinked ? 10 : 0);
  return { score, details };
}

const scoreBand = (score) => {
  if (score === null || score === undefined) return null;
  if (score >= 85) return 'GREEN';
  if (score >= 60) return 'AMBER';
  return 'RED';
};

const audit = (tx, actorId, action, entityType, entityId, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType, entityId, meta } });

const verificationInclude = {
  shop: {
    select: {
      id: true,
      ownerId: true,
      name: true,
      slug: true,
      addressLine: true,
      levelFloor: true,
      shopNumber: true,
      latitude: true,
      longitude: true,
      marketId: true,
      verificationLevel: true,
      lastAuditedAt: true,
      market: { select: { name: true } },
      owner: { select: { name: true, email: true } },
    },
  },
  documents: { orderBy: { type: 'asc' } },
};

async function loadVerification(id) {
  const v = await prisma.shopVerification.findUnique({ where: { id }, include: verificationInclude });
  if (!v) throw new AppError(404, 'Verification request not found');
  return v;
}

const docsOut = (docs) =>
  docs.map((d) => ({
    id: d.id,
    type: d.type,
    fileUrl: d.fileUrl,
    needsReupload: d.needsReupload,
    reviewed: Boolean(d.reviewedAt),
  }));

// Which admin buttons make sense for this row (mirrors the disabled states in the Figma table).
function actionsFor(v) {
  const allReviewed = v.documents.length > 0 && v.documents.every((d) => d.reviewedAt);
  const anyFlagged = v.documents.some((d) => d.needsReupload);
  return {
    approve: OPEN_FOR_ADMIN.includes(v.status) && allReviewed && !anyFlagged,
    requestCorrection: OPEN_FOR_ADMIN.includes(v.status),
    reject: OPEN.includes(v.status),
    revoke: v.status === 'APPROVED' && v.shop.verificationLevel !== 'UNVERIFIED',
  };
}

function adminRow(v) {
  return {
    id: v.id,
    status: v.status,
    targetLevel: v.targetLevel,
    currentLevel: v.shop.verificationLevel,
    submittedAt: v.submittedAt,
    reviewedAt: v.reviewedAt,
    shop: { id: v.shop.id, name: v.shop.name, slug: v.shop.slug, addressLine: v.shop.addressLine },
    documents: docsOut(v.documents),
    precheckScore: v.precheckScore,
    scoreBand: scoreBand(v.precheckScore),
    actions: actionsFor(v),
  };
}

// Node states for the Figma stepper component.
function stepper(v) {
  const current = levelIndex(v.shop.verificationLevel);
  const target = levelIndex(v.targetLevel);
  return LEVELS.map((level, i) => {
    let state = 'upcoming';
    if (i <= current) state = 'completed';
    else if (i === target && OPEN.includes(v.status)) state = 'current';
    else if (i === target && ['REJECTED', 'REVOKED'].includes(v.status)) state = 'rejected';
    return { level, state };
  });
}

const ownerRow = (v, message = null) => ({
  id: v.id,
  shopId: v.shopId,
  targetLevel: v.targetLevel,
  status: v.status,
  submittedAt: v.submittedAt,
  reviewedAt: v.reviewedAt,
  documents: docsOut(v.documents),
  message,
});

function assertNoDuplicateTypes(documents) {
  const types = documents.map((d) => d.type);
  const duplicate = types.find((t, i) => t !== 'OTHER' && types.indexOf(t) !== i);
  if (duplicate) throw new AppError(400, `Send only one ${duplicate} document`);
}

function assertDocuments(documents, targetLevel) {
  assertNoDuplicateTypes(documents);
  const types = documents.map((d) => d.type);
  const missing = REQUIRED_DOCS[targetLevel].filter((t) => !types.includes(t));
  if (missing.length) throw new AppError(400, `Missing required documents: ${missing.join(', ')}`);
}

// ---------- shop owner ----------

export async function submitVerification(user, shopId, { targetLevel, documents }) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (user.role !== 'ADMIN' && shop.ownerId !== user.id) {
    throw new AppError(403, 'Only the shop owner can request verification');
  }

  const expected = nextLevel(shop.verificationLevel);
  if (!expected) throw new AppError(409, 'This shop already has the highest verification level');
  if (targetLevel !== expected) throw new AppError(400, `The next level for this shop is ${expected}`);

  assertDocuments(documents, targetLevel);

  const open = await prisma.shopVerification.findFirst({
    where: { shopId, status: { in: OPEN } },
    select: { id: true },
  });
  if (open) {
    throw new AppError(409, 'This shop already has a verification request in progress', {
      verificationId: open.id,
    });
  }

  const { score, details } = runPrecheck(shop, documents);
  const created = await prisma.$transaction(async (tx) => {
    const v = await tx.shopVerification.create({
      data: {
        shopId,
        targetLevel,
        status: score < FLAG_BELOW ? 'AUTO_FLAGGED' : 'PENDING',
        precheckScore: score,
        precheckDetails: details,
        documents: { create: documents.map(({ type, fileUrl }) => ({ type, fileUrl })) },
      },
    });
    await audit(tx, user.id, 'verification.submitted', 'ShopVerification', v.id, {
      shopId,
      targetLevel,
      score,
    });
    return v;
  });
  return ownerRow(await loadVerification(created.id));
}

// What the owner sees: status, documents, and the admin's note or rejection reason. Never the score or internal notes.
export async function listForShop(user, shopId) {
  await assertShopAccess(user, shopId);
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { verificationLevel: true },
  });
  const rows = await prisma.shopVerification.findMany({
    where: { shopId },
    include: { documents: { orderBy: { type: 'asc' } } },
    orderBy: { submittedAt: 'desc' },
  });
  const logs = rows.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: 'ShopVerification',
          entityId: { in: rows.map((r) => r.id) },
          action: { in: ['verification.correction_requested', 'verification.rejected'] },
        },
        orderBy: { createdAt: 'desc' },
      })
    : [];
  const messageFor = (v) => {
    if (!['CORRECTION_REQUESTED', 'REJECTED'].includes(v.status)) return null;
    const log = logs.find((l) => l.entityId === v.id);
    return log ? (log.meta?.note ?? log.meta?.reason ?? null) : null;
  };

  const next = nextLevel(shop.verificationLevel);
  return {
    currentLevel: shop.verificationLevel,
    nextLevel: next,
    requiredDocuments: next ? REQUIRED_DOCS[next] : [],
    requests: rows.map((v) => ownerRow(v, messageFor(v))),
  };
}

export async function resubmit(user, id, documents) {
  const v = await loadVerification(id);
  if (user.role !== 'ADMIN' && v.shop.ownerId !== user.id) {
    throw new AppError(404, 'Verification request not found');
  }
  if (v.status !== 'CORRECTION_REQUESTED') {
    throw new AppError(409, 'This request is not waiting for corrected documents');
  }
  assertNoDuplicateTypes(documents);

  const flagged = v.documents.filter((d) => d.needsReupload).map((d) => d.type);
  const provided = documents.map((d) => d.type);
  const missing = flagged.filter((t) => !provided.includes(t));
  if (missing.length) {
    throw new AppError(400, `Upload new files for: ${[...new Set(missing)].join(', ')}`);
  }

  await prisma.$transaction(async (tx) => {
    // replace the old file of each re-sent type (for OTHER, only the flagged ones)
    for (const type of new Set(provided)) {
      await tx.verificationDocument.deleteMany({
        where: { verificationId: id, type, ...(type === 'OTHER' && { needsReupload: true }) },
      });
    }
    await tx.verificationDocument.createMany({
      data: documents.map(({ type, fileUrl }) => ({ verificationId: id, type, fileUrl })),
    });

    const all = await tx.verificationDocument.findMany({ where: { verificationId: id } });
    const { score, details } = runPrecheck(v.shop, all);
    const changed = await tx.shopVerification.updateMany({
      where: { id, status: 'CORRECTION_REQUESTED' },
      data: {
        status: score < FLAG_BELOW ? 'AUTO_FLAGGED' : 'PENDING',
        precheckScore: score,
        precheckDetails: details,
      },
    });
    if (changed.count !== 1) {
      throw new AppError(409, 'This request just changed. Refresh and try again.');
    }
    await audit(tx, user.id, 'verification.resubmitted', 'ShopVerification', id, { score });
  });
  return ownerRow(await loadVerification(id));
}

// ---------- admin ----------

export async function adminList({ status, q, from, to, page, limit }) {
  const statusFilter =
    status === 'ALL' ? {} : status === 'OPEN' ? { status: { in: OPEN_FOR_ADMIN } } : { status };
  const where = {
    ...statusFilter,
    ...(q && { shop: { name: { contains: q, mode: 'insensitive' } } }),
    ...((from || to) && {
      submittedAt: { ...(from && { gte: from }), ...(to && { lte: to }) },
    }),
  };
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [total, rows, pendingReview, autoFlagged, approvedThisWeek] = await Promise.all([
    prisma.shopVerification.count({ where }),
    prisma.shopVerification.findMany({
      where,
      include: verificationInclude,
      orderBy: { submittedAt: 'asc' }, // oldest first: the queue
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.shopVerification.count({ where: { status: 'PENDING' } }),
    prisma.shopVerification.count({ where: { status: 'AUTO_FLAGGED' } }),
    prisma.shopVerification.count({ where: { status: 'APPROVED', reviewedAt: { gte: weekAgo } } }),
  ]);

  return {
    items: rows.map(adminRow),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    stats: { pendingReview, autoFlagged, approvedThisWeek },
  };
}

export async function getForAdmin(id) {
  const v = await loadVerification(id);
  const history = await prisma.auditLog.findMany({
    where: { entityType: 'ShopVerification', entityId: id },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { name: true } } },
  });
  return {
    ...adminRow(v),
    internalNotes: v.adminNotes,
    precheck: { score: v.precheckScore, band: scoreBand(v.precheckScore), details: v.precheckDetails },
    stepper: stepper(v),
    shopDetails: {
      levelFloor: v.shop.levelFloor,
      shopNumber: v.shop.shopNumber,
      market: v.shop.market?.name ?? null,
      lastAuditedAt: v.shop.lastAuditedAt,
    },
    owner: v.shop.owner,
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      meta: h.meta,
      createdAt: h.createdAt,
      actor: h.actor?.name ?? null,
    })),
  };
}

export async function setNotes(id, notes) {
  await loadVerification(id);
  await prisma.shopVerification.update({ where: { id }, data: { adminNotes: notes } });
  return { internalNotes: notes };
}

export async function reviewDocument(id, docId, reviewed) {
  const v = await loadVerification(id);
  if (!OPEN_FOR_ADMIN.includes(v.status)) {
    throw new AppError(409, 'This request is not waiting for a decision');
  }
  if (!v.documents.some((d) => d.id === docId)) throw new AppError(404, 'Document not found');
  await prisma.verificationDocument.update({
    where: { id: docId },
    data: { reviewedAt: reviewed ? new Date() : null },
  });
  return getForAdmin(id);
}

export async function approve(admin, id) {
  const v = await loadVerification(id);
  if (!OPEN_FOR_ADMIN.includes(v.status)) {
    throw new AppError(409, 'This request is not waiting for a decision');
  }
  if (v.documents.some((d) => !d.reviewedAt)) throw new AppError(409, 'Review all documents first');
  if (v.documents.some((d) => d.needsReupload)) {
    throw new AppError(409, 'Some documents are flagged for re-upload');
  }
  if (nextLevel(v.shop.verificationLevel) !== v.targetLevel) {
    throw new AppError(409, 'The shop level changed since this request was submitted');
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.shopVerification.updateMany({
      where: { id, status: { in: OPEN_FOR_ADMIN } },
      data: { status: 'APPROVED', reviewedById: admin.id, reviewedAt: new Date() },
    });
    if (changed.count !== 1) throw new AppError(409, 'This request was just handled by someone else');

    const physicalOrHigher = levelIndex(v.targetLevel) >= levelIndex('PHYSICAL_SHOP_VERIFIED');
    await tx.shop.update({
      where: { id: v.shopId },
      data: { verificationLevel: v.targetLevel, ...(physicalOrHigher && { lastAuditedAt: new Date() }) },
    });
    await audit(tx, admin.id, 'verification.approved', 'ShopVerification', id, {
      shopId: v.shopId,
      level: v.targetLevel,
    });
  });
  return getForAdmin(id);
}

export async function requestCorrection(admin, id, { note, documentIds }) {
  const v = await loadVerification(id);
  if (!OPEN_FOR_ADMIN.includes(v.status)) {
    throw new AppError(409, 'This request is not waiting for a decision');
  }
  const wanted = [...new Set(documentIds)];
  const valid = v.documents.filter((d) => wanted.includes(d.id));
  if (valid.length !== wanted.length) {
    throw new AppError(400, 'Some documents do not belong to this request');
  }

  await prisma.$transaction(async (tx) => {
    const changed = await tx.shopVerification.updateMany({
      where: { id, status: { in: OPEN_FOR_ADMIN } },
      data: { status: 'CORRECTION_REQUESTED', reviewedById: admin.id, reviewedAt: new Date() },
    });
    if (changed.count !== 1) throw new AppError(409, 'This request was just handled by someone else');
    await tx.verificationDocument.updateMany({
      where: { id: { in: wanted } },
      data: { needsReupload: true },
    });
    await audit(tx, admin.id, 'verification.correction_requested', 'ShopVerification', id, {
      note,
      documentIds: wanted,
    });
  });
  return getForAdmin(id);
}

export async function reject(admin, id, reason) {
  const v = await loadVerification(id);
  if (!OPEN.includes(v.status)) throw new AppError(409, 'This request is already closed');

  await prisma.$transaction(async (tx) => {
    const changed = await tx.shopVerification.updateMany({
      where: { id, status: { in: OPEN } },
      data: { status: 'REJECTED', reviewedById: admin.id, reviewedAt: new Date() },
    });
    if (changed.count !== 1) throw new AppError(409, 'This request was just handled by someone else');
    await audit(tx, admin.id, 'verification.rejected', 'ShopVerification', id, { reason });
  });
  return getForAdmin(id);
}

// Takes a verified shop back to UNVERIFIED and marks its approved requests as REVOKED.
export async function revokeShop(admin, shopId, reason) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, name: true, verificationLevel: true },
  });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (shop.verificationLevel === 'UNVERIFIED') throw new AppError(409, 'This shop is not verified');

  await prisma.$transaction(async (tx) => {
    await tx.shop.update({ where: { id: shopId }, data: { verificationLevel: 'UNVERIFIED' } });
    await tx.shopVerification.updateMany({
      where: { shopId, status: 'APPROVED' },
      data: { status: 'REVOKED' },
    });
    await audit(tx, admin.id, 'shop.verification_revoked', 'Shop', shopId, {
      reason,
      fromLevel: shop.verificationLevel,
    });
  });
  return { shopId, level: 'UNVERIFIED' };
}

export async function listAuditLogs({ entityType, entityId, page, limit }) {
  const where = { ...(entityType && { entityType }), ...(entityId && { entityId }) };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { actor: { select: { id: true, name: true } } },
    }),
  ]);
  return {
    items: rows.map((l) => ({
      id: l.id,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      meta: l.meta,
      createdAt: l.createdAt,
      actor: l.actor,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}