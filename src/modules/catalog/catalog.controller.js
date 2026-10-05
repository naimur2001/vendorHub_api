import * as catalogService from './catalog.service.js';

export const categories = async (req, res) => {
  res.json({ success: true, data: await catalogService.listCategories() });
};

export const brands = async (req, res) => {
  res.json({ success: true, data: await catalogService.listBrands() });
};

export const products = async (req, res) => {
  const { items, pagination } = await catalogService.listProducts(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const product = async (req, res) => {
  const data = await catalogService.getProduct(req.params.slug, req.validated.listingId);
  res.json({ success: true, data });
};