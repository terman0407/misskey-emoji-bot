export class MisskeyApiError extends Error {
	constructor(endpoint, status, errorObj) {
		const code = errorObj?.error?.code ?? null;
		const apiMessage = errorObj?.error?.message ?? null;
		super(apiMessage ?? `${endpoint} HTTP ${status}`);
		this.name = 'MisskeyApiError';
		this.endpoint = endpoint;
		this.status = status;
		this.code = code;
		this.apiMessage = apiMessage;
		this.rawBody = errorObj;
	}
}

export class MisskeyNetworkError extends Error {
	constructor(endpoint, cause) {
		super(cause?.message ?? 'network error');
		this.name = 'MisskeyNetworkError';
		this.endpoint = endpoint;
		this.cause = cause;
	}
}

async function callApi(url, options, endpoint) {
	let res;
	try {
		res = await fetch(url, options);
	} catch (e) {
		throw new MisskeyNetworkError(endpoint, e);
	}
	if (!res.ok) {
		let body;
		try { body = await res.json(); } catch { body = null; }
		throw new MisskeyApiError(endpoint, res.status, body);
	}
	if (res.status === 204) return null;
	const text = await res.text();
	if (!text) return null;
	try { return JSON.parse(text); } catch { return text; }
}

export async function deleteDriveFile({ baseUrl, token, fileId }) {
	return callApi(`${baseUrl}/api/drive/files/delete`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ fileId }),
	}, 'drive/files/delete');
}

export async function uploadDriveFile({ baseUrl, token, data, name, contentType }) {
	const fd = new FormData();
	fd.append('file', new Blob([data], { type: contentType }), name);
	fd.append('name', name);
	fd.append('force', 'true');

	return callApi(`${baseUrl}/api/drive/files/create`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: fd,
	}, 'drive/files/create');
}

export async function listEmojis({ baseUrl, token, limit = 100, untilId }) {
	return callApi(`${baseUrl}/api/admin/emoji/list`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ limit, ...(untilId ? { untilId } : {}) }),
	}, 'admin/emoji/list');
}

// Returns distinct categories ordered by usage frequency (most-used first,
// ties broken alphabetically). Modal dropdowns cap at 25 options with no
// search, so the most-used categories should surface first.
export async function fetchAllCategories({ baseUrl, token }) {
	const counts = new Map();
	let untilId;
	for (let i = 0; i < 50; i++) {
		const page = await listEmojis({ baseUrl, token, limit: 100, untilId });
		if (!Array.isArray(page) || page.length === 0) break;
		for (const e of page) {
			if (e.category) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
		}
		if (page.length < 100) break;
		untilId = page[page.length - 1].id;
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([category]) => category);
}

export async function addEmoji({ baseUrl, token, fileId, name, category, aliases, license, isSensitive, localOnly }) {
	return callApi(`${baseUrl}/api/admin/emoji/add`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			fileId,
			name,
			category: category ?? null,
			aliases: aliases ?? [],
			license: license ?? null,
			isSensitive: isSensitive ?? false,
			localOnly: localOnly ?? false,
		}),
	}, 'admin/emoji/add');
}
