// Home page billboard. Media follow the market photo pattern:
// process (re-encode to WebP) -> publish new files -> database transaction -> delete old files.
// If the transaction fails, the new files are deleted again, so nothing points at a missing file.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { processImage, IMAGE_PROFILES } from '../../lib/images.js';
import { stageImage, removeImage, imageUrls } from '../../lib/storage.js';
import { MAX_BANNERS, MAX_GALLERY_IMAGES } from '../../config/limits.js';
import { bannerId } from './banners.schema.js';

// per placement: the slider shows all live banners, the side advertisement at most 3 (the web shows the first)
const PUBLIC_LIMIT = { HERO: MAX_BANNERS, SIDE_AD: 3, GALLERY: MAX_GALLERY_IMAGES };
// the image rules per placement (HERO landscape, SIDE_AD tall, GALLERY any shape)
const PROFILE = { HERO: 'HOME_BANNER', SIDE_AD: 'SIDE_AD', GALLERY: 'GALLERY' };
// limits: HERO + SIDE_AD share MAX_BANNERS; GALLERY has its own MAX_GALLERY_IMAGES (active or not)
const isGallery = (placement) => placement === 'GALLERY';
const limitGroup = (placement) => (isGallery(placement) ? { placement: 'GALLERY' } : { placement: { in: ['HERO', 'SIDE_AD'] } });
const maxOf = (placement) => (isGallery(placement) ? MAX_GALLERY_IMAGES : MAX_BANNERS);
// GALLERY is pictures only: these texts are not kept
const PICTURE_ONLY = { subtitleEn: null, subtitleBn: null, ctaLabelEn: null, ctaLabelBn: null };
// Serialises banner creation (Postgres advisory lock, released at the end of the transaction),
// so two uploads at the same time cannot both pass the limit check.
const CREATE_LOCK = 724_001;
const limitReached = (placement) =>
  isGallery(placement)
    ? new AppError(409, `You can have at most ${MAX_GALLERY_IMAGES} gallery images. Delete one first.`, { code: 'GALLERY_LIMIT' })
    : new AppError(409, `You can have at most ${MAX_BANNERS} banners. Delete one first.`, { code: 'BANNER_LIMIT' });
const countGroup = (db, placement) => db.banner.count({ where: limitGroup(placement) });
const noPhoneVersion = () => new AppError(422, 'Gallery images have no phone version: leave "mobileMedia" out', { code: 'GALLERY_NO_MOBILE' });
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
  fit: b.fit,
  placement: b.placement,
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
async function publishMedia(files, placement) {
  const mainFile = files?.media?.[0];
  const mobileFile = files?.mobileMedia?.[0];
  const processed = {
    main: mainFile && (await processImage(mainFile.buffer, PROFILE[placement])),
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
export async function listPublic(placement = 'HERO') {
  const now = new Date();
  const rows = await prisma.banner.findMany({
    where: {
      placement,
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    include,
    orderBy: order,
    take: PUBLIC_LIMIT[placement],
  });
  return rows.map(presentPublic);
}

// ---------- admin ----------
// meta { total, max } is the limit of the requested placement: GALLERY -> its own 16; HERO, SIDE_AD or
// no filter -> the 12 shared by HERO + SIDE_AD (then meta.gallery has the gallery's numbers too)
export async function listAdmin(placement) {
  const [rows, shared, gallery] = await Promise.all([
    prisma.banner.findMany({ where: placement ? { placement } : {}, include, orderBy: [{ placement: 'asc' }, ...order] }),
    countGroup(prisma, 'HERO'),
    countGroup(prisma, 'GALLERY'),
  ]);
  const meta = isGallery(placement)
    ? { total: gallery, max: MAX_GALLERY_IMAGES }
    : { total: shared, max: MAX_BANNERS, ...(!placement && { gallery: { total: gallery, max: MAX_GALLERY_IMAGES } }) };
  return { items: rows.map(presentAdmin), meta };
}

export async function createBanner(admin, body, files) {
  if (!files?.media?.[0]) throw new AppError(400, 'Send the banner image in the multipart field "media"');
  const placement = body.placement ?? 'HERO';
  if (isGallery(placement) && files?.mobileMedia?.[0]) throw noPhoneVersion();
  // quick check before any file is written; the real check is repeated under the lock below
  if ((await countGroup(prisma, placement)) >= maxOf(placement)) throw limitReached(placement);
  const published = await publishMedia(files, placement);
  try {
    const banner = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CREATE_LOCK}::bigint)`; // $queryRaw cannot read a void result
      if ((await countGroup(tx, placement)) >= maxOf(placement)) throw limitReached(placement);
      const image = await createImage(tx, admin, published.main, PURPOSE.main);
      const mobile = published.mobile && (await createImage(tx, admin, published.mobile, PURPOSE.mobile));
      let { sortOrder } = body;
      if (sortOrder === undefined) {
        const last = await tx.banner.aggregate({ where: { placement }, _max: { sortOrder: true } });
        sortOrder = (last._max.sortOrder ?? -1) + 1; // new banners go to the end
      }
      const b = await tx.banner.create({
        data: {
          ...body,
          ...(isGallery(placement) && PICTURE_ONLY),
          placement,
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

  // a new placement keeps the current image only when it meets that placement's minimum size
  const placement = fields.placement ?? banner.placement;
  const moved = placement !== banner.placement;
  if (isGallery(placement) && files?.mobileMedia?.[0]) throw noPhoneVersion();
  // moving between the gallery and HERO / SIDE_AD must fit the other limit
  if (moved && isGallery(placement) !== isGallery(banner.placement) && (await countGroup(prisma, placement)) >= maxOf(placement)) {
    throw limitReached(placement);
  }
  if (isGallery(placement)) Object.assign(fields, PICTURE_ONLY);
  if (moved && !files?.media?.[0]) {
    const p = IMAGE_PROFILES[PROFILE[placement]];
    if (banner.image.width < p.minWidth || banner.image.height < p.minHeight) {
      throw new AppError(422, `The current image is too small for this placement (at least ${p.minWidth} x ${p.minHeight} pixels). Send a new one.`);
    }
  }
  if (moved && fields.sortOrder === undefined) {
    const last = await prisma.banner.aggregate({ where: { placement }, _max: { sortOrder: true } });
    fields.sortOrder = (last._max.sortOrder ?? -1) + 1; // goes to the end of its new placement
  }

  const published = await publishMedia(files, placement);
  const oldKeys = [];
  const dropMobile = Boolean(removeMobileMedia || (isGallery(placement) && banner.mobileImage)); // the gallery has no phone version
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (moved && isGallery(placement) !== isGallery(banner.placement)) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CREATE_LOCK}::bigint)`;
        if ((await countGroup(tx, placement)) >= maxOf(placement)) throw limitReached(placement);
      }
      const data = { ...fields };
      const oldImageIds = [];
      if (published.main) {
        const image = await createImage(tx, admin, published.main, PURPOSE.main);
        data.imageId = image.id;
        data.mediaType = published.main.animated ? 'GIF' : 'IMAGE';
        oldImageIds.push(banner.image.id);
        oldKeys.push(banner.image.key);
      }
      if (published.mobile || dropMobile) {
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
        mobileMediaChanged: Boolean(published.mobile || dropMobile),
        ...(moved && { placement: { from: banner.placement, to: placement } }),
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
// One placement at a time: mixing slider and side-ad ids is a 400.
export async function reorderBanners(admin, ids) {
  const rows = await prisma.banner.findMany({ where: { id: { in: ids } }, select: { placement: true } });
  if (rows.length !== ids.length) throw new AppError(404, NOT_FOUND);
  const placements = new Set(rows.map((r) => r.placement));
  if (placements.size > 1) throw new AppError(400, 'Reorder the banners of one placement at a time');
  const [placement] = placements;
  await prisma.$transaction(async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.banner.update({ where: { id }, data: { sortOrder: i } });
    }
    await audit(tx, admin, 'banner.reordered', ids[0], { ids, placement });
  });
  return listAdmin(placement);
}
