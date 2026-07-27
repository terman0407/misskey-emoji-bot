// Minimal ZIP reader.
//
// Discord rewrites image attachments — an uploaded APNG comes back off the CDN
// as a flattened static PNG (confirmed via the x-discord-transform-duration
// header). Archives are not touched, so wrapping the image in a .zip is the way
// to get the original bytes through intact. This reads just enough of the
// format to pull that one file back out.

const EOCD_SIG = 0x06054b50; // end of central directory
const CEN_SIG = 0x02014b50; // central directory entry
const LOC_SIG = 0x04034b50; // local file header

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const ZIP64_SENTINEL = 0xffffffff;
const MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function u16(b, o) {
	return b[o] | (b[o + 1] << 8);
}

function u32(b, o) {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function isZip(data) {
	const b = new Uint8Array(data);
	if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b) return false;
	// local file header (03 04), empty archive (05 06), or spanned (07 08)
	return (b[2] === 0x03 && b[3] === 0x04)
		|| (b[2] === 0x05 && b[3] === 0x06)
		|| (b[2] === 0x07 && b[3] === 0x08);
}

// The EOCD sits at the very end, but a trailing comment (up to 64 KiB) can push
// it back, so scan backwards for the signature.
function findEocd(b) {
	const limit = Math.max(0, b.length - (0xffff + 22));
	for (let i = b.length - 22; i >= limit; i--) {
		if (u32(b, i) === EOCD_SIG) return i;
	}
	return -1;
}

export function listZipEntries(data) {
	const b = new Uint8Array(data);
	const eocd = findEocd(b);
	if (eocd < 0) return { ok: false, error: 'ZIP の構造を読み取れませんでした (壊れている可能性があります)。' };

	const total = u16(b, eocd + 10);
	let off = u32(b, eocd + 16);
	if (u32(b, eocd + 12) === ZIP64_SENTINEL || off === ZIP64_SENTINEL) {
		return { ok: false, error: 'ZIP64 形式には対応していません。' };
	}

	const entries = [];
	for (let i = 0; i < Math.min(total, MAX_ENTRIES); i++) {
		if (off + 46 > b.length || u32(b, off) !== CEN_SIG) break;
		const flags = u16(b, off + 8);
		const method = u16(b, off + 10);
		const compressedSize = u32(b, off + 20);
		const uncompressedSize = u32(b, off + 24);
		const nameLen = u16(b, off + 28);
		const extraLen = u16(b, off + 30);
		const commentLen = u16(b, off + 32);
		const localOffset = u32(b, off + 42);
		const name = new TextDecoder().decode(b.subarray(off + 46, off + 46 + nameLen));

		entries.push({
			name,
			method,
			compressedSize,
			uncompressedSize,
			localOffset,
			encrypted: (flags & 0x1) !== 0,
		});
		off += 46 + nameLen + extraLen + commentLen;
	}
	return { ok: true, entries };
}

async function inflateRaw(bytes) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(b, entry, maxBytes) {
	if (entry.encrypted) return { ok: false, error: 'パスワード付き ZIP には対応していません。' };
	if (entry.uncompressedSize > maxBytes) {
		return { ok: false, error: `ZIP 内のファイルが大きすぎます (${Math.round(entry.uncompressedSize / 1024)} KB)。` };
	}

	const lo = entry.localOffset;
	if (lo + 30 > b.length || u32(b, lo) !== LOC_SIG) {
		return { ok: false, error: 'ZIP の構造を読み取れませんでした。' };
	}
	// Sizes in the local header may be zeroed when a data descriptor is used, so
	// always trust the central directory values captured in `entry`.
	const dataStart = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
	const raw = b.subarray(dataStart, dataStart + entry.compressedSize);

	if (entry.method === METHOD_STORED) return { ok: true, data: raw };
	if (entry.method !== METHOD_DEFLATE) {
		return { ok: false, error: `ZIP の圧縮方式 (method=${entry.method}) には対応していません。deflate か無圧縮で作成してください。` };
	}
	try {
		return { ok: true, data: await inflateRaw(raw) };
	} catch (e) {
		return { ok: false, error: `ZIP の展開に失敗しました: ${e.message ?? 'unknown'}` };
	}
}

const IMAGE_EXT_RE = /\.(png|apng|gif|webp|jpe?g)$/i;

function isJunk(name) {
	// Directory entries and the metadata folder macOS adds when zipping.
	return name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop().startsWith('._');
}

// Pull the first entry that the caller recognises as an image. `accept` receives
// the decoded bytes and returns a truthy value (the detected type) when the
// entry is usable, so this module stays free of image-format knowledge.
export async function extractImageFromZip(data, accept, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
	const listed = listZipEntries(data);
	if (!listed.ok) return listed;

	const usable = listed.entries.filter(e => !isJunk(e.name) && e.uncompressedSize > 0);
	if (usable.length === 0) return { ok: false, error: 'ZIP の中にファイルが見つかりませんでした。' };

	// Try entries whose name looks like an image first so a stray README or
	// license file doesn't cost us a needless inflate.
	usable.sort((a, b) => Number(IMAGE_EXT_RE.test(b.name)) - Number(IMAGE_EXT_RE.test(a.name)));

	const b = new Uint8Array(data);
	let lastError = null;
	for (const entry of usable) {
		const read = await readEntry(b, entry, maxBytes);
		if (!read.ok) {
			lastError = read.error;
			continue;
		}
		const detected = accept(read.data);
		if (detected) {
			return { ok: true, data: read.data, name: entry.name.split('/').pop(), contentType: detected };
		}
	}
	return {
		ok: false,
		error: lastError ?? 'ZIP の中に対応する画像が見つかりませんでした (PNG/GIF/WEBP/APNG/JPEG)。',
	};
}
