// Optional, private profile fields (birth year, gender) and the admin's anonymous counts.
import { AppError } from './errors.js';

export const GENDERS = ['FEMALE', 'MALE', 'OTHER', 'PREFER_NOT_TO_SAY'];
export const MIN_AGE = 13;
export const MAX_AGE = 100;
export const SMALL_GROUP = 5; // a group smaller than this is reported as "<5"

/** null / undefined pass; otherwise (this year - 100) .. (this year - 13). Younger than 13 -> 400 TOO_YOUNG. */
export function checkBirthYear(birthYear, now = new Date()) {
  if (birthYear === null || birthYear === undefined) return;
  const year = now.getUTCFullYear();
  if (birthYear > year - MIN_AGE) {
    throw new AppError(400, `You must be at least ${MIN_AGE} years old`, { code: 'TOO_YOUNG' });
  }
  if (birthYear < year - MAX_AGE) throw new AppError(400, `Use a birth year from ${year - MAX_AGE} to ${year - MIN_AGE}`);
}

const AGE_GROUPS = [
  ['under18', 0, 17],
  ['18-24', 18, 24],
  ['25-34', 25, 34],
  ['35-44', 35, 44],
  ['45-54', 45, 54],
  ['55plus', 55, Infinity],
];

// counts only; a group of 0-4 people becomes "<5", so no single person can be picked out
const hideSmall = (n) => (n < SMALL_GROUP ? '<5' : n);

/** From groupBy rows ({ birthYear, _count }) and ({ gender, _count }). */
export function demographics(yearRows, genderRows, now = new Date()) {
  const year = now.getUTCFullYear();
  const ages = Object.fromEntries([...AGE_GROUPS.map(([k]) => [k, 0]), ['unknown', 0]]);
  for (const r of yearRows) {
    const n = r._count._all;
    if (r.birthYear == null) {
      ages.unknown += n;
      continue;
    }
    const age = year - r.birthYear;
    const group = AGE_GROUPS.find(([, lo, hi]) => age >= lo && age <= hi);
    ages[group ? group[0] : 'unknown'] += n;
  }
  const genders = Object.fromEntries([...GENDERS.map((g) => [g, 0]), ['unknown', 0]]);
  for (const r of genderRows) genders[r.gender ?? 'unknown'] += r._count._all;
  return {
    ageGroups: Object.fromEntries(Object.entries(ages).map(([k, v]) => [k, hideSmall(v)])),
    gender: Object.fromEntries(Object.entries(genders).map(([k, v]) => [k, hideSmall(v)])),
  };
}
