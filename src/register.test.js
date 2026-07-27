import {
	normalizeContentType,
	ALLOWED_TYPES,
	isApng,
	sniffImageType,
	publicContentType,
} from './register.js';

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

// --- byte-level format detection ---
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// length (4B big-endian) + type (4B) + zeroed data + CRC (4B)
function chunk(type, dataLen = 0) {
	const out = [(dataLen >>> 24) & 0xff, (dataLen >>> 16) & 0xff, (dataLen >>> 8) & 0xff, dataLen & 0xff];
	for (const ch of type) out.push(ch.charCodeAt(0));
	for (let i = 0; i < dataLen; i++) out.push(0);
	out.push(0, 0, 0, 0);
	return out;
}

const staticPng = new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13), ...chunk('IDAT', 4)]);
const animatedPng = new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13), ...chunk('acTL', 8), ...chunk('fcTL', 26), ...chunk('IDAT', 4)]);
// acTL after IDAT is not a valid animation — must not be treated as APNG.
const acTLAfterIdat = new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13), ...chunk('IDAT', 4), ...chunk('acTL', 8)]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const notAnImage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

function check(actual, expected, label) {
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} ${label} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
	if (!ok) fail++;
}

check(isApng(animatedPng), true, 'isApng(animated .png)');
check(isApng(staticPng), false, 'isApng(static png)');
check(isApng(acTLAfterIdat), false, 'isApng(acTL after IDAT)');
check(isApng(gif), false, 'isApng(gif)');
check(isApng(new Uint8Array([])), false, 'isApng(empty)');

// The point of this change: an animated file named .png is detected as APNG.
check(sniffImageType(animatedPng), 'image/apng', 'sniff(animated .png)');
check(sniffImageType(staticPng), 'image/png', 'sniff(static png)');
check(sniffImageType(gif), 'image/gif', 'sniff(gif)');
check(sniffImageType(jpeg), 'image/jpeg', 'sniff(jpeg)');
check(sniffImageType(webp), 'image/webp', 'sniff(webp)');
check(sniffImageType(notAnImage), null, 'sniff(zip) → null');

// Everything sniffed must be registerable.
for (const [label, bytes] of [['animated png', animatedPng], ['static png', staticPng], ['gif', gif], ['jpeg', jpeg], ['webp', webp]]) {
	check(ALLOWED_TYPES.has(sniffImageType(bytes)), true, `allowed(sniffed ${label})`);
}

// APNG is served as image/png publicly so previews render; other types pass through.
check(publicContentType('image/apng'), 'image/png', 'publicContentType(apng)');
check(publicContentType('image/gif'), 'image/gif', 'publicContentType(gif)');

if (fail > 0) {
	console.error(`\n${fail} test(s) failed`);
	process.exit(1);
}
console.log('\nall tests passed');
