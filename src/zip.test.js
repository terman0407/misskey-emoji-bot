import { isZip, listZipEntries, extractImageFromZip } from './zip.js';
import { sniffImageType } from './register.js';

let fail = 0;
function check(actual, expected, label) {
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} ${label} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
	if (!ok) fail++;
}

// --- fixtures: a minimal animated PNG (acTL before IDAT) and a static one ---
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function chunk(type, dataLen = 0) {
	const out = [(dataLen >>> 24) & 0xff, (dataLen >>> 16) & 0xff, (dataLen >>> 8) & 0xff, dataLen & 0xff];
	for (const ch of type) out.push(ch.charCodeAt(0));
	for (let i = 0; i < dataLen; i++) out.push(0x5a);
	out.push(0, 0, 0, 0);
	return out;
}
const apng = new Uint8Array([...PNG_SIG, ...chunk('IHDR', 13), ...chunk('acTL', 8), ...chunk('fcTL', 26), ...chunk('IDAT', 64), ...chunk('fdAT', 64), ...chunk('IEND')]);
const textFile = new TextEncoder().encode('this is not an image, just a readme');

// --- minimal zip writer (stored + deflate) so the test needs no fixtures on disk ---
function crc32(buf) {
	let c, crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = (crc ^ buf[i]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function w16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function w32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

async function buildZip(entries) {
	const body = [];
	const central = [];
	let offset = 0;
	for (const e of entries) {
		const nameBytes = [...new TextEncoder().encode(e.name)];
		const stored = e.method === 0;
		const payload = stored ? e.data : await deflateRaw(e.data);
		const crc = crc32(e.data);
		const local = [
			...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(e.method), ...w16(0), ...w16(0),
			...w32(crc), ...w32(payload.length), ...w32(e.data.length),
			...w16(nameBytes.length), ...w16(0), ...nameBytes,
		];
		body.push(...local, ...payload);
		central.push(...[
			...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0), ...w16(e.method), ...w16(0), ...w16(0),
			...w32(crc), ...w32(payload.length), ...w32(e.data.length),
			...w16(nameBytes.length), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(0),
			...w32(offset), ...nameBytes,
		]);
		offset += local.length + payload.length;
	}
	const eocd = [
		...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(entries.length), ...w16(entries.length),
		...w32(central.length), ...w32(offset), ...w16(0),
	];
	return new Uint8Array([...body, ...central, ...eocd]);
}

function sameBytes(a, b) {
	const x = new Uint8Array(a), y = new Uint8Array(b);
	if (x.length !== y.length) return false;
	return x.every((v, i) => v === y[i]);
}

// --- isZip ---
check(isZip(await buildZip([{ name: 'a.apng', data: apng, method: 0 }])), true, 'isZip(zip)');
check(isZip(apng), false, 'isZip(png) → false');
check(isZip(new Uint8Array([0x50, 0x4b])), false, 'isZip(too short) → false');

// --- stored (method 0) ---
{
	const zip = await buildZip([{ name: 'inner.apng', data: apng, method: 0 }]);
	const listed = listZipEntries(zip);
	check(listed.ok, true, 'listZipEntries(stored).ok');
	check(listed.entries?.length, 1, 'stored entry count');
	const r = await extractImageFromZip(zip, sniffImageType);
	check(r.ok, true, 'extract(stored).ok');
	check(r.contentType, 'image/apng', 'extract(stored) type');
	check(r.name, 'inner.apng', 'extract(stored) name');
	check(sameBytes(r.data, apng), true, 'extract(stored) byte-identical');
}

// --- deflate (method 8) — what Windows/macOS zip tools produce ---
{
	const zip = await buildZip([{ name: 'inner.apng', data: apng, method: 8 }]);
	const r = await extractImageFromZip(zip, sniffImageType);
	check(r.ok, true, 'extract(deflate).ok');
	check(r.contentType, 'image/apng', 'extract(deflate) type');
	check(sameBytes(r.data, apng), true, 'extract(deflate) byte-identical');
}

// --- junk entries are skipped, nested path yields the basename ---
{
	const zip = await buildZip([
		{ name: '__MACOSX/._inner.apng', data: textFile, method: 0 },
		{ name: 'README.txt', data: textFile, method: 8 },
		{ name: 'art/inner.apng', data: apng, method: 8 },
	]);
	const r = await extractImageFromZip(zip, sniffImageType);
	check(r.ok, true, 'extract(multi).ok');
	check(r.name, 'inner.apng', 'extract(multi) basename only');
	check(sameBytes(r.data, apng), true, 'extract(multi) picked the image');
}

// --- a zip with no image is a clear failure, not a crash ---
{
	const zip = await buildZip([{ name: 'notes.txt', data: textFile, method: 8 }]);
	const r = await extractImageFromZip(zip, sniffImageType);
	check(r.ok, false, 'extract(no image).ok → false');
	check(typeof r.error === 'string' && r.error.length > 0, true, 'extract(no image) has error text');
}

// --- oversized entries are refused rather than inflated ---
{
	const zip = await buildZip([{ name: 'inner.apng', data: apng, method: 8 }]);
	const r = await extractImageFromZip(zip, sniffImageType, { maxBytes: 10 });
	check(r.ok, false, 'extract(over maxBytes).ok → false');
}

// --- garbage input degrades gracefully ---
check(listZipEntries(new Uint8Array(40)).ok, false, 'listZipEntries(garbage) → not ok');

if (fail > 0) {
	console.error(`\n${fail} test(s) failed`);
	process.exit(1);
}
console.log('\nall tests passed');
