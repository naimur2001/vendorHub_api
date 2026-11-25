// Welcome popup: one image / poster per visit. Images use the banner pipeline (processImage ->
// stage + commit -> database transaction -> remove old files). Stats are anonymous daily counts.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage, imageUrls } from '../../lib/storage.js';
import { getSettings, saveSettings, clearSettingsCache } from '../../lib/settings.js';
import { dhakaDay, dayValue } from '../../lib/analytics.js';

const include = { image: true, mobileImage: true };
const NOT_FOUND = 'Popup not found';
const PURPOSE = { main: 'POPUP', mobile: 'POPUP_MOBILE' };
// a change to any of these shows the popup again to people who closed it
const CONTENT = ['titleEn', 'titleBn', 'bodyEn', 'bodyBn', 'linkUrl', 'ctaLabelEn', 'ctaLabelBn'];
const DAY_MS = 24 * 60 * 60 * 1000;

const audit = (tx, admin, action, entityId, meta) => tx.auditLog.create({ data: { actorId: admin.id, action, entityType: 'SitePopup', entityId, meta } });

const isLive = (p, now = new Date()) => p.isActive && (!p.startsAt || p.startsAt <= now) && (!p.endsAt || p.endsAt > now);
const media = (img) => {
  if (!img) return null;
  const { url, thumbUrl } = imageUrls(img.key);
  return { url, thumbUrl, width: img.width, height: img.height };
};

const presentAdmin = (p) => ({
  id: p.id,
  version: p.version,
  titleEn: p.titleEn,
  titleBn: p.titleBn,
  bodyEn: p.bodyEn,
  bodyBn: p.bodyBn,
  mediaType: p.mediaType,
  media: media(p.image),
  mobileMedia: media(p.mobileImage),
  linkUrl: p.linkUrl,
  ctaLabelEn: p.ctaLabelEn,
  ctaLabelBn: p.ctaLabelBn,
  isActive: p.isActive,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  priority: p.priority,
  audience: p.audience,
  pages: p.pages,
  frequency: p.frequency,
  delaySeconds: p.delaySeconds,
  liveNow: isLive(p),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

// the request locale: Bangla falls back to English when a Bangla text is missing
const pick = (lang, en, bn) => (lang === 'bn' && bn ? bn : en);
const presentPublic = (p, lang) => ({
  id: p.id,
  version: p.version,
  title: pick(lang, p.titleEn, p.titleBn),
  body: pick(lang, p.bodyEn, p.bodyBn) ?? null,
  imageUrl: imageUrls(p.image.key).url,
  mobileImageUrl: p.mobileImage ? imageUrls(p.mobileImage.key).url : null,
  mediaType: p.mediaType,
  linkUrl: p.linkUrl,
  ctaLabel: pick(lang, p.ctaLabelEn, p.ctaLabelBn) ?? null,
  frequency: p.frequency,
  delaySeconds: p.delaySeconds,
});

/** Which audiences a visitor belongs to (from the optional login). */
export function audiencesOf(user) {
  if (!user) return ['ALL', 'GUESTS'];
  if (user.role === 'CUSTOMER') return ['ALL', 'CUSTOMERS'];
  if (user.role === 'SHOP_OWNER' || user.role === 'SHOP_STAFF') return ['ALL', 'SHOP_TEAM'];
  return ['ALL'];
}

// ---------- public ----------

/** The one popup to show now (highest priority, then the newest), or null. */
export async function activePopup(user, { page, lang }) {
  if (!(await getSettings()).popupsEnabled) return null;
  const now = new Date();
  const p = await prisma.sitePopup.findFirst({
    where: {
      isActive: true,
      audience: { in: audiencesOf(user) },
      pages: page === 'home' ? { in: ['HOME_ONLY', 'ALL_PAGES'] } : 'ALL_PAGES',
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
    },
    include,
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
  });
  return p ? presentPublic(p, lang) : null;
}

const COLUMN = { VIEW: 'views', CLOSE: 'closes', CLICK: 'clicks' };

/** One anonymous count for today (Dhaka day). */
export async function recordEvent(id, { type }) {
  const popup = await prisma.sitePopup.findUnique({ where: { id }, select: { id: true } });
  if (!popup) throw new AppError(404, NOT_FOUND);
  const day = dayValue(dhakaDay());
  const col = COLUMN[type];
  await prisma.sitePopupDailyStat.upsert({
    where: { popupId_day: { popupId: id, day } },
    update: { [col]: { increment: 1 } },
    create: { popupId: id, day, [col]: 1 },
  });
  return { recorded: type };
}

// ---------- admin ----------

async function findPopup(id) {
  const p = await prisma.sitePopup.findUnique({ where: { id }, include });
  if (!p) throw new AppError(404, NOT_FOUND);
  return p;
}

async function publishMedia(files) {
  const mainFile = files?.media?.[0];
  const mobileFile = files?.mobileMedia?.[0];
  const processed = {
    main: mainFile && (await processImage(mainFile.buffer, 'POPUP')),
    mobile: mobileFile && (await processImage(mobileFile.buffer, 'POPUP')),
  };
  const out = { keys: [] };
  try {
    for (const which of ['main', 'mobile']) {
      const p = processed[which];
      if (!p) continue;
      const staged = await stageImage(p);
      await staged.commit();
      out.keys.push(staged.key);
      out[which] = { key: staged.key, width: p.width, height: p.height, animated: p.animated };
    }
  } catch (err) {
    await Promise.all(out.keys.map((k) => removeImage(k).catch(() => {})));
    throw err;
  }
  return out;
}
const createImage = (tx, admin, m, purpose) => tx.image.create({ data: { key: m.key, width: m.width, height: m.height, purpose, ownerId: admin.id } });

export async function listAdmin() {
  const rows = await prisma.sitePopup.findMany({ include, orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { updatedAt: 'desc' }] });
  return rows.map(presentAdmin);
}

export async function createPopup(admin, body, files) {
  if (!files?.media?.[0]) throw new AppError(400, 'Send the popup image in the multipart field "media"');
  const published = await publishMedia(files);
  try {
    const p = await prisma.$transaction(async (tx) => {
      const image = await createImage(tx, admin, published.main, PURPOSE.main);
      const mobile = published.mobile && (await createImage(tx, admin, published.mobile, PURPOSE.mobile));
      const made = await tx.sitePopup.create({
        data: { ...body, mediaType: published.main.animated ? 'GIF' : 'IMAGE', imageId: image.id, mobileImageId: mobile ? mobile.id : null },
        include,
      });
      await audit(tx, admin, 'popup.created', made.id, { titleEn: made.titleEn });
      return made;
    });
    return presentAdmin(p);
  } catch (err) {
    await Promise.all(published.keys.map((k) => removeImage(k).catch(() => {})));
    throw err;
  }
}

export async function updatePopup(admin, id, body, files) {
  const popup = await findPopup(id);
  const { removeMobileMedia, ...fields } = body;
  const hasFiles = Boolean(files?.media?.[0] || files?.mobileMedia?.[0]);
  if (Object.keys(fields).length === 0 && !hasFiles && !removeMobileMedia) throw new AppError(400, 'Nothing to update');
  const startsAt = fields.startsAt !== undefined ? fields.startsAt : popup.startsAt;
  const endsAt = fields.endsAt !== undefined ? fields.endsAt : popup.endsAt;
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError(400, 'endsAt must be after startsAt');
  const contentChanged = hasFiles || Boolean(removeMobileMedia && popup.mobileImage) || CONTENT.some((k) => fields[k] !== undefined && fields[k] !== popup[k]);

  const published = await publishMedia(files);
  const oldKeys = [];
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const data = { ...fields, ...(contentChanged && { version: { increment: 1 } }) };
      const oldImageIds = [];
      if (published.main) {
        data.imageId = (await createImage(tx, admin, published.main, PURPOSE.main)).id;
        data.mediaType = published.main.animated ? 'GIF' : 'IMAGE';
        oldImageIds.push(popup.image.id);
        oldKeys.push(popup.image.key);
      }
      if (published.mobile || removeMobileMedia) {
        data.mobileImageId = published.mobile ? (await createImage(tx, admin, published.mobile, PURPOSE.mobile)).id : null;
        if (popup.mobileImage) {
          oldImageIds.push(popup.mobileImage.id);
          oldKeys.push(popup.mobileImage.key);
        }
      }
      const p = await tx.sitePopup.update({ where: { id }, data, include });
      if (oldImageIds.length) await tx.image.deleteMany({ where: { id: { in: oldImageIds } } });
      await audit(tx, admin, 'popup.updated', id, { fields: Object.keys(fields), mediaReplaced: Boolean(published.main), versionBumped: contentChanged });
      return p;
    });
    await Promise.all(oldKeys.map((k) => removeImage(k).catch(() => {})));
    return presentAdmin(updated);
  } catch (err) {
    await Promise.all(published.keys.map((k) => removeImage(k).catch(() => {})));
    throw err;
  }
}

export async function stopPopup(admin, id) {
  await findPopup(id);
  const p = await prisma.$transaction(async (tx) => {
    const u = await tx.sitePopup.update({ where: { id }, data: { isActive: false }, include });
    await audit(tx, admin, 'popup.stopped', id, {});
    return u;
  });
  return presentAdmin(p);
}

export async function deletePopup(admin, id) {
  const popup = await findPopup(id);
  await prisma.$transaction(async (tx) => {
    await tx.sitePopup.delete({ where: { id } }); // daily stats cascade
    await tx.image.deleteMany({ where: { id: { in: [popup.image.id, popup.mobileImage?.id].filter(Boolean) } } });
    await audit(tx, admin, 'popup.deleted', id, { titleEn: popup.titleEn });
  });
  await Promise.all([popup.image.key, popup.mobileImage?.key].filter(Boolean).map((k) => removeImage(k).catch(() => {})));
}

export const getPopupSettings = async () => ({ popupsEnabled: (await getSettings()).popupsEnabled });

export async function updatePopupSettings(admin, input) {
  try {
    await prisma.$transaction(async (tx) => {
      const changed = await saveSettings(tx, admin.id, input);
      await tx.auditLog.create({ data: { actorId: admin.id, action: 'settings.updated', entityType: 'PlatformSetting', entityId: 'popups', meta: changed } });
    });
  } finally {
    clearSettingsCache();
  }
  return getPopupSettings();
}

/** Views, closes, clicks and CTR (clicks / views, percent) per Dhaka day, every day of the range. */
export async function popupStats(id, { from, to }) {
  await findPopup(id);
  const toDay = to ?? dhakaDay();
  const fromDay = from ?? new Date(dayValue(toDay).getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
  if ((dayValue(toDay) - dayValue(fromDay)) / DAY_MS > 366) throw new AppError(400, 'The range can be at most one year');
  const rows = await prisma.sitePopupDailyStat.findMany({ where: { popupId: id, day: { gte: dayValue(fromDay), lte: dayValue(toDay) } } });
  const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));
  const ctr = (clicks, views) => (views ? Math.round((clicks / views) * 1000) / 10 : null);
  const days = [];
  for (let t = dayValue(fromDay).getTime(); t <= dayValue(toDay).getTime(); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    const r = byDay.get(d);
    const v = r?.views ?? 0;
    const c = r?.clicks ?? 0;
    days.push({ day: d, views: v, closes: r?.closes ?? 0, clicks: c, ctr: ctr(c, v) });
  }
  const totals = days.reduce((t, d) => ({ views: t.views + d.views, closes: t.closes + d.closes, clicks: t.clicks + d.clicks }), { views: 0, closes: 0, clicks: 0 });
  return { popupId: id, from: fromDay, to: toDay, totals: { ...totals, ctr: ctr(totals.clicks, totals.views) }, days };
}
