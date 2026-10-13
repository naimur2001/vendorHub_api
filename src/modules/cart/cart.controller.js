import * as cartService from './cart.service.js';

export const get = async (req, res) => {
  res.json({ success: true, data: await cartService.getCart(req.user.id) });
};

export const addItem = async (req, res) => {
  res.json({ success: true, data: await cartService.addItem(req.user.id, req.body) });
};

export const updateItem = async (req, res) => {
  const data = await cartService.updateItem(req.user.id, req.params.itemId, req.body);
  res.json({ success: true, data });
};

export const removeItem = async (req, res) => {
  res.json({ success: true, data: await cartService.removeItem(req.user.id, req.params.itemId) });
};

export const clear = async (req, res) => {
  res.json({ success: true, data: await cartService.clearCart(req.user.id) });
};