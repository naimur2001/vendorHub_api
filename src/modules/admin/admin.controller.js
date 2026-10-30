import * as adminService from './admin.service.js';

export const listShops = async (req, res) => {
  const { items, pagination } = await adminService.listShops(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const setShopStatus = async (req, res) => {
  const data = await adminService.setShopStatus(req.user, req.params.shopId, req.body);
  res.json({ success: true, data });
};

export const sales = async (req, res) => {
  res.json({ success: true, data: await adminService.salesReport(req.validated) });
};

export const top = async (req, res) => {
  res.json({ success: true, data: await adminService.topReport(req.validated) });
};