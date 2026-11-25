// Platform settings (admin switches) in PlatformSetting as key/value. A missing key = its default.
// Read through a short in-process cache; a write clears it (one API process).
import { z } from 'zod';
import { prisma } from './prisma.js';

export const SETTINGS = {
  subscriptionsEnabled: { default: false, schema: z.boolean() },
  freeTrialDays: { default: 30, schema: z.number().int().min(0).max(365) },
  graceDays: { default: 7, schema: z.number().int().min(0).max(90) },
  popupsEnabled: { default: true, schema: z.boolean() },
};

const CACHE_MS = 5000;
let cache = null; // { at, values }

export async function getSettings() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: Object.keys(SETTINGS) } } });
  const values = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.default]));
  for (const r of rows) {
    const parsed = SETTINGS[r.key].schema.safeParse(r.value);
    if (parsed.success) values[r.key] = parsed.data;
  }
  cache = { at: Date.now(), values };
  return values;
}

export const getSetting = async (key) => (await getSettings())[key];

/** Saves the given keys (already validated) inside tx; returns the keys that changed { key: { from, to } }. */
export async function saveSettings(tx, actorId, patch) {
  const before = await getSettings();
  const changed = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await tx.platformSetting.upsert({ where: { key }, update: { value, updatedById: actorId }, create: { key, value, updatedById: actorId } });
    if (before[key] !== value) changed[key] = { from: before[key], to: value };
  }
  cache = null;
  return changed;
}

/** Call after the transaction committed (or failed), so the next read sees the database. */
export const clearSettingsCache = () => {
  cache = null;
};
