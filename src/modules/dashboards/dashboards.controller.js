import * as dashboardService from './dashboards.service.js';

export const customer = async (req, res) => {
  res.json({ success: true, data: await dashboardService.customerDashboard(req.user) });
};

export const shop = async (req, res) => {
  res.json({ success: true, data: await dashboardService.shopDashboard(req.user, req.params.shopId) });
};

export const admin = async (req, res) => {
  res.json({ success: true, data: await dashboardService.adminDashboard() });
};