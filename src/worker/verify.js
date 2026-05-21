function hexToBytes(hex) {
	const len = hex.length / 2;
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		out[i] = parseInt(hex.substr(i * 2, 2), 16);
	}
	return out;
}

export async function verifyDiscordRequest(request, publicKeyHex) {
	const signature = request.headers.get('x-signature-ed25519');
	const timestamp = request.headers.get('x-signature-timestamp');
	if (!signature || !timestamp) return { valid: false, body: '' };

	const body = await request.text();
	const message = new TextEncoder().encode(timestamp + body);

	const key = await crypto.subtle.importKey(
		'raw',
		hexToBytes(publicKeyHex),
		{ name: 'Ed25519' },
		false,
		['verify'],
	);
	const valid = await crypto.subtle.verify(
		{ name: 'Ed25519' },
		key,
		hexToBytes(signature),
		message,
	);
	return { valid, body };
}
