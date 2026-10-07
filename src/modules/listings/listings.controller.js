import * as listingService from './listings.service.js';

export const list = async (req, res) => {
  const data = await listingService.listShopListings(req.user, req.params.shopId);
  res.json({ success: true, data });
};

export const create = async (req, res) => {
  const data = await listingService.createListing(req.user, req.params.shopId, req.body);
  res.status(201).json({ success: true, data });
};

export const update = async (req, res) => {
  const { shopId, listingId } = req.params;
  const data = await listingService.updateListing(req.user, shopId, listingId, req.body);
  res.json({ success: true, data });
};

export const remove = async (req, res) => {
  const { shopId, listingId } = req.params;
  await listingService.removeListing(req.user, shopId, listingId);
  res.json({ success: true, data: { message: 'Listing removed' } });
};