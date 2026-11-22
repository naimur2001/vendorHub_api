import * as s from './wishlist.service.js';

export const list = async (req, res) => res.json({ success: true, data: await s.list(req.user.id, req.validated) });
export const ids = async (req, res) => res.json({ success: true, data: await s.ids(req.user.id) });
export const removeProduct = async (req, res) => {
  await s.removeProduct(req.user.id, req.params.productId);
  res.status(204).end();
};
export const add = async (req, res) => {
  const { created, item } = await s.add(req.user.id, req.body.listingId);
  res.status(created ? 201 : 200).json({ success: true, data: item });
};
export const remove = async (req, res) => {
  await s.remove(req.user.id, req.params.listingId);
  res.status(204).end();
};
