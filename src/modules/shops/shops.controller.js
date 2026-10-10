import * as shopService from './shops.service.js';

export const markets = async (req, res) => {
  res.json({ success: true, data: await shopService.listMarkets() });
};

export const market = async (req, res) => {
  res.json({ success: true, data: await shopService.getMarket(req.params.slug) });
};

export const shop = async (req, res) => {
  res.json({ success: true, data: await shopService.getShop(req.params.slug, req.user?.id) });
};

export const shopProducts = async (req, res) => {
  const { items, pagination } = await shopService.getShopProducts(req.params.slug, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const shopCategories = async (req, res) => {
  res.json({ success: true, data: await shopService.getShopCategories(req.params.slug) });
};

export const shopReviews = async (req, res) => {
  const { items, pagination } = await shopService.getShopReviews(req.params.slug, req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const follow = async (req, res) => {
  res.json({ success: true, data: await shopService.followShop(req.params.slug, req.user.id) });
};

export const unfollow = async (req, res) => {
  res.json({ success: true, data: await shopService.unfollowShop(req.params.slug, req.user.id) });
};

export const createShop = async (req, res) => {
  const data = await shopService.createShop(req.user, req.body);
  res.status(201).json({ success: true, data });
};

// update shop details
export const updateShop = async (req, res) => {
  const data = await shopService.updateShop(req.user, req.params.shopId, req.body);
  res.json({ success: true, data });
};