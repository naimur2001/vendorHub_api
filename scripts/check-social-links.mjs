// Usage: node scripts/check-social-links.mjs
// Runs the shop link rules (src/lib/socialLinks.js) against a table of good and bad links.
// No database and no network. Exit code 0 = every case behaves as written here.
import { checkSocialLink, mergeSocialLinks, presentSocialLinks } from '../src/lib/socialLinks.js';

const GOOD = [
  ['facebook', 'https://facebook.com/techzone'],
  ['facebook', 'https://www.facebook.com/techzone'],
  ['facebook', 'https://m.facebook.com/techzone?ref=1'],
  ['facebook', 'https://fb.com/techzone'],
  ['facebook', '  https://WWW.FACEBOOK.COM/techzone  '],
  ['facebook', 'https://facebook.com./techzone'],
  ['instagram', 'https://www.instagram.com/techzone/'],
  ['tiktok', 'https://www.tiktok.com/@techzone'],
  ['youtube', 'https://www.youtube.com/@techzone'],
  ['youtube', 'https://youtu.be/abc123'],
  ['website', 'https://techzone.example.com'],
  ['website', 'https://techzone.com.bd/shop?x=1#top'],
  ['website', 'https://8.8.8.8/'],
  ['website', 'https://[2001:4860:4860::8888]/'],
  ['website', 'https://172.32.0.1/'],
  ['website', 'https://localhost.example.com/'],
];

const BAD = [
  // protocol
  ['facebook', 'http://facebook.com/techzone'],
  ['website', 'http://techzone.example.com'],
  ['website', 'javascript:alert(1)'],
  ['website', 'JaVaScRiPt:alert(1)'],
  ['website', 'data:text/html,<script>alert(1)</script>'],
  ['website', 'ftp://techzone.example.com'],
  ['website', 'file:///etc/passwd'],
  ['website', '//techzone.example.com'],
  ['website', 'techzone.example.com'],
  ['website', ''],
  ['website', '   '],
  // user name / password
  ['facebook', 'https://facebook.com@evil.example/page'],
  ['facebook', 'https://user:pass@facebook.com/page'],
  ['website', 'https://admin@techzone.example.com'],
  // platform on another host
  ['facebook', 'https://evil.example/facebook.com'],
  ['facebook', 'https://facebook.com.evil.example/page'],
  ['facebook', 'https://notfacebook.com/page'],
  ['facebook', 'https://instagram.com/techzone'],
  ['instagram', 'https://facebook.com/techzone'],
  ['tiktok', 'https://tiktok.com.evil.example/@x'],
  ['youtube', 'https://youtube.com.evil.example/x'],
  ['youtube', 'https://evil.example/?u=youtu.be'],
  ['facebook', 'https://evil.example\\@facebook.com/page'],
  // private names
  ['website', 'https://localhost'],
  ['website', 'https://localhost:8443/admin'],
  ['website', 'https://LOCALHOST/'],
  ['website', 'https://localhost./'],
  ['website', 'https://api.localhost/'],
  ['website', 'https://printer.local/'],
  ['website', 'https://db.internal/'],
  ['website', 'https://intranet/'],
  // private, loopback and link-local addresses, in every spelling
  ['website', 'https://127.0.0.1/'],
  ['website', 'https://127.1/'],
  ['website', 'https://2130706433/'],
  ['website', 'https://0x7f000001/'],
  ['website', 'https://0177.0.0.1/'],
  ['website', 'https://0.0.0.0/'],
  ['website', 'https://10.0.0.5/'],
  ['website', 'https://172.16.0.1/'],
  ['website', 'https://172.31.255.254/'],
  ['website', 'https://192.168.1.1/'],
  ['website', 'https://169.254.169.254/latest/meta-data/'],
  ['website', 'https://[::1]/'],
  ['website', 'https://[::]/'],
  ['website', 'https://[fc00::1]/'],
  ['website', 'https://[fd12:3456:789a::1]/'],
  ['website', 'https://[fe80::1]/'],
  ['website', 'https://[::ffff:127.0.0.1]/'],
  ['website', 'https://[::ffff:10.0.0.1]/'],
  ['website', 'https://[::ffff:c0a8:101]/'],
  // length and type
  ['website', `https://techzone.example.com/${'a'.repeat(200)}`],
  ['website', 12345],
  ['website', null],
  ['twitter', 'https://twitter.com/techzone'],
];

const problems = [];
for (const [key, value] of GOOD) {
  const r = checkSocialLink(key, value);
  if (!r.ok) problems.push(`should be accepted: ${key} ${JSON.stringify(value)} (${r.message})`);
  else if (!r.url.startsWith('https://')) problems.push(`not an https link after the check: ${key} ${JSON.stringify(value)}`);
}
for (const [key, value] of BAD) {
  const r = checkSocialLink(key, value);
  if (r.ok) problems.push(`should be rejected: ${key} ${JSON.stringify(value)}`);
  else if (typeof value === 'string' && value.trim().length > 8 && r.message.includes(value.trim())) {
    problems.push(`the message repeats the input: ${key} ${JSON.stringify(value)}`);
  }
}

// the stored and the answered shape
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stored = { facebook: 'https://facebook.com/a', website: 'https://a.example/' };
if (!same(mergeSocialLinks(stored, { facebook: null, youtube: 'https://youtu.be/x' }), { website: 'https://a.example/', youtube: 'https://youtu.be/x' })) {
  problems.push('merge: null must remove one link, a new key must be added, other keys must stay');
}
if (!same(mergeSocialLinks(stored, null), {})) problems.push('merge: null must remove every link');
if (!same(mergeSocialLinks(null, { tiktok: 'https://tiktok.com/@a' }), { tiktok: 'https://tiktok.com/@a' })) problems.push('merge: must work without stored links');
if (!same(presentSocialLinks(null), { facebook: null, instagram: null, tiktok: null, youtube: null, website: null })) {
  problems.push('present: no links must give the five keys with null');
}
if (!same(presentSocialLinks({ facebook: 'https://facebook.com/a', evil: 'x', website: 7 }), { facebook: 'https://facebook.com/a', instagram: null, tiktok: null, youtube: null, website: null })) {
  problems.push('present: unknown keys and non-text values must never be answered');
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK ${GOOD.length} accepted, ${BAD.length} rejected`);
