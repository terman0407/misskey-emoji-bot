const TTL_SECONDS = 7 * 24 * 60 * 60;

export function newKey() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export async function put(kv, key, value, ttlSeconds = TTL_SECONDS) {
	await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}

export async function peek(kv, key) {
	return await kv.get(key, 'json');
}

export async function update(kv, key, mutator, ttlSeconds = TTL_SECONDS) {
	const current = await peek(kv, key);
	if (!current) return null;
	const updated = mutator(current);
	await put(kv, key, updated, ttlSeconds);
	return updated;
}

export async function remove(kv, key) {
	const current = await peek(kv, key);
	await kv.delete(key);
	return current;
}
