// Home page billboard. Media follow the market photo pattern:
// process (re-encode to WebP) -> publish new files -> database transaction -> delete old files.
// If the transaction fails, the new files are deleted again, so nothing points at a missing file.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { processImage } from '../../lib/images.js';
import { stageImage, removeImage, imageUrls } from '../../lib/storage.js';
import { bannerId } from './banners.schema.js';

const PUBLIC_LIMIT = 10;
const PURPOSE = { main: 'HOME_BANNER', mobile: 'HOME_BANNER_MOBILE' };
const include = { image: true, mobileImage: true };
const order = [{ sortOrder: 'asc' }, { createdAt: 'asc' }];
const NOT_FOUND = 'Banner not found';

const isLive = (b, now = new Date()) =>
  b.isActive && (!b.startsAt || b.startsAt <= now) && (!b.endsAt || b.endsAt > now);

const media = (img) => {
  if (!img) return null;
  const { url, thumbUrl } = imageUrls(img.key);
  return { url, thumbUrl, width: img.width, height: img.height };
};

// Display fields only (what the home page needs).
const presentPublic = (b) => ({
  id: b.id,
  titleEn: b.titleEn,
  titleBn: b.titleBn,
  subtitleEn: b.subtitleEn,
  subtitleBn: b.subtitleBn,
  mediaType: b.mediaType,
  media: media(b.image),
  mobileMedia: media(b.mobileImage),
  linkUrl: b.linkUrl,
  ctaLabelEn: b.ctaLabelEn,
  ctaLabelBn: b.ctaLabelBn,
  sortOrder: b.sortOrder,
});

const presentAdmin = (b) => ({
  ...presentPublic(b),
  isActive: b.isActive,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  liveNow: isLive(b),
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

const audit = (tx, admin, action, entityId, meta) =>
  tx.auditLog.create({ data: { actorId: admin.id, action, entityType: 'Banner', entityId, meta } });

async function findBanner(id) {
  if (!bannerId.safeParse(id).success) throw new AppError(404, NOT_FOUND);
  const banner = await prisma.banner.findUnique({ where: { id }, include });
  if (!banner) throw new AppError(404, NOT_FOUND);
  return banner;
}

// Processes every new file first (a bad phone version must not leave a published main file),
// then publishes them. Returns { main?, mobile?, keys } .
async function publishMedia(files) {
  const mainFile = files?.media?.[0];
  const mobileFile = files?.mobileMedia?.[0];
  const processed = {
    main: mainFile && (await processImage(mainFile.buffer, 'HOME_BANNER')),
    mobile: mobileFile && (await processImage(mobileFile.buffer, 'HOME_BANNER_MOBILE')),
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

const createImage = (tx, admin, m, purpose) =>
  tx.image.create({ data: { key: m.key, width: m.width, height: m.height, purpose, ownerId: admin.id } });

// ---------- public ----------
export async function listPublic() {
  const now = new Date();
  const rows = await prisma.banner.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    include,
    orderBy: order,
    take: PUBLIC_LIMIT,
  });
  return rows.map(presentPublic);
}

// ---------- admin ----------
export async function listAdmin() {
  const rows = await prisma.banner.findMany({ include, orderBy: order });
  return rows.map(presentAdmin);
}

export async function createBanner(admin, body, files) {
  if (!files?.media?.[0]) throw new AppError(400, 'Send the banner image in the multipart field "media"');
  const published = await publishMedia(files);
  try {
    const banner = await prisma.$transaction(async (tx) => {
      const image = await createImage(tx, admin, published.main, PURPOSE.main);
      const mobile = published.mobile && (await createImage(tx, admin, published.mobile, PURPOSE.mobile));
      let { sortOrder } = body;
      if (sortOrder === undefined) {
        const last = await tx.banner.aggregate({ _max: { sortOrder: true } });
        sortOrder = (last._max.sortOrder ?? -1) + 1; // new banners go to the end
      }
      const b = await tx.banner.create({
        data: {
          ...body,
          sortOrder,
          mediaType: published.main.animated ? 'GIF' : 'IMAGE',
          imageId: image.id,
          mobileImageId: mobile ? mobile.id : null,
        },
        include,
      });
      await audit(tx, admin, 'banner.created', b.id, { titleEn: b.titleEn });
      return b;
    });
    return presentAdmin(banner);
  } catch (err) {
    await Promise.all(published.keys.map((k) => removeImage(k).catch(() => {})));
    throw err;
  }
}

export async function updateBanner(admin, id, body, files) {
  const banner = await findBanner(id);
  const { removeMobileMedia, ...fields } = body;
  const hasFiles = Boolean(files?.media?.[0] || files?.mobileMedia?.[0]);
  if (Object.keys(fields).length === 0 && !hasFiles && !removeMobileMedia) {
    throw new AppError(400, 'Nothing to update');
  }
  // the dates are checked together with the stored values
  const startsAt = fields.startsAt !== undefined ? fields.startsAt : banner.startsAt;
  const endsAt = fields.endsAt !== undefined ? fields.endsAt : banner.endsAt;
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError(400, 'endsAt must be after startsAt');

  const published = await publishMedia(files);
  const oldKeys = [];
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const data = { ...fields };
      const oldImageIds = [];
      if (published.main) {
        const image = await createImage(tx, admin, published.main, PURPOSE.main);
        data.imageId = image.id;
        data.mediaType = published.main.animated ? 'GIF' : 'IMAGE';
        oldImageIds.push(banner.image.id);
        oldKeys.push(banner.image.key);
      }
      if (published.mobile || removeMobileMedia) {
        data.mobileImageId = published.mobile
          ? (await createImage(tx, admin, published.mobile, PURPOSE.mobile)).id
          : null;
        if (banner.mobileImage) {
          oldImageIds.push(banner.mobileImage.id);
          oldKeys.push(banner.mobileImage.key);
        }
      }
      const b = await tx.banner.update({ where: { id }, data, include });
      if (oldImageIds.length) await tx.image.deleteMany({ where: { id: { in: oldImageIds } } });
      await audit(tx, admin, 'banner.updated', id, {
        fields: Object.keys(fields),
        mediaReplaced: Boolean(published.main),
        mobileMediaChanged: Boolean(published.mobile || removeMobileMedia),
      });
      return b;
    });
    await Promise.all(oldKeys.map((k) => removeImage(k).catch(() => {}))); // old files, after success
    return presentAdmin(updated);
  } catch (err) {
    await Promise.all(published.keys.map((k) => removeImage(k).catch(() => {})));
    throw err;
  }
}

export async function deleteBanner(admin, id) {
  const banner = await findBanner(id);
  const imageIds = [banner.image.id, banner.mobileImage?.id].filter(Boolean);
  await prisma.$transaction(async (tx) => {
    await tx.banner.delete({ where: { id } });
    await tx.image.deleteMany({ where: { id: { in: imageIds } } });
    await audit(tx, admin, 'banner.deleted', id, { titleEn: banner.titleEn });
  });
  await Promise.all(
    [banner.image.key, banner.mobileImage?.key].filter(Boolean).map((k) => removeImage(k).catch(() => {})),
  );
}

// Sets sortOrder 0, 1, 2 ... in the given order. Banners not listed keep their sortOrder.
export async function reorderBanners(admin, ids) {
  const found = await prisma.banner.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new AppError(404, NOT_FOUND);
  await prisma.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.banner.update({ where: { id }, data: { sortOrder: i } });
    }
    await audit(tx, admin, 'banner.reordered', ids[0], { ids });
  });
  return listAdmin();
}
