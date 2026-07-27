import { sanitizeEmojiName, isValidEmojiName } from './sanitize.js';
import { uploadDriveFile, addEmoji, deleteDriveFile, MisskeyApiError, MisskeyNetworkError } from './misskey.js';

export const ALLOWED_TYPES = new Set([
	'image/png',
	'image/gif',
	'image/webp',
	'image/apng',
	'image/jpeg',
]);

// Archives are accepted so an image can be smuggled past Discord's image
// transform (which flattens APNG) by zipping it; the contents are validated by
// magic bytes after extraction. octet-stream is included because clients fall
// back to it for extensions they don't recognise — the byte check is what
// actually decides, so a generic type is safe to let through to the download.
export const CONTAINER_TYPES = new Set([
	'application/zip',
	'application/x-zip-compressed',
	'application/zip-compressed',
	'application/octet-stream',
]);

export function isAcceptedUploadType(contentType) {
	const t = normalizeContentType(contentType);
	return ALLOWED_TYPES.has(t) || CONTAINER_TYPES.has(t);
}

// Discord reports APNG uploads with the legacy Mozilla MIME type, and some
// clients send JPEG as image/jpg. Map those onto the canonical types so the
// allow-list check passes and Misskey receives a type it recognises.
const CONTENT_TYPE_ALIASES = {
	'image/vnd.mozilla.apng': 'image/apng',
	'image/x-apng': 'image/apng',
	'image/jpg': 'image/jpeg',
	'image/pjpeg': 'image/jpeg',
};

export function normalizeContentType(contentType) {
	// Strip any parameters (e.g. "image/png; charset=binary") and normalize case.
	const base = String(contentType ?? '').split(';')[0].trim().toLowerCase();
	return CONTENT_TYPE_ALIASES[base] ?? base;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// An animated PNG is a plain PNG carrying an `acTL` (animation control) chunk
// before the first `IDAT`. Extension and MIME can't distinguish it — a .png
// file uploaded from Discord arrives as image/png either way — so walk the
// chunk list and look for it.
export function isApng(data) {
	const b = new Uint8Array(data);
	if (b.length < PNG_SIGNATURE.length) return false;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (b[i] !== PNG_SIGNATURE[i]) return false;
	}
	// Each chunk is: length (4B, big-endian) + type (4B) + data + CRC (4B).
	let off = PNG_SIGNATURE.length;
	while (off + 8 <= b.length) {
		const len = ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
		const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
		if (type === 'acTL') return true;
		// acTL must precede IDAT; once pixel data starts it's a static PNG.
		if (type === 'IDAT') return false;
		off += 12 + len;
	}
	return false;
}

// Identify the real format from magic bytes. Used after download so a
// mislabelled attachment (wrong or generic MIME from the client) is judged on
// content rather than on what Discord claimed. Returns null if the bytes are
// not one of the formats we support.
export function sniffImageType(data) {
	const b = new Uint8Array(data);
	const startsWith = bytes => bytes.every((v, i) => b[i] === v);

	if (startsWith(PNG_SIGNATURE)) return isApng(data) ? 'image/apng' : 'image/png';
	if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
	if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
	// WEBP: "RIFF" .... "WEBP"
	if (startsWith([0x52, 0x49, 0x46, 0x46])
		&& b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
	return null;
}

// APNG is conventionally served as image/png on the web, so label the public R2
// object that way to keep the approval-embed preview rendering everywhere.
// Misskey re-detects the animation from the bytes, so nothing is lost.
export function publicContentType(contentType) {
	return contentType === 'image/apng' ? 'image/png' : contentType;
}

const FRIENDLY_BY_CODE = {
	DUPLICATE_NAME: '同じ名前のカスタム絵文字が既に登録されています。別の名前に変更してください。',
	UNSUPPORTED_FILE_TYPE: 'Misskey が対応していない画像形式です。',
	NO_SUCH_FILE: 'アップロードしたファイルを Misskey 側で見つけられませんでした。再申請してみてください。',
	INAPPROPRIATE: 'Misskey によって不適切な内容を含む可能性があると判定されたため拒否されました。',
	NO_FREE_SPACE: 'Misskey ドライブの空き容量が不足しています。',
	MAX_FILE_SIZE_EXCEEDED: 'ファイルサイズが Misskey の上限を超えています。',
	UNALLOWED_FILE_TYPE: 'Misskey で許可されていないファイル形式です。',
	INVALID_FILE_NAME: 'ファイル名が不正です。',
	RATE_LIMIT_EXCEEDED: 'Misskey 側のレート制限に達しました。しばらく待ってからやり直してください。',
};

export function friendlyMisskeyError(e) {
	if (e instanceof MisskeyApiError) {
		if (e.code && FRIENDLY_BY_CODE[e.code]) return FRIENDLY_BY_CODE[e.code];
		if (e.status === 401 || e.status === 403) {
			return 'Misskey 認証エラー — Bot のトークン or 権限を確認してください。';
		}
		if (e.status >= 500) return `Misskey サーバーエラー (HTTP ${e.status})`;
		if (e.apiMessage) return `Misskey: ${e.apiMessage}${e.code ? ` (${e.code})` : ''}`;
		return `Misskey API エラー (HTTP ${e.status})`;
	}
	if (e instanceof MisskeyNetworkError) {
		return `Misskey に接続できませんでした (${e.message})`;
	}
	return e?.message ?? '不明なエラー';
}

export async function downloadAndUploadToDrive({ attachment, config }) {
	const dl = await downloadAttachment(attachment);
	if (!dl.ok) return dl;
	return uploadBufferToDrive({ data: dl.data, name: attachment.name, contentType: attachment.contentType, config });
}

export async function downloadAttachment(attachment) {
	if (!isAcceptedUploadType(attachment.contentType)) {
		return {
			ok: false,
			error: `対応していない形式です: \`${attachment.contentType ?? 'unknown'}\` (PNG/GIF/WEBP/APNG/JPEG、または ZIP)`,
		};
	}
	const dlRes = await fetch(attachment.url).catch(e => ({ ok: false, status: 0, _err: e }));
	if (!dlRes.ok) {
		return {
			ok: false,
			error: `Discord から画像をダウンロードできませんでした (HTTP ${dlRes.status})`,
		};
	}
	return { ok: true, data: await dlRes.arrayBuffer() };
}

export async function uploadBufferToDrive({ data, name, contentType, config }) {
	try {
		const uploaded = await uploadDriveFile({
			baseUrl: config.baseUrl,
			token: config.token,
			data,
			name,
			contentType,
		});
		return { ok: true, fileId: uploaded.id, url: uploaded.url, name: uploaded.name };
	} catch (e) {
		console.error(`[drive upload error] ${name}:`, e);
		return { ok: false, error: friendlyMisskeyError(e) };
	}
}

export async function registerEmojiByFileId({ fileId, meta, defaults, config }) {
	const rawName = meta.name;
	const name = isValidEmojiName(rawName) ? rawName : sanitizeEmojiName(rawName ?? '');
	if (!isValidEmojiName(name)) {
		return {
			ok: false,
			error: `絵文字名を決められませんでした (元: \`${rawName}\`)。a-z 0-9 _ のみ使用可能なので手動で指定してください。`,
		};
	}
	try {
		const emoji = await addEmoji({
			baseUrl: config.baseUrl,
			token: config.token,
			fileId,
			name,
			category: meta.category ?? defaults.category ?? null,
			aliases: meta.aliases ?? [],
			license: meta.license ?? defaults.license ?? null,
			isSensitive: meta.isSensitive,
			localOnly: meta.localOnly,
		});
		return { ok: true, name: emoji.name, id: emoji.id };
	} catch (e) {
		console.error('[admin/emoji/add error]', e);
		return { ok: false, error: friendlyMisskeyError(e) };
	}
}

export async function cleanupDriveFile({ fileId, config }) {
	if (!fileId) return;
	try {
		await deleteDriveFile({ baseUrl: config.baseUrl, token: config.token, fileId });
	} catch (e) {
		console.error(`[drive delete] fileId=${fileId}`, e);
	}
}
