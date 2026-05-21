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
	MODAL: 9,
};

export const ComponentType = {
	ACTION_ROW: 1,
	BUTTON: 2,
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

export function getOriginalInteractionResponse(applicationId, interactionToken) {
	return fetch(`${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`).then(r => r.json());
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

export function buildSubmitterReceiptButtons(key) {
	return {
		type: ComponentType.ACTION_ROW,
		components: [
			{ type: ComponentType.BUTTON, custom_id: `emoji-edit:${key}`, label: '編集', emoji: { name: '✏️' }, style: ButtonStyle.SECONDARY },
		],
	};
}

export function buildEditModal(key, state) {
	const m = state.meta;
	return {
		custom_id: `emoji-edit-modal:${key}`,
		title: 'リクエストを編集',
		components: [
			textInputRow('name', '絵文字名 (a-z 0-9 _)', TextInputStyle.SHORT, { required: true, max_length: 128, value: m.name ?? '' }),
			textInputRow('category', 'カテゴリ', TextInputStyle.SHORT, { required: false, max_length: 128, value: m.category ?? '' }),
			textInputRow('tags', 'タグ (カンマ区切り)', TextInputStyle.SHORT, { required: false, max_length: 256, value: (m.aliases ?? []).join(', ') }),
			textInputRow('license', 'ライセンス', TextInputStyle.SHORT, { required: false, max_length: 256, value: m.license ?? '' }),
		],
	};
}

export function buildSubmitModal(key, defaultName) {
	return {
		custom_id: `emoji-add:${key}`,
		title: 'カスタム絵文字の登録 (申請)',
		components: [
			textInputRow('name', '絵文字名 (a-z 0-9 _)', TextInputStyle.SHORT, { required: true, max_length: 128, value: defaultName || '', placeholder: 'kawaii_neko' }),
			textInputRow('category', 'カテゴリ (任意)', TextInputStyle.SHORT, { required: false, max_length: 128 }),
			textInputRow('tags', 'タグ (任意、カンマ区切り)', TextInputStyle.SHORT, { required: false, max_length: 256, placeholder: 'cat, cute, ねこ' }),
			textInputRow('license', 'ライセンス (任意)', TextInputStyle.SHORT, { required: false, max_length: 256 }),
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
