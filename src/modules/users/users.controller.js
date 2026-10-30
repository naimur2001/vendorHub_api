import * as s from './users.service.js';

export const updateProfile = async (req, res) => {
  res.json({ success: true, data: await s.updateProfile(req.user.id, req.body) });
};

export const listAddresses = async (req, res) => {
  res.json({ success: true, data: await s.listAddresses(req.user.id) });
};

export const createAddress = async (req, res) => {
  res.status(201).json({ success: true, data: await s.createAddress(req.user.id, req.body) });
};

export const updateAddress = async (req, res) => {
  res.json({ success: true, data: await s.updateAddress(req.user.id, req.params.id, req.body) });
};

export const deleteAddress = async (req, res) => {
  await s.deleteAddress(req.user.id, req.params.id);
  res.json({ success: true, data: { message: 'Address deleted' } });
};

export const listUsers = async (req, res) => {
  const { items, pagination } = await s.listUsers(req.validated);
  res.json({ success: true, data: items, meta: { pagination } });
};

export const getUser = async (req, res) => {
  res.json({ success: true, data: await s.getUser(req.params.id) });
};

export const setStatus = async (req, res) => {
  res.json({ success: true, data: await s.setUserStatus(req.user, req.params.id, req.body) });
};

export const setRole = async (req, res) => {
  res.json({ success: true, data: await s.setUserRole(req.user, req.params.id, req.body) });
};