// Courier delivery setup: providers (admin), delivery zones and customer fees (admin), the public
// location lists, address locations, the shop's delivery mode and its courier pickup store.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { adapterFor, locations, CourierError } from '../../lib/couriers/index.js';

const audit = (tx, actorId, action, entityType, entityId, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType, entityId, meta } });

// ---------- providers ----------

/** The default active provider, or null when none is set up. */
export const defaultProvider = (db = prisma) => db.courierProvider.findFirst({ where: { isActive: true, isDefault: true } });

async function requireDefaultProvider() {
  const p = await defaultProvider();
  if (!p) throw new AppError(503, 'Courier delivery is not available right now', { code: 'NO_COURIER' });
  return p;
}

const courierUnavailable = (err) => {
  if (err instanceof CourierError) throw new AppError(502, 'The courier service did not answer. Try again later', { code: 'COURIER_UNAVAILABLE' });
  throw err;
};

export const listProviders = () => prisma.courierProvider.findMany({ orderBy: { code: 'asc' } });

export async function updateProvider(admin, id, input) {
  const p = await prisma.courierProvider.findUnique({ where: { id } });
  if (!p) throw new AppError(404, 'Courier not found');
  const next = { isActive: input.isActive ?? p.isActive, isDefault: input.isDefault ?? p.isDefault };
  if (next.isDefault && !next.isActive) throw new AppError(409, 'The default courier must be active', { code: 'DEFAULT_MUST_BE_ACTIVE' });
  if (p.isDefault && !next.isDefault) throw new AppError(409, 'Make another courier the default instead', { code: 'DEFAULT_REQUIRED' });
  if (p.isDefault && !next.isActive) throw new AppError(409, 'Make another courier the default first', { code: 'DEFAULT_REQUIRED' });
  return prisma.$transaction(async (tx) => {
    if (next.isDefault && !p.isDefault) await tx.courierProvider.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const updated = await tx.courierProvider.update({ where: { id }, data: input });
    await audit(tx, admin.id, 'delivery.courier_updated', 'CourierProvider', id, { code: p.code, ...input, config: undefined });
    return updated;
  });
}

// ---------- zones ----------

export const listZones = () => prisma.deliveryZone.findMany({ orderBy: { customerFee: 'asc' } });

export async function createZone(admin, input) {
  try {
    return await prisma.$transaction(async (tx) => {
      const z = await tx.deliveryZone.create({ data: input });
      await audit(tx, admin.id, 'delivery.zone_created', 'DeliveryZone', z.id, { code: z.code, customerFee: z.customerFee });
      return z;
    });
  } catch (err) {
    if (err.code === 'P2002') throw new AppError(409, 'A zone with this code already exists', { code: 'ZONE_EXISTS' });
    throw err;
  }
}

export async function updateZone(admin, id, input) {
  const z = await prisma.deliveryZone.findUnique({ where: { id } });
  if (!z) throw new AppError(404, 'Delivery zone not found');
  return prisma.$transaction(async (tx) => {
    const updated = await tx.deliveryZone.update({ where: { id }, data: input });
    await audit(tx, admin.id, 'delivery.zone_updated', 'DeliveryZone', id, { code: z.code, ...input });
    return updated;
  });
}

export async function deleteZone(admin, id) {
  const z = await prisma.deliveryZone.findUnique({ where: { id } });
  if (!z) throw new AppError(404, 'Delivery zone not found');
  if (z.code === 'OUTSIDE_DHAKA') throw new AppError(409, 'OUTSIDE_DHAKA is the fallback zone and cannot be deleted', { code: 'FALLBACK_ZONE' });
  await prisma.$transaction(async (tx) => {
    await tx.deliveryZone.delete({ where: { id } });
    await audit(tx, admin.id, 'delivery.zone_deleted', 'DeliveryZone', id, { code: z.code });
  });
}

/** The zone of a courier location: by zone id, then by city id, else OUTSIDE_DHAKA. */
export async function zoneFor(db, { courierCityId, courierZoneId }) {
  const zones = await db.deliveryZone.findMany();
  const zone =
    zones.find((z) => z.courierZoneIds.includes(courierZoneId)) ??
    zones.find((z) => z.courierCityIds.includes(courierCityId)) ??
    zones.find((z) => z.code === 'OUTSIDE_DHAKA');
  return zone && zone.isActive ? zone : null;
}

// ---------- public location lists (names only) ----------

const loc = async (load) => {
  const provider = await requireDefaultProvider();
  try {
    return (await load(provider)).map(({ id, name }) => ({ id, name }));
  } catch (err) {
    return courierUnavailable(err);
  }
};
export const cities = () => loc((p) => locations.cities(p));
export const zonesOf = (cityId) => loc((p) => locations.zones(p, cityId));
export const areasOf = (zoneId) => loc((p) => locations.areas(p, zoneId));

/** Checks a courier location and returns the fields to save on an address (names from the lists). */
export async function addressLocation({ courierCityId, courierZoneId, courierAreaId }) {
  const provider = await requireDefaultProvider();
  try {
    const city = (await locations.cities(provider)).find((c) => c.id === courierCityId);
    const zone = city && (await locations.zones(provider, city.id)).find((z) => z.id === courierZoneId);
    const area = zone && (await locations.areas(provider, zone.id)).find((a) => a.id === courierAreaId);
    if (!area) throw new AppError(400, 'Choose the city, zone and area from the delivery location lists', { code: 'BAD_LOCATION' });
    return {
      courierCityId: city.id,
      courierCityName: city.name,
      courierZoneId: zone.id,
      courierZoneName: zone.name,
      courierAreaId: area.id,
      courierAreaName: area.name,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    return courierUnavailable(err);
  }
}

// ---------- shop delivery mode and courier store ----------

export async function setDeliveryMode(user, shopId, { deliveryMode }) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, ownerId: true, deliveryMode: true } });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (shop.ownerId !== user.id) throw new AppError(403, 'Only the shop owner can do this');
  const updated = await prisma.$transaction(async (tx) => {
    const s = await tx.shop.update({ where: { id: shopId }, data: { deliveryMode }, select: { deliveryMode: true, courierStoreId: true } });
    await audit(tx, user.id, 'shop.delivery_mode_changed', 'Shop', shopId, { from: shop.deliveryMode, to: deliveryMode });
    return s;
  });
  return { shopId, deliveryMode: updated.deliveryMode, courierReady: Boolean(updated.courierStoreId) };
}

/** Admin: creates the shop's pickup store at the default courier, or refreshes its id. */
export async function createCourierStore(admin, shopId, input) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, name: true, slug: true, phone: true, addressLine: true, courierStoreId: true, owner: { select: { name: true } }, market: { select: { name: true } } },
  });
  if (!shop) throw new AppError(404, 'Shop not found');
  if (!shop.phone) throw new AppError(409, 'The shop needs a phone number first', { code: 'SHOP_PHONE_MISSING' });
  const provider = await requireDefaultProvider();
  const adapter = adapterFor(provider);
  const storeName = `VH ${shop.name}`.slice(0, 50);

  let storeId = null;
  try {
    const found = await adapter.findStore(provider, storeName);
    if (found) storeId = found.storeId;
    else {
      if (!input.courierCityId) {
        throw new AppError(400, 'Send courierCityId, courierZoneId and courierAreaId to create the store', { code: 'LOCATION_REQUIRED' });
      }
      const where = await addressLocation(input);
      const made = await adapter.createStore(provider, {
        name: storeName,
        contactName: shop.owner.name,
        phone: shop.phone,
        address: [shop.addressLine, shop.market?.name].filter(Boolean).join(', '),
        cityId: where.courierCityId,
        zoneId: where.courierZoneId,
        areaId: where.courierAreaId,
      });
      storeId = made.storeId;
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    return courierUnavailable(err);
  }

  await prisma.$transaction(async (tx) => {
    if (storeId) await tx.shop.update({ where: { id: shopId }, data: { courierStoreId: storeId } });
    await audit(tx, admin.id, 'shop.courier_store_set', 'Shop', shopId, { provider: provider.code, ready: Boolean(storeId) });
  });
  // the store id is admin data: the shop only learns whether courier delivery is ready
  return { shopId, provider: provider.code, courierStoreId: storeId, state: storeId ? 'READY' : 'PENDING_APPROVAL' };
}

/** True when the shop can take delivery orders right now (OWN, or PLATFORM_COURIER with a store). */
export const deliveryAvailable = (shop) =>
  Boolean(shop.supportsDelivery) && (shop.deliveryMode !== 'PLATFORM_COURIER' || Boolean(shop.courierStoreId));
