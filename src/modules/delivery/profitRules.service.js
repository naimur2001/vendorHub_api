// Delivery profit rules (admin only, for analysis): a target profit per shipment. They never change
// what the customer pays (the zone fee) and never change the real margin (customerFee - courierCost).
// Reports always use the CURRENT rules, so old shipments are recalculated too.
// Most specific active rule wins: zone + courier > zone > courier > all.
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

const ruleInclude = { zone: { select: { id: true, code: true, name: true } }, provider: { select: { id: true, code: true, name: true } } };

export const presentRule = (r) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  value: Number(r.value),
  percentOf: r.percentOf,
  zoneId: r.zoneId,
  zoneCode: r.zone?.code ?? null,
  zoneName: r.zone?.name ?? null, // null = all zones
  providerId: r.providerId,
  providerName: r.provider?.name ?? null, // null = all couriers
  isActive: r.isActive,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const audit = (tx, actorId, action, entityId, meta) =>
  tx.auditLog.create({ data: { actorId, action, entityType: 'DeliveryProfitRule', entityId, meta } });

// FIXED: whole taka 0-5000, no percentOf; PERCENT: 0-100 with at most 2 decimals, percentOf required
function checkRule(r) {
  const bad = (message) => {
    throw new AppError(400, message, { code: 'BAD_RULE' });
  };
  if (r.type === 'FIXED') {
    if (!Number.isInteger(r.value) || r.value < 0 || r.value > 5000) bad('A FIXED value is whole taka from 0 to 5000');
    if (r.percentOf) bad('percentOf is only for PERCENT rules');
  } else {
    if (r.value < 0 || r.value > 100 || Math.abs(Math.round(r.value * 100) - r.value * 100) > 1e-6) bad('A PERCENT value is 0 to 100 with at most 2 decimals');
    if (!r.percentOf) bad('A PERCENT rule needs percentOf (CUSTOMER_FEE or COURIER_COST)');
  }
}

async function checkRefs(r) {
  if (r.zoneId && !(await prisma.deliveryZone.findUnique({ where: { id: r.zoneId }, select: { id: true } }))) {
    throw new AppError(400, 'Delivery zone not found', { code: 'ZONE_NOT_FOUND' });
  }
  if (r.providerId && !(await prisma.courierProvider.findUnique({ where: { id: r.providerId }, select: { id: true } }))) {
    throw new AppError(400, 'Courier not found', { code: 'COURIER_NOT_FOUND' });
  }
}

const scopeTaken = () => new AppError(409, 'Another active rule already covers this zone and courier', { code: 'RULE_SCOPE_TAKEN' });

async function checkScope(r, exceptId) {
  if (!r.isActive) return;
  const other = await prisma.deliveryProfitRule.findFirst({
    where: { isActive: true, zoneId: r.zoneId ?? null, providerId: r.providerId ?? null, ...(exceptId && { NOT: { id: exceptId } }) },
    select: { id: true },
  });
  if (other) throw scopeTaken();
}

// the partial unique index catches two parallel requests
const save = async (work) => {
  try {
    return await work();
  } catch (err) {
    if (err.code === 'P2002') throw scopeTaken();
    throw err;
  }
};

export const listRules = async () =>
  (await prisma.deliveryProfitRule.findMany({ include: ruleInclude, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] })).map(presentRule);

export async function createRule(admin, input) {
  const r = { percentOf: null, zoneId: null, providerId: null, isActive: true, ...input };
  checkRule(r);
  await checkRefs(r);
  await checkScope(r);
  return save(() =>
    prisma.$transaction(async (tx) => {
      const made = await tx.deliveryProfitRule.create({ data: r, include: ruleInclude });
      await audit(tx, admin.id, 'delivery.profit_rule_created', made.id, { name: r.name, type: r.type, value: r.value, percentOf: r.percentOf, zoneId: r.zoneId, providerId: r.providerId, isActive: r.isActive });
      return presentRule(made);
    }),
  );
}

export async function updateRule(admin, id, input) {
  const old = await prisma.deliveryProfitRule.findUnique({ where: { id } });
  if (!old) throw new AppError(404, 'Profit rule not found');
  const next = { ...old, value: Number(old.value), ...input };
  if (input.type === 'FIXED' && input.percentOf === undefined) next.percentOf = null; // switching to FIXED drops the base
  checkRule(next);
  await checkRefs(next);
  await checkScope(next, id);
  const data = { ...input, ...(next.percentOf === null && { percentOf: null }) };
  return save(() =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.deliveryProfitRule.update({ where: { id }, data, include: ruleInclude });
      await audit(tx, admin.id, 'delivery.profit_rule_updated', id, data);
      return presentRule(updated);
    }),
  );
}

export async function deleteRule(admin, id) {
  const old = await prisma.deliveryProfitRule.findUnique({ where: { id } });
  if (!old) throw new AppError(404, 'Profit rule not found');
  await prisma.$transaction(async (tx) => {
    await tx.deliveryProfitRule.delete({ where: { id } });
    await audit(tx, admin.id, 'delivery.profit_rule_deleted', id, { name: old.name });
  });
}

// ---------- per shipment (JS) ----------

export const activeRules = (db = prisma) => db.deliveryProfitRule.findMany({ where: { isActive: true }, include: ruleInclude });

/** The most specific active rule for a shipment (by its zone code and courier), or null. */
export function ruleFor(rules, s) {
  const fits = rules.filter((r) => (!r.zoneId || r.zone?.code === s.zoneCode) && (!r.providerId || r.providerId === s.providerId));
  const rank = (r) => (r.zoneId ? 2 : 0) + (r.providerId ? 1 : 0);
  return fits.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/** { targetProfit, profitGap, ruleId, ruleName } for a shipment. */
export function profitOf(rules, s) {
  const rule = ruleFor(rules, s);
  let targetProfit = null;
  if (rule) {
    const value = Number(rule.value);
    if (rule.type === 'FIXED') targetProfit = value;
    else {
      const base = rule.percentOf === 'CUSTOMER_FEE' ? s.customerFee : s.courierCost;
      targetProfit = base === null || base === undefined ? null : Math.round((base * value) / 100);
    }
  }
  const profitGap = targetProfit === null || s.margin === null || s.margin === undefined ? null : s.margin - targetProfit;
  return { targetProfit, profitGap, ruleId: rule?.id ?? null, ruleName: rule?.name ?? null };
}

// ---------- reports (SQL; the same rule choice and rounding) ----------

/** LATERAL join: r = the most specific active rule of shipment s (columns null when none). */
export const RULE_JOIN = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT pr.type::text AS type, pr.value, pr."percentOf"::text AS "percentOf"
    FROM "DeliveryProfitRule" pr LEFT JOIN "DeliveryZone" pz ON pz.id = pr."zoneId"
    WHERE pr."isActive" AND (pr."zoneId" IS NULL OR pz.code = s."zoneCode") AND (pr."providerId" IS NULL OR pr."providerId" = s."providerId")
    ORDER BY (pr."zoneId" IS NOT NULL) DESC, (pr."providerId" IS NOT NULL) DESC
    LIMIT 1
  ) r ON TRUE`;

const TARGET = Prisma.sql`(CASE
    WHEN r.type IS NULL THEN NULL
    WHEN r.type = 'FIXED' THEN r.value
    WHEN r."percentOf" = 'CUSTOMER_FEE' THEN round(s."customerFee" * r.value / 100)
    ELSE round(s."courierCost" * r.value / 100) END)`;

// over shipments the courier priced (courierCost known), cancelled ones left out; null when none has a rule
const PRICED = Prisma.sql`s."courierCost" IS NOT NULL AND s.status <> 'CANCELLED'`;
export const PROFIT_METRICS = Prisma.sql`
  (sum(${TARGET}) FILTER (WHERE ${PRICED}))::int AS "targetProfit",
  (sum(s.margin - ${TARGET}) FILTER (WHERE ${PRICED}))::int AS "profitGap"`;
export const BELOW_TARGET = Prisma.sql`count(*) FILTER (WHERE ${PRICED} AND s.margin - ${TARGET} < 0)::int AS "belowTarget"`;
