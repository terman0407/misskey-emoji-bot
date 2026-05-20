import { sanitizeEmojiName, isValidEmojiName } from './sanitize.js';
import { uploadDriveFile, addEmoji, MisskeyApiError, MisskeyNetworkError } from './misskey.js';

export const ALLOWED_TYPES = new Set([
	'image/png',
	'image/gif',
	'image/webp',
	'image/apng',
	'image/jpeg',
]);

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

function friendlyError(e) {
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

export async function registerEmojiFromAttachment({ attachment, meta, defaults, config }) {
	if (!ALLOWED_TYPES.has(attachment.contentType ?? '')) {
		return {
			ok: false,
			file: attachment.name,
			error: `対応していない画像形式です: \`${attachment.contentType ?? 'unknown'}\` (PNG/GIF/WEBP/APNG/JPEG のみ対応)`,
		};
	}

	const rawName = meta.name ?? attachment.name;
	const name = isValidEmojiName(rawName) ? rawName : sanitizeEmojiName(rawName);
	if (!isValidEmojiName(name)) {
		return {
			ok: false,
			file: attachment.name,
			error: `絵文字名を決められませんでした (元: \`${rawName}\`)。a-z 0-9 _ のみ使用可能なので手動で指定してください。`,
		};
	}

	const dlRes = await fetch(attachment.url).catch(e => ({ ok: false, status: 0, _err: e }));
	if (!dlRes.ok) {
		return {
			ok: false,
			file: attachment.name,
			error: `Discord から画像をダウンロードできませんでした (HTTP ${dlRes.status})`,
		};
	}
	const buffer = Buffer.from(await dlRes.arrayBuffer());

	try {
		const uploaded = await uploadDriveFile({
			baseUrl: config.baseUrl,
			token: config.token,
			buffer,
			name: attachment.name,
			contentType: attachment.contentType,
		});

		const emoji = await addEmoji({
			baseUrl: config.baseUrl,
			token: config.token,
			fileId: uploaded.id,
			name,
			category: meta.category ?? defaults.category ?? null,
			aliases: meta.aliases ?? [],
			license: meta.license ?? defaults.license ?? null,
			isSensitive: meta.isSensitive,
			localOnly: meta.localOnly,
		});

		return { ok: true, file: attachment.name, name: emoji.name, id: emoji.id };
	} catch (e) {
		console.error(`[misskey error] ${attachment.name}:`, e);
		return { ok: false, file: attachment.name, error: friendlyError(e) };
	}
}

export function formatResults(results) {
	return results.map(r => {
		if (r.ok) return `✅ \`${r.file}\` → \`:${r.name}:\``;
		return `❌ \`${r.file}\` — ${r.error}`;
	}).join('\n');
}
