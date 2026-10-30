import * as s from './adminCatalog.service.js';

const created = (res, data) => res.status(201).json({ success: true, data });
const ok = (res, data) => res.json({ success: true, data });
const removed = (res, what) => res.json({ success: true, data: { message: `${what} deleted` } });

export const createCategory = async (req, res) => created(res, await s.createCategory(req.user, req.body));
export const updateCategory = async (req, res) => ok(res, await s.updateCategory(req.user, req.params.id, req.body));
export const deleteCategory = async (req, res) => {
  await s.deleteCategory(req.user, req.params.id);
  removed(res, 'Category');
};

export const createBrand = async (req, res) => created(res, await s.createBrand(req.user, req.body));
export const updateBrand = async (req, res) => ok(res, await s.updateBrand(req.user, req.params.id, req.body));
export const deleteBrand = async (req, res) => {
  await s.deleteBrand(req.user, req.params.id);
  removed(res, 'Brand');
};

export const createMarket = async (req, res) => created(res, await s.createMarket(req.user, req.body));
export const updateMarket = async (req, res) => ok(res, await s.updateMarket(req.user, req.params.id, req.body));
export const deleteMarket = async (req, res) => {
  await s.deleteMarket(req.user, req.params.id);
  removed(res, 'Market');
};

export const listProducts = async (req, res) => {
  const { items, pagination } = await s.listProducts(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};
export const createProduct = async (req, res) => created(res, await s.createProduct(req.user, req.body));
export const updateProduct = async (req, res) => ok(res, await s.updateProduct(req.user, req.params.id, req.body));
export const deactivateProduct = async (req, res) => {
  await s.deactivateProduct(req.user, req.params.id);
  res.json({ success: true, data: { message: 'Product deactivated' } });
};