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
	return res.json();
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
