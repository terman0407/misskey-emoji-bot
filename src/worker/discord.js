const DISCORD_API = 'https://discord.com/api/v10';

export const InteractionType = {
	PING: 1,
	APPLICATION_COMMAND: 2,
	MESSAGE_COMPONENT: 3,
	APPLICATION_COMMAND_AUTOCOMPLETE: 4,
	MODAL_SUBMIT: 5,
};

export const InteractionResponseType = {
	PONG: 1,
	CHANNEL_MESSAGE_WITH_SOURCE: 4,
	DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
	DEFERRED_UPDATE_MESSAGE: 6,
	UPDATE_MESSAGE: 7,
	APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
	MODAL: 9,
};

export const ComponentType = {
	ACTION_ROW: 1,
	BUTTON: 2,
	STRING_SELECT: 3,
	TEXT_INPUT: 4,
	LABEL: 18,
	CHECKBOX_GROUP: 22,
};

export const ButtonStyle = {
	PRIMARY: 1,
	SECONDARY: 2,
	SUCCESS: 3,
	DANGER: 4,
	LINK: 5,
};

export const TextInputStyle = {
	SHORT: 1,
	PARAGRAPH: 2,
};

export const MessageFlags = {
	EPHEMERAL: 1 << 6,
};

export function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

export async function discordRest(token, method, path, body) {
	const res = await fetch(`${DISCORD_API}${path}`, {
		method,
		headers: {
			Authorization: `Bot ${token}`,
			'content-type': 'application/json',
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Discord ${method} ${path} ${res.status}: ${text}`);
	}
	return res.status === 204 ? null : res.json();
}

export function patchMessage(token, channelId, messageId, body) {
	return discordRest(token, 'PATCH', `/channels/${channelId}/messages/${messageId}`, body);
}

export function postMessage(token, channelId, body) {
	return discordRest(token, 'POST', `/channels/${channelId}/messages`, body);
}

// Discord auto-converts a typed `@username` into a `<@id>` mention token in
// slash-command string options whenever it matches a guild member. A submitter
// crediting a Misskey user `@name@host` therefore ends up sending us
// `<@id>@host`. Turn those tokens back into `@username` using the interaction's
// resolved users so the original handle survives into Misskey.
export function unwrapUserMentions(text, resolved) {
	if (text == null) return text;
	return String(text).replace(/<@!?(\d+)>/g, (full, id) => {
		const u = resolved?.users?.[id];
		const name = u?.username ?? u?.global_name;
		return name ? `@${name}` : full;
	});
}

export function inlineCode(value) {
	const s = String(value ?? '').replace(/`/g, "'").trim();
	return '`' + (s.length ? s : '(未設定)') + '`';
}

export function buildApprovalEmbed(key, state) {
	const m = state.meta;
	const lines = [
		`**Name:**     ${inlineCode(m.name)}`,
		`**Category:** ${inlineCode(m.category)}`,
		`**Tags:**     ${m.aliases?.length ? m.aliases.map(t => inlineCode(t)).join(', ') : '`(なし)`'}`,
		`**License:**  ${inlineCode(m.license)}`,
		`**Sensitive:** ${m.isSensitive ? 'yes' : 'no'}  /  **LocalOnly:** ${m.localOnly ? 'yes' : 'no'}`,
	];

	const status = state.status;
	const color = status === 'pending' ? 0xffaa00
		: status === 'approved' ? 0x44cc44
		: status === 'rejected' ? 0xcc4444
		: status === 'cancelled' ? 0x888888
		: 0x888888;
	const title = status === 'pending' ? '📥 絵文字登録リクエスト'
		: status === 'approved' ? `✅ 登録完了 → \`:${state.registeredName ?? m.name}:\``
		: status === 'rejected' ? '❌ 却下'
		: status === 'cancelled' ? '🚫 取り消し'
		: '⚠️ エラー';

	const fields = [
		{ name: '申請者', value: inlineCode(`${state.submitterTag} (${state.submitterId})`), inline: true },
	];
	if (status === 'approved' && state.approverTag) {
		fields.push({ name: '承認者', value: inlineCode(state.approverTag), inline: false });
	}
	if (status === 'rejected' && state.approverTag) {
		fields.push({ name: '却下者', value: inlineCode(state.approverTag), inline: false });
	}
	if (state.error) {
		fields.push({ name: 'エラー', value: '```' + state.error.slice(0, 500).replace(/```/g, "'''") + '```' });
	}

	return {
		color,
		title,
		description: lines.join('\n'),
		image: { url: state.attachment.url },
		footer: { text: `request_id: ${key}` },
		fields,
	};
}

export function buildSubmitterReceiptButtons(key) {
	return {
		type: ComponentType.ACTION_ROW,
		components: [
			{ type: ComponentType.BUTTON, custom_id: `emoji-edit:${key}`, label: '編集', emoji: { name: '✏️' }, style: ButtonStyle.SECONDARY },
			{ type: ComponentType.BUTTON, custom_id: `emoji-cancel:${key}`, label: '取り消し', emoji: { name: '🚫' }, style: ButtonStyle.DANGER },
		],
	};
}

export function buildApprovalButtons(key, status = 'pending') {
	if (status !== 'pending') {
		return {
			type: ComponentType.ACTION_ROW,
			components: [{
				type: ComponentType.BUTTON,
				custom_id: `emoji-noop:${key}`,
				label: '処理済み',
				style: ButtonStyle.SECONDARY,
				disabled: true,
			}],
		};
	}
	return {
		type: ComponentType.ACTION_ROW,
		components: [
			{ type: ComponentType.BUTTON, custom_id: `emoji-approve:${key}`, label: '承認', emoji: { name: '✅' }, style: ButtonStyle.SUCCESS },
			{ type: ComponentType.BUTTON, custom_id: `emoji-reject:${key}`, label: '却下', emoji: { name: '❌' }, style: ButtonStyle.DANGER },
			{ type: ComponentType.BUTTON, custom_id: `emoji-edit:${key}`, label: '編集', emoji: { name: '✏️' }, style: ButtonStyle.SECONDARY },
		],
	};
}

// A text input (type 4) wrapped in a Label (type 18). In the current modal
// component system the label/description live on the Label wrapper, not on the
// input itself.
function labelText(customId, label, opts = {}) {
	const input = {
		type: ComponentType.TEXT_INPUT,
		custom_id: customId,
		style: opts.style ?? TextInputStyle.SHORT,
		required: opts.required ?? false,
	};
	if (opts.max_length) input.max_length = opts.max_length;
	if (opts.value !== undefined && opts.value !== null && opts.value !== '') input.value = opts.value;
	if (opts.placeholder) input.placeholder = opts.placeholder;
	const wrap = { type: ComponentType.LABEL, label, component: input };
	if (opts.description) wrap.description = opts.description;
	return wrap;
}

// A string select (type 3) wrapped in a Label (type 18) — only valid inside modals.
function labelSelect(customId, label, options, opts = {}) {
	const select = {
		type: ComponentType.STRING_SELECT,
		custom_id: customId,
		placeholder: opts.placeholder ?? '選択',
		required: opts.required ?? false,
		min_values: opts.min_values ?? 0,
		max_values: opts.max_values ?? 1,
		options,
	};
	const wrap = { type: ComponentType.LABEL, label, component: select };
	if (opts.description) wrap.description = opts.description;
	return wrap;
}

// sensitive/localonly are exposed as a Checkbox Group (type 22), wrapped in a
// Label, with the current values pre-checked.
export const FLAG_SENSITIVE = 'sensitive';
export const FLAG_LOCALONLY = 'localonly';

function flagsCheckboxes(meta) {
	return {
		type: ComponentType.LABEL,
		label: 'オプション',
		description: '該当するものにチェック (任意)',
		component: {
			type: ComponentType.CHECKBOX_GROUP,
			custom_id: 'options',
			required: false,
			min_values: 0,
			max_values: 2,
			options: [
				{ label: 'センシティブ (NSFW)', value: FLAG_SENSITIVE, default: !!meta?.isSensitive },
				{ label: 'ローカル限定 (連合しない)', value: FLAG_LOCALONLY, default: !!meta?.localOnly },
			],
		},
	};
}

// Build select options from the category list, capped at Discord's 25-option
// limit. `current` (if given) is guaranteed to be present and pre-selected.
export function buildCategoryOptions(categories, current = null) {
	const cats = [];
	const seen = new Set();
	for (const c of categories ?? []) {
		if (!c || seen.has(c)) continue;
		seen.add(c);
		cats.push(c);
	}
	if (current && !seen.has(current)) cats.unshift(current);
	return cats.slice(0, 25).map(c => {
		const value = c.slice(0, 100);
		const opt = { label: value, value };
		if (current && c === current) opt.default = true;
		return opt;
	});
}

// Only the image comes from the slash command. The modal carries everything
// else, capped at Discord's 5-component modal limit:
// name + category select + tags + license + options.
export function buildAddModal(addKey, categories) {
	const options = buildCategoryOptions(categories, null);
	const components = [
		labelText('name', '絵文字名 (小文字 a-z 0-9 _、大文字不可)', {
			max_length: 128,
			placeholder: '空欄ならファイル名から生成 (例: kawaii_neko)',
		}),
	];
	if (options.length) {
		components.push(labelSelect('category_select', 'カテゴリ', options, {
			placeholder: 'カテゴリを選択',
		}));
	} else {
		// No categories exist yet — fall back to free text so something can be set.
		components.push(labelText('category_new', 'カテゴリ', {
			required: true,
			max_length: 128,
			placeholder: '例: animal, food, kawaii',
		}));
	}
	components.push(labelText('tags', 'タグ (カンマ区切り)', { max_length: 256 }));
	components.push(labelText('license', 'ライセンス', {
		max_length: 256,
		placeholder: '入力した内容はそのまま登録されます (@user@host も可)',
	}));
	components.push(flagsCheckboxes(null));
	return { custom_id: `emoji-add-modal:${addKey}`, title: '絵文字の情報を入力', components };
}

// Edit keeps the name editable, so the 5-slot budget is: name + category +
// tags + license + options. Category is a select when categories exist (current
// value pre-selected); otherwise it falls back to a free-text input. Switching
// to a brand-new category not in the list is done via `/emoji edit`.
export function buildEditModal(approvalKey, currentMeta, categories) {
	const current = currentMeta?.category || null;
	const options = buildCategoryOptions(categories, current);
	const components = [
		labelText('name', '絵文字名 (小文字 a-z 0-9 _、大文字不可)', {
			required: true,
			max_length: 128,
			value: currentMeta?.name ?? '',
			placeholder: 'kawaii_neko (大文字は使用できません)',
		}),
	];
	if (options.length) {
		components.push(labelSelect('category_select', 'カテゴリ', options, {
			placeholder: 'カテゴリを選択',
			description: '変更しない場合は現在の値のまま',
		}));
	} else {
		components.push(labelText('category_new', 'カテゴリ', {
			required: true,
			max_length: 128,
			value: currentMeta?.category ?? '',
		}));
	}
	components.push(labelText('tags', 'タグ (カンマ区切り)', {
		max_length: 256,
		value: (currentMeta?.aliases ?? []).join(', '),
	}));
	components.push(labelText('license', 'ライセンス', {
		max_length: 256,
		value: currentMeta?.license ?? '',
	}));
	components.push(flagsCheckboxes(currentMeta));
	return { custom_id: `emoji-edit-modal:${approvalKey}`, title: 'リクエストを編集', components };
}

// Walk a modal-submit payload and index every component that carries a
// custom_id. This tolerates whatever nesting Discord uses (legacy action rows,
// Label wrappers, or flat components) so the readers below don't depend on the
// exact shape.
function indexModalComponents(interaction) {
	const out = {};
	const walk = node => {
		if (!node) return;
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		if (node.custom_id) out[node.custom_id] = node;
		walk(node.component);
		walk(node.components);
	};
	walk(interaction.data?.components);
	return out;
}

export function readModalField(interaction, customId) {
	const node = indexModalComponents(interaction)[customId];
	const v = node?.value;
	return (typeof v === 'string' ? v : '').trim();
}

// Selected values can arrive as `values` (string select) or `value` (some new
// components), and as an array or single string — normalize to an array.
export function readModalValues(interaction, customId) {
	const node = indexModalComponents(interaction)[customId];
	if (!node) return [];
	const raw = node.values ?? node.value;
	if (Array.isArray(raw)) return raw;
	if (raw === undefined || raw === null || raw === '') return [];
	return [raw];
}

export function readModalSelect(interaction, customId) {
	return readModalValues(interaction, customId)[0] ?? '';
}

export function hasApproverRole(member, approverRoleIds) {
	if (!member || approverRoleIds.size === 0) return false;
	const roles = member.roles ?? [];
	for (const id of roles) {
		if (approverRoleIds.has(id)) return true;
	}
	return false;
}
