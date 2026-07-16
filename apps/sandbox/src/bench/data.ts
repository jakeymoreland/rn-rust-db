// --- Toy shape (4 short string fields, ~70 B/record) — kept for comparison ---

export function toyRows(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    email: `user${i}@bench.com`,
    name: `User ${i}`,
    city: i % 2 ? 'Sydney' : 'Perth',
    score: String(i),
  }));
  return JSON.stringify(rows);
}

// --- Realistic shape: ~22 mixed-type fields as they'd come from a CRM-style API,
// ~0.7-0.8 KB of JSON per record (ids/uuids, contact + address + billing fields,
// ISO timestamps, booleans, numeric amounts, a ~300-char notes field). ---

const FIRST = ['Olivia', 'Liam', 'Amelia', 'Noah', 'Isla', 'Jack', 'Charlotte', 'Oliver', 'Mia', 'William', 'Grace', 'Henry', 'Ava', 'Thomas', 'Ruby', 'James', 'Sophie', 'Lucas', 'Zoe', 'Ethan'];
const LAST = ['Nguyen', 'Smith', 'Papadopoulos', 'Chen', 'Williams', 'Singh', 'Brown', 'Kowalski', 'Taylor', 'Ivanova', 'Jones', 'Fernandez', 'Wilson', 'Okafor', 'Anderson', 'Kim', 'White', 'Rossi', 'Martin', 'Schmidt'];
const STREETS = ['George St', 'Collins Ave', 'Hay St', 'King William Rd', 'Elizabeth Dr', 'Flinders Ln', 'Murray Pl', 'Adelaide Tce'];
const CITIES = ['Sydney', 'Melbourne', 'Perth', 'Brisbane', 'Adelaide', 'Hobart', 'Darwin', 'Canberra'];
const STATES = ['NSW', 'VIC', 'WA', 'QLD', 'SA', 'TAS', 'NT', 'ACT'];
const COMPANIES = ['Acme Health Group', 'Southern Cross Logistics', 'Initial Studios', 'Bluegum Financial', 'Harbour Medical Partners', 'Terra Analytics', 'Redback Insurance', 'Coastline Retail Co'];
const TITLES = ['Account Manager', 'Practice Coordinator', 'Finance Analyst', 'Operations Lead', 'Registered Nurse', 'Claims Assessor', 'Sales Director', 'Support Engineer'];
const STATUSES = ['active', 'pending_review', 'churn_risk', 'onboarding', 'suspended'];
const NOTE_SEED =
  'Follow-up scheduled after quarterly account review; customer expressed interest in the premium reporting module and asked about API rate limits, invoice consolidation across the two billing entities, and migration timelines for the legacy portal. ';

function hex(v: number, width: number): string {
  return (v >>> 0).toString(16).padStart(width, '0').slice(-width);
}

// `salt` shifts the natural keys (a different batch of records); `rev` changes
// only the field content for the same keys (an update wave over existing rows).
// `startIndex` offsets the row index so chunked builds produce byte-identical
// rows to one big build.
export function realisticRows(n: number, salt = 0, rev = 0, startIndex = 0): string {
  const rows = new Array(n);
  for (let r = 0; r < n; r++) {
    const i = startIndex + r; // row identity; r is the slot in this chunk
    const s = i + salt * 1_000_003 + rev * 7_368_787;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const ci = (i * 13) % CITIES.length;
    const created = new Date(1735689600000 + (s % 500) * 86_400_000 + (s % 86_400) * 1000).toISOString();
    const updated = new Date(1750000000000 + (s % 200) * 3_600_000).toISOString();
    rows[r] = {
      id: `rec_${salt}_${String(i).padStart(7, '0')}`,
      uuid: `${hex(s * 2654435761, 8)}-${hex(s * 40503, 4)}-4${hex(s * 2246822519, 3)}-9${hex(s * 3266489917, 3)}-${hex(s * 668265263, 8)}${hex(s * 374761393, 4)}`,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example${i % 9}.com.au`,
      phone: `+61 4${String(10_000_000 + ((s * 97) % 89_999_999)).slice(0, 8)}`,
      address_line1: `${(s % 380) + 1} ${STREETS[(i * 3) % STREETS.length]}`,
      address_city: CITIES[ci],
      address_state: STATES[ci],
      address_postcode: String(2000 + ((s * 31) % 6999)),
      billing_city: CITIES[(ci + 3) % CITIES.length],
      billing_postcode: String(2000 + ((s * 53) % 6999)),
      company: COMPANIES[(i * 5) % COMPANIES.length],
      job_title: TITLES[(i * 11) % TITLES.length],
      status: STATUSES[i % STATUSES.length],
      is_active: i % 7 !== 0,
      email_verified: i % 3 !== 0,
      balance: Math.round(((s * 137) % 2_500_000)) / 100,
      lifetime_value: Math.round(((s * 631) % 90_000_000)) / 100,
      currency: 'AUD',
      created_at: created,
      updated_at: updated,
      notes: `[case ${hex(s * 2654435761, 6)}] ${NOTE_SEED}${NOTE_SEED.slice(0, 60 + (i % 40))}`,
    };
  }
  return JSON.stringify(rows);
}

// Builds the same JSON as realisticRows(n, salt, rev) but in 10k-row chunks,
// yielding to the event loop between chunks so a 100k build (~75 MB) doesn't
// freeze the UI in one multi-second block. Byte-identical output.
export async function realisticRowsChunked(n: number, salt = 0, rev = 0): Promise<string> {
  const CHUNK = 10_000;
  if (n <= CHUNK) return realisticRows(n, salt, rev);
  const parts: string[] = [];
  for (let start = 0; start < n; start += CHUNK) {
    const size = Math.min(CHUNK, n - start);
    // strip the surrounding [] so chunks can be joined into one array
    parts.push(realisticRows(size, salt, rev, start).slice(1, -1));
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return `[${parts.join(',')}]`;
}

// If 100k realistic rows (~75 MB JSON) proves too slow / OOMs on the Android
// emulator, drop this to [1000, 10000, 50000] and note it in BENCHMARKS.md.
export const REALISTIC_SIZES = [1000, 10000, 100000];

// Field list for the schema-packed query path, matching realisticRows.
export const REALISTIC_FIELDS = [
  'id', 'uuid', 'first_name', 'last_name', 'email', 'phone',
  'address_line1', 'address_city', 'address_state', 'address_postcode',
  'billing_city', 'billing_postcode', 'company', 'job_title', 'status',
  'is_active', 'email_verified', 'balance', 'lifetime_value', 'currency',
  'created_at', 'updated_at', 'notes',
] as const;
export const REALISTIC_FIELDS_CSV = REALISTIC_FIELDS.join(',');
