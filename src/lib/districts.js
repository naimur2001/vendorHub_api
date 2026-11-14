// The 64 districts of Bangladesh as fixed keys (lowercase, URL-safe), grouped by division.
// The API only ever stores and sends the key; the frontend translates it to English and Bangla names.
import { z } from 'zod';

export const DISTRICTS = [
  // Barishal
  'barguna', 'barishal', 'bhola', 'jhalokathi', 'patuakhali', 'pirojpur',
  // Chattogram
  'bandarban', 'brahmanbaria', 'chandpur', 'chattogram', 'cumilla', 'coxs-bazar', 'feni',
  'khagrachhari', 'lakshmipur', 'noakhali', 'rangamati',
  // Dhaka
  'dhaka', 'faridpur', 'gazipur', 'gopalganj', 'kishoreganj', 'madaripur', 'manikganj',
  'munshiganj', 'narayanganj', 'narsingdi', 'rajbari', 'shariatpur', 'tangail',
  // Khulna
  'bagerhat', 'chuadanga', 'jashore', 'jhenaidah', 'khulna', 'kushtia', 'magura', 'meherpur',
  'narail', 'satkhira',
  // Mymensingh
  'jamalpur', 'mymensingh', 'netrokona', 'sherpur',
  // Rajshahi
  'bogura', 'joypurhat', 'naogaon', 'natore', 'chapainawabganj', 'pabna', 'rajshahi', 'sirajganj',
  // Rangpur
  'dinajpur', 'gaibandha', 'kurigram', 'lalmonirhat', 'nilphamari', 'panchagarh', 'rangpur',
  'thakurgaon',
  // Sylhet
  'habiganj', 'moulvibazar', 'sunamganj', 'sylhet',
];

export const DEFAULT_DISTRICT = 'dhaka';

// One key from the list. The message is fixed and never repeats what was sent.
export const districtKey = z.enum(DISTRICTS, { error: 'Use one of the 64 district keys, for example dhaka' });
