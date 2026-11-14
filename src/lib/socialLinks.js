// Rules for the public links of a shop (facebook, instagram, tiktok, youtube, website).
// Everything is checked on the text of the URL only: no DNS lookup, no request is ever made.
// Messages are fixed and never repeat what the user sent.
import net from 'node:net';

export const SOCIAL_KEYS = ['facebook', 'instagram', 'tiktok', 'youtube', 'website'];
export const MAX_LINK_LENGTH = 200;

// A platform link must be on that platform: the host equals one of these or is a subdomain of it.
const PLATFORM_HOSTS = {
  facebook: ['facebook.com', 'fb.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
};

const PLATFORM_MESSAGES = {
  facebook: 'Use a link on facebook.com or fb.com',
  instagram: 'Use a link on instagram.com',
  tiktok: 'Use a link on tiktok.com',
  youtube: 'Use a link on youtube.com or youtu.be',
};

// Addresses that are never a public website. An IPv4 rule also matches the IPv4-mapped IPv6 form.
const privateRanges = new net.BlockList();
privateRanges.addSubnet('0.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('169.254.0.0', 16, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addAddress('::', 'ipv6');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
privateRanges.addSubnet('fe80::', 10, 'ipv6');

const PRIVATE_NAMES = ['localhost', 'local', 'internal'];

const fail = (message) => ({ ok: false, message });
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function isPublicHost(host) {
  // new URL() writes IPv6 hosts in brackets and every IPv4 spelling (hex, one number) as a.b.c.d
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = net.isIP(bare);
  if (family !== 0) return !privateRanges.check(bare, family === 6 ? 'ipv6' : 'ipv4');
  if (!host.includes('.')) return false; // one-word hosts are names inside a private network
  return !PRIVATE_NAMES.some((name) => onDomain(host, name));
}

// key: one of SOCIAL_KEYS. Returns { ok: true, url } with the normalised link, or { ok: false, message }.
export function checkSocialLink(key, value) {
  if (!SOCIAL_KEYS.includes(key)) return fail('Unknown link type');
  if (typeof value !== 'string') return fail('Use a full https:// link');
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_LINK_LENGTH) return fail(`Use a link of at most ${MAX_LINK_LENGTH} characters`);

  let url;
  try {
    url = new URL(text);
  } catch {
    return fail('Use a full https:// link');
  }
  if (url.protocol !== 'https:') return fail('Only https:// links are allowed');
  if (url.username !== '' || url.password !== '') return fail('The link must not contain a user name or password');

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return fail('Use a full https:// link');

  if (key === 'website') {
    if (!isPublicHost(host)) return fail('Use a public website address');
  } else if (!PLATFORM_HOSTS[key].some((domain) => onDomain(host, domain))) {
    return fail(PLATFORM_MESSAGES[key]);
  }
  if (url.href.length > MAX_LINK_LENGTH) return fail(`Use a link of at most ${MAX_LINK_LENGTH} characters`);
  return { ok: true, url: url.href };
}

// Only the known keys with a text value: nothing else that is stored can reach an answer.
const known = (raw) => {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of SOCIAL_KEYS) {
    if (typeof raw[key] === 'string' && raw[key] !== '') out[key] = raw[key];
  }
  return out;
};

// PATCH: a key that is sent replaces the stored one, null removes it, a key that is not sent stays.
// patch === null removes every link. Returns the object to store (it may be empty).
export function mergeSocialLinks(current, patch) {
  if (patch === null) return {};
  const merged = known(current);
  for (const key of SOCIAL_KEYS) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) delete merged[key];
    else merged[key] = patch[key];
  }
  return merged;
}

// What the API answers: always the five keys, null when a link is not set.
export function presentSocialLinks(raw) {
  const links = known(raw);
  return Object.fromEntries(SOCIAL_KEYS.map((key) => [key, links[key] ?? null]));
}

export const sameSocialLinks = (a, b) => JSON.stringify(presentSocialLinks(a)) === JSON.stringify(presentSocialLinks(b));
