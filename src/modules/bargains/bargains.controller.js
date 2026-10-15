import * as bargainService from './bargains.service.js';

export const info = async (req, res) => {
  const data = await bargainService.bargainInfo(req.user, req.params.listingId);
  res.json({ success: true, data });
};

export const create = async (req, res) => {
  const data = await bargainService.createBargain(req.user, req.body);
  res.status(201).json({ success: true, data });
};

export const list = async (req, res) => {
  const { items, pagination } = await bargainService.listMyBargains(req.user, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const get = async (req, res) => {
  res.json({ success: true, data: await bargainService.getBargain(req.user, req.params.id) });
};

export const accept = async (req, res) => {
  res.json({ success: true, data: await bargainService.acceptOffer(req.user, req.params.id) });
};

export const counter = async (req, res) => {
  const data = await bargainService.counterOffer(req.user, req.params.id, req.body.amount);
  res.json({ success: true, data });
};

export const decline = async (req, res) => {
  res.json({ success: true, data: await bargainService.declineOffer(req.user, req.params.id) });
};

export const addToCart = async (req, res) => {
  res.json({ success: true, data: await bargainService.addToCart(req.user, req.params.id) });
};

export const shopInbox = async (req, res) => {
  const { items, pagination } = await bargainService.listShopBargains(
    req.user,
    req.params.shopId,
    req.validated,
  );
  res.json({ success: true, data: items, meta: { pagination } });
};