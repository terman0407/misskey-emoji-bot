import { normalizeContentType, ALLOWED_TYPES } from './register.js';

const cases = [
	// The reported bug: Discord sends APNG as the legacy Mozilla MIME type.
	['image/vnd.mozilla.apng', 'image/apng'],
	['image/x-apng', 'image/apng'],
	// Common JPEG variants.
	['image/jpg', 'image/jpeg'],
	['image/pjpeg', 'image/jpeg'],
	// Canonical types pass through unchanged.
	['image/png', 'image/png'],
	['image/gif', 'image/gif'],
	['image/webp', 'image/webp'],
	['image/apng', 'image/apng'],
	['image/jpeg', 'image/jpeg'],
	// Parameters stripped, case normalized, whitespace trimmed.
	['image/PNG', 'image/png'],
	['image/png; charset=binary', 'image/png'],
	['  image/vnd.mozilla.apng  ', 'image/apng'],
	// Unknown / missing types are returned as-is (and will fail the allow-list).
	['application/octet-stream', 'application/octet-stream'],
	[undefined, ''],
	[null, ''],
];

let fail = 0;
for (const [input, expected] of cases) {
	const actual = normalizeContentType(input);
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} normalizeContentType(${JSON.stringify(input)}) = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
	if (!ok) fail++;
}

// The whole point: the reported type must now pass the allow-list.
const gate = [
	['image/vnd.mozilla.apng', true],
	['image/jpg', true],
	['image/png', true],
	['application/octet-stream', false],
	['text/plain', false],
	[undefined, false],
];
for (const [input, expected] of gate) {
	const actual = ALLOWED_TYPES.has(normalizeContentType(input));
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} allowed(${JSON.stringify(input)}) = ${actual} (expected ${expected})`);
	if (!ok) fail++;
}

if (fail > 0) {
	console.error(`\n${fail} test(s) failed`);
	process.exit(1);
}
console.log('\nall tests passed');
