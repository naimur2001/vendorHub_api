import * as s from './banners.service.js';

const ok = (res, data) => res.json({ success: true, data });

export const listPublic = async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  ok(res, await s.listPublic(req.validated.placement));
};
// { success, data: [...banners], meta: { total, max } }: the admin page shows "8 / 12"
const list = (res, { items, meta }) => res.json({ success: true, data: items, meta });
export const listAdmin = async (req, res) => list(res, await s.listAdmin(req.validated.placement));
export const create = async (req, res) =>
  res.status(201).json({ success: true, data: await s.createBanner(req.user, req.body, req.files) });
export const update = async (req, res) => ok(res, await s.updateBanner(req.user, req.params.id, req.body, req.files));
export const remove = async (req, res) => {
  await s.deleteBanner(req.user, req.params.id);
  ok(res, { message: 'Banner deleted' });
};
export const reorder = async (req, res) => list(res, await s.reorderBanners(req.user, req.body.ids));
