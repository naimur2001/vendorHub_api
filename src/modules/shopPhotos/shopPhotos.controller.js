import * as photoService from './shopPhotos.service.js';

export const list = async (req, res) => {
  res.json({ success: true, data: await photoService.listPhotos(req.params.slug) });
};

export const add = async (req, res) => {
  const data = await photoService.addPhoto(req.user, req.params.shopId, req.body);
  res.status(201).json({ success: true, data });
};

export const update = async (req, res) => {
  const { shopId, photoId } = req.params;
  res.json({ success: true, data: await photoService.updatePhoto(req.user, shopId, photoId, req.body) });
};

export const remove = async (req, res) => {
  await photoService.deletePhoto(req.user, req.params.shopId, req.params.photoId);
  res.json({ success: true, data: { message: 'Photo removed' } });
};

export const verify = async (req, res) => {
  const { shopId, photoId } = req.params;
  res.json({ success: true, data: await photoService.verifyPhoto(req.user, shopId, photoId, req.body) });
};