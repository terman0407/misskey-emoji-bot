import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { sanitizeEmojiName, isValidEmojiName } from './sanitize.js';
import { registerEmojiFromAttachment } from './register.js';
import { put, peek, update, remove, newKey } from './state.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const BUTTON_APPROVE = 'emoji-approve:';
export const BUTTON_REJECT = 'emoji-reject:';
export const BUTTON_EDIT = 'emoji-edit:';
export const MODAL_EDIT = 'emoji-edit-modal:';

export function createApproval({ submitterId, submitterTag, channelId, sourceMessageId = null, attachment, meta }) {
	const key = newKey();
	put(key, {
		submitterId,
		submitterTag,
		channelId,
		sourceMessageId,
		attachment: serializeAttachment(attachment),
		meta: normalizeMeta(meta, attachment),
		status: 'pending',
	}, TTL_MS);
	return key;
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

	const embed = new EmbedBuilder()
		.setColor(color)
		.setTitle(title)
		.setDescription(lines.join('\n'))
		.setImage(state.attachment.url)
		.setFooter({ text: `申請者: ${state.submitterTag} (${state.submitterId})  •  request_id: ${key}` });

	if (status === 'approved' && state.approverTag) {
		embed.addFields({ name: '承認者', value: state.approverTag, inline: true });
	}
	if (status === 'rejected' && state.approverTag) {
		embed.addFields({ name: '却下者', value: state.approverTag, inline: true });
	}
	if (state.error) {
		embed.addFields({ name: 'エラー', value: `\`\`\`${state.error.slice(0, 500)}\`\`\`` });
	}

	return embed;
}

export function buildApprovalButtons(key, status = 'pending') {
	if (status !== 'pending') {
		return new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`emoji-noop:${key}`).setLabel('処理済み').setStyle(ButtonStyle.Secondary).setDisabled(true),
		);
	}
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`${BUTTON_APPROVE}${key}`).setLabel('承認').setEmoji('✅').setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${BUTTON_REJECT}${key}`).setLabel('却下').setEmoji('❌').setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId(`${BUTTON_EDIT}${key}`).setLabel('編集').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
	);
}

export function buildSubmitterReceiptButtons(key) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`${BUTTON_EDIT}${key}`).setLabel('編集').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
	);
}

export function buildEditModal(key, state) {
	const m = state.meta;
	const modal = new ModalBuilder()
		.setCustomId(`${MODAL_EDIT}${key}`)
		.setTitle('リクエストを編集');

	const fields = [
		new TextInputBuilder().setCustomId('name').setLabel('絵文字名 (a-z 0-9 _)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(128).setValue(m.name ?? ''),
		new TextInputBuilder().setCustomId('category').setLabel('カテゴリ').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(128).setValue(m.category ?? ''),
		new TextInputBuilder().setCustomId('tags').setLabel('タグ (カンマ区切り)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue((m.aliases ?? []).join(', ')),
		new TextInputBuilder().setCustomId('license').setLabel('ライセンス').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(m.license ?? ''),
	];

	modal.addComponents(...fields.map(f => new ActionRowBuilder().addComponents(f)));
	return modal;
}

function hasApproverRole(member, approverRoleIds) {
	if (!member || approverRoleIds.size === 0) return false;
	if (member.roles?.cache) {
		for (const id of member.roles.cache.keys()) {
			if (approverRoleIds.has(id)) return true;
		}
	} else if (Array.isArray(member.roles)) {
		for (const id of member.roles) {
			if (approverRoleIds.has(id)) return true;
		}
	}
	return false;
}

export async function handleButton(interaction, ctx) {
	const customId = interaction.customId;
	let key;
	let action;
	if (customId.startsWith(BUTTON_APPROVE)) { action = 'approve'; key = customId.slice(BUTTON_APPROVE.length); }
	else if (customId.startsWith(BUTTON_REJECT)) { action = 'reject'; key = customId.slice(BUTTON_REJECT.length); }
	else if (customId.startsWith(BUTTON_EDIT)) { action = 'edit'; key = customId.slice(BUTTON_EDIT.length); }
	else return false;

	const state = peek(key);
	if (!state) {
		await interaction.reply({ content: '⏱ このリクエストは期限切れ or 既に処理済みです。', flags: MessageFlags.Ephemeral });
		return true;
	}
	if (state.status !== 'pending') {
		await interaction.reply({ content: `このリクエストは既に \`${state.status}\` です。`, flags: MessageFlags.Ephemeral });
		return true;
	}

	const isSubmitter = interaction.user.id === state.submitterId;
	const isApprover = hasApproverRole(interaction.member, ctx.approverRoleIds);

	if (action === 'edit') {
		if (!isSubmitter && !isApprover) {
			await interaction.reply({ content: '🔒 編集権限がありません (申請者または承認者のみ)', flags: MessageFlags.Ephemeral });
			return true;
		}
		await interaction.showModal(buildEditModal(key, state));
		return true;
	}

	if (!isApprover) {
		await interaction.reply({ content: '🔒 承認権限がありません。', flags: MessageFlags.Ephemeral });
		return true;
	}

	if (action === 'reject') {
		const updated = update(key, s => ({ ...s, status: 'rejected', approverTag: interaction.user.tag, approverId: interaction.user.id }), TTL_MS);
		await interaction.update({ embeds: [buildApprovalEmbed(key, updated)], components: [buildApprovalButtons(key, 'rejected')] });
		await notifySubmitter({ client: interaction.client, state: updated, status: 'rejected', approverTag: interaction.user.tag });
		return true;
	}

	if (action === 'approve') {
		await interaction.deferUpdate();
		const result = await registerEmojiFromAttachment({
			attachment: state.attachment,
			meta: state.meta,
			defaults: ctx.defaults,
			config: ctx.misskeyConfig,
		});

		if (result.ok) {
			const updated = update(key, s => ({ ...s, status: 'approved', approverTag: interaction.user.tag, approverId: interaction.user.id, registeredName: result.name, registeredId: result.id }), TTL_MS);
			await interaction.editReply({ embeds: [buildApprovalEmbed(key, updated)], components: [buildApprovalButtons(key, 'approved')] });
			console.log(`[approved] ${state.attachment.name} -> :${result.name}: (id=${result.id}) by ${interaction.user.tag}`);
			await notifySubmitter({ client: interaction.client, state: updated, status: 'approved', approverTag: interaction.user.tag, registeredName: result.name });
			remove(key);
		} else {
			const updated = update(key, s => ({ ...s, status: 'pending', error: result.error }), TTL_MS);
			await interaction.editReply({ embeds: [buildApprovalEmbed(key, updated)], components: [buildApprovalButtons(key, 'pending')] });
			console.log(`[approve-failed] ${state.attachment.name} by ${interaction.user.tag}: ${result.error}`);
		}
		return true;
	}

	return false;
}

export async function handleEditModalSubmit(interaction, ctx) {
	if (!interaction.customId.startsWith(MODAL_EDIT)) return false;
	const key = interaction.customId.slice(MODAL_EDIT.length);

	const state = peek(key);
	if (!state) {
		await interaction.reply({ content: '⏱ このリクエストは期限切れ or 処理済みです。', flags: MessageFlags.Ephemeral });
		return true;
	}

	const isSubmitter = interaction.user.id === state.submitterId;
	const isApprover = hasApproverRole(interaction.member, ctx.approverRoleIds);
	if (!isSubmitter && !isApprover) {
		await interaction.reply({ content: '🔒 編集権限がありません (申請者または承認者のみ)', flags: MessageFlags.Ephemeral });
		return true;
	}

	const name = interaction.fields.getTextInputValue('name').trim();
	const category = interaction.fields.getTextInputValue('category').trim();
	const tags = interaction.fields.getTextInputValue('tags').trim();
	const license = interaction.fields.getTextInputValue('license').trim();

	const updated = update(key, s => ({
		...s,
		meta: {
			...s.meta,
			name,
			category: category || undefined,
			aliases: tags ? tags.split(/[,、]/).map(t => t.trim()).filter(Boolean) : [],
			license: license || undefined,
		},
		error: undefined,
	}), TTL_MS);

	const fromApprovalMessage = interaction.message?.id && interaction.message.id === state.approvalMessageId;

	if (fromApprovalMessage) {
		await interaction.update({ embeds: [buildApprovalEmbed(key, updated)], components: [buildApprovalButtons(key, 'pending')] });
	} else {
		if (state.approvalChannelId && state.approvalMessageId) {
			try {
				const channel = await interaction.client.channels.fetch(state.approvalChannelId);
				const msg = await channel.messages.fetch(state.approvalMessageId);
				await msg.edit({ embeds: [buildApprovalEmbed(key, updated)], components: [buildApprovalButtons(key, 'pending')] });
			} catch (e) {
				console.error('[edit approval-message failed]', e);
			}
		}
		await interaction.reply({ content: '✏️ 編集を保存しました', flags: MessageFlags.Ephemeral });
	}
	return true;
}

export async function postApprovalMessage({ client, ctx, key, state }) {
	const payload = {
		embeds: [buildApprovalEmbed(key, state)],
		components: [buildApprovalButtons(key, 'pending')],
	};
	if (ctx.approvalChannelId) {
		const channel = await client.channels.fetch(ctx.approvalChannelId);
		const sent = await channel.send({
			content: `📥 <@${state.submitterId}> から絵文字登録の申請があります`,
			...payload,
			allowedMentions: { users: [] },
		});
		update(key, s => ({ ...s, approvalMessageId: sent.id, approvalChannelId: ctx.approvalChannelId }), TTL_MS);
		return { sent, location: 'approval-channel' };
	}
	return { sent: null, location: 'inline', payload };
}

async function notifySubmitter({ client, state, status, approverTag, registeredName }) {
	if (!state.channelId) return;
	if (state.channelId === state.approvalChannelId) return;

	const mention = `<@${state.submitterId}>`;
	let content;
	if (status === 'approved') {
		content = `✅ ${mention} 申請された絵文字 \`:${registeredName}:\` が登録されました (by ${approverTag})`;
	} else if (status === 'rejected') {
		content = `❌ ${mention} 申請が却下されました (by ${approverTag})`;
	} else {
		return;
	}

	try {
		const channel = await client.channels.fetch(state.channelId);
		await channel.send({ content, allowedMentions: { users: [state.submitterId] } });
	} catch (e) {
		console.error('[notify failed]', e);
	}
}

function normalizeMeta(meta, attachment) {
	let name = meta.name;
	if (!isValidEmojiName(name)) {
		name = sanitizeEmojiName(name ?? attachment.name);
	}
	return {
		name,
		category: meta.category,
		aliases: meta.aliases ?? [],
		license: meta.license,
		isSensitive: meta.isSensitive ?? false,
		localOnly: meta.localOnly ?? false,
	};
}

function serializeAttachment(att) {
	return {
		name: att.name,
		url: att.url,
		contentType: att.contentType,
	};
}
