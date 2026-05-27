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

export const CATEGORY_NEW_VALUE = '__NEW__';

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

export function buildApprovalEmbed(key, state) {
	const m = state.meta;
	const lines = [
		`**Name:**     \`${m.name || '(未設定)'}\``,
		`**Category:** ${m.category || '_(未設定)_'}`,
		`**Tags:**     ${m.aliases?.length ? m.aliases.map(t => `\`${t}\``).join(', ') : '_(なし)_'}`,
		`**License:**  ${m.license || '_(未設定)_'}`,
		`**Sensitive:** ${m.isSensitive ? 'yes' : 'no'}  /  **LocalOnly:** ${m.localOnly ? 'yes' : 'no'}`,
	];

	const status = state.status;
	const color = status === 'pending' ? 0xffaa00
		: status === 'approved' ? 0x44cc44
		: status === 'rejected' ? 0xcc4444
		: 0x888888;
	const title = status === 'pending' ? '📥 絵文字登録リクエスト'
		: status === 'approved' ? `✅ 登録完了 → \`:${state.registeredName ?? m.name}:\``
		: status === 'rejected' ? '❌ 却下'
		: '⚠️ エラー';

	const fields = [];
	if (status === 'approved' && state.approverTag) {
		fields.push({ name: '承認者', value: state.approverTag, inline: true });
	}
	if (status === 'rejected' && state.approverTag) {
		fields.push({ name: '却下者', value: state.approverTag, inline: true });
	}
	if (state.error) {
		fields.push({ name: 'エラー', value: '```' + state.error.slice(0, 500) + '```' });
	}

	return {
		color,
		title,
		description: lines.join('\n'),
		image: { url: state.attachment.url },
		footer: { text: `申請者: ${state.submitterTag} (${state.submitterId})  •  request_id: ${key}` },
		fields,
	};
}

export function buildSubmitterReceiptButtons(key) {
	return {
		type: ComponentType.ACTION_ROW,
		components: [
			{ type: ComponentType.BUTTON, custom_id: `emoji-edit:${key}`, label: '編集', emoji: { name: '✏️' }, style: ButtonStyle.SECONDARY },
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

export function buildEditModal(approvalKey, currentMeta) {
	return {
		custom_id: `emoji-edit-modal:${approvalKey}`,
		title: 'リクエストを編集',
		components: [
			textInputRow('name', '絵文字名 (小文字 a-z 0-9 _、大文字不可)', TextInputStyle.SHORT, { required: true, max_length: 128, value: currentMeta.name ?? '', placeholder: 'kawaii_neko (大文字は使用できません)' }),
			textInputRow('tags', 'タグ (カンマ区切り)', TextInputStyle.SHORT, { required: false, max_length: 256, value: (currentMeta.aliases ?? []).join(', ') }),
			textInputRow('license', 'ライセンス', TextInputStyle.SHORT, { required: false, max_length: 256, value: currentMeta.license ?? '' }),
		],
	};
}

export function buildCategorySelectPayload(customId, categories, content) {
	const options = [
		{ label: '✨ 新規カテゴリを入力...', value: CATEGORY_NEW_VALUE, description: 'テキスト入力モーダルが開きます', emoji: { name: '✨' } },
		...categories.slice(0, 24).map(c => ({ label: c.slice(0, 100), value: c.slice(0, 100) })),
	];
	return {
		content: content ?? '📁 **カテゴリを選んでください**',
		components: [{
			type: ComponentType.ACTION_ROW,
			components: [{
				type: ComponentType.STRING_SELECT,
				custom_id: customId,
				placeholder: 'カテゴリを選択',
				min_values: 1,
				max_values: 1,
				options,
			}],
		}],
		flags: MessageFlags.EPHEMERAL,
	};
}

export function buildNewCategoryModal(customId, defaultValue = '') {
	return {
		custom_id: customId,
		title: '新規カテゴリ名',
		components: [
			textInputRow('category', 'カテゴリ', TextInputStyle.SHORT, { required: true, max_length: 128, value: defaultValue, placeholder: '例: animal, food, kawaii' }),
		],
	};
}

function textInputRow(customId, label, style, opts = {}) {
	const input = {
		type: ComponentType.TEXT_INPUT,
		custom_id: customId,
		label,
		style,
		required: opts.required ?? false,
	};
	if (opts.max_length) input.max_length = opts.max_length;
	if (opts.value !== undefined && opts.value !== null && opts.value !== '') input.value = opts.value;
	if (opts.placeholder) input.placeholder = opts.placeholder;
	return { type: ComponentType.ACTION_ROW, components: [input] };
}

export function readModalField(interaction, customId) {
	for (const row of interaction.data.components) {
		for (const c of row.components) {
			if (c.custom_id === customId) return (c.value ?? '').trim();
		}
	}
	return '';
}

export function hasApproverRole(member, approverRoleIds) {
	if (!member || approverRoleIds.size === 0) return false;
	const roles = member.roles ?? [];
	for (const id of roles) {
		if (approverRoleIds.has(id)) return true;
	}
	return false;
}
