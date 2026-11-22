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
  const { listingId, lat, lng } = req.validated;
  const data = await catalogService.getProduct(req.params.slug, listingId, lat !== undefined ? { lat, lng } : null);
  res.json({ success: true, data });
};

export const productListings = async (req, res) => {
  const { lat, lng } = req.validated;
  res.json({ success: true, data: await catalogService.getProductListings(req.params.slug, lat !== undefined ? { lat, lng } : null) });
};