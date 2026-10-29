import * as tryOnService from './tryOn.service.js';

export const info = async (req, res) => {
  res.json({ success: true, data: await tryOnService.tryOnInfo(req.params.slug) });
};

export const generate = async (req, res) => {
  const data = await tryOnService.generate(req.user, req.validated, req.files);
  res.set('Cache-Control', 'no-store'); // the picture of the customer must not be cached anywhere
  res.json({ success: true, data });
};

export const toggle = async (req, res) => {
  res.json({ success: true, data: await tryOnService.setCategoryTryOn(req.user, req.params.id, req.body) });
};