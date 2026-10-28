import * as staffService from './staff.service.js';

export const list = async (req, res) => {
  res.json({ success: true, data: await staffService.listStaff(req.user, req.params.shopId) });
};

export const add = async (req, res) => {
  const data = await staffService.addStaff(req.user, req.params.shopId, req.body);
  res.status(201).json({ success: true, data });
};

export const remove = async (req, res) => {
  await staffService.removeStaff(req.user, req.params.shopId, req.params.userId);
  res.json({ success: true, data: { message: 'Staff member removed' } });
};