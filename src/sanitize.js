const EMOJI_NAME_RE = /^[a-zA-Z0-9_]+$/;

export function sanitizeEmojiName(input) {
	if (!input) return '';
	const base = input.replace(/\.[^.]+$/, '');
	return base
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
}

export function isValidEmojiName(name) {
	return typeof name === 'string' && name.length > 0 && EMOJI_NAME_RE.test(name);
}

export function parseMessageMeta(content) {
	const result = {};
	if (!content) return result;
	for (const rawLine of content.split('\n')) {
		const m = rawLine.match(/^\s*([a-zA-Z]+)\s*[:=]\s*(.+?)\s*$/);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const value = m[2];
		switch (key) {
			case 'name':
				result.name = value;
				break;
			case 'category':
			case 'cat':
				result.category = value;
				break;
			case 'tags':
			case 'aliases':
			case 'tag':
				result.aliases = value.split(/[,、]/).map(s => s.trim()).filter(Boolean);
				break;
			case 'license':
				result.license = value;
				break;
			case 'sensitive':
			case 'nsfw':
				result.isSensitive = /^(true|yes|1|on)$/i.test(value);
				break;
			case 'localonly':
			case 'local':
				result.localOnly = /^(true|yes|1|on)$/i.test(value);
				break;
		}
	}
	return result;
}
