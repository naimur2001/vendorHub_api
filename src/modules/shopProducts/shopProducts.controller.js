import * as s from './shopProducts.service.js';

export const similar = async (req, res) => {
  res.json({ success: true, data: await s.findSimilar(req.user, req.params.shopId, req.validated) });
};

export const create = async (req, res) => {
  res.status(201).json({ success: true, data: await s.createShopProduct(req.user, req.params.shopId, req.body) });
};

export const update = async (req, res) => {
  res.json({ success: true, data: await s.updateShopProduct(req.user, req.params.shopId, req.params.productId, req.body) });
};



import * as photos from './productPhotos.service.js';

// A shop changes photos under the same rule as its other edits (its own, not locked, not hidden).
const shopRule = (req) => ({
  check: async (product) => {
    await s.activeShop(req.user, req.params.shopId);
    await s.assertShopCanEdit(req.params.shopId, product);
  },
  lock: false,
});

export const addPhoto = async (req, res) => {
  res.json({ success: true, data: await photos.addPhoto(req.user, req.params.productId, req.file, shopRule(req)) });
};

export const removePhoto = async (req, res) => {
  res.json({ success: true, data: await photos.removePhoto(req.user, req.params.productId, req.params.imageId, shopRule(req)) });
};