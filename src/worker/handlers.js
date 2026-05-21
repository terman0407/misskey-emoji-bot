import { sanitizeEmojiName, isValidEmojiName } from '../sanitize.js';
import { registerEmojiFromAttachment, ALLOWED_TYPES } from '../register.js';
import * as state from './state.js';
import {
	InteractionResponseType,
	MessageFlags,
	buildApprovalEmbed,
	buildApprovalButtons,
	buildSubmitterReceiptButtons,
	buildEditModal,
	buildSubmitModal,
	patchMessage,
	postMessage,
	readModalField,
	hasApproverRole,
} from './discord.js';

const SESSION_TTL = 10 * 60;

function ephemeralReply(content) {
	return {
		type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
		data: { content, flags: MessageFlags.EPHEMERAL },
	};
}

function modalResponse(modal) {
	return { type: InteractionResponseType.MODAL, data: modal };
}

export async function handleSlashCommand(interaction, env) {
	if (interaction.data.name !== 'emoji') {
		return ephemeralReply('Unknown command.');
	}
	const sub = interaction.data.options?.[0];
	if (sub?.name !== 'add') return ephemeralReply('Unknown subcommand.');

	const opts = Object.fromEntries((sub.options ?? []).map(o => [o.name, o.value]));
	const attachmentId = opts.image;
	const attachment = interaction.data.resolved?.attachments?.[attachmentId];
	if (!attachment) return ephemeralReply('❌ 添付ファイルが取得できませんでした。');

	if (!ALLOWED_TYPES.has(attachment.content_type ?? '')) {
		return ephemeralReply(`❌ 対応していない画像タイプです: \`${attachment.content_type ?? 'unknown'}\``);
	}

	const key = state.newKey();
	await state.put(env.STATE, `session:${key}`, {
		attachment: {
			name: attachment.filename,
			url: attachment.url,
			contentType: attachment.content_type,
		},
		sensitive: !!opts.sensitive,
		localOnly: !!opts.localonly,
	}, SESSION_TTL);

	const defaultName = sanitizeEmojiName(attachment.filename);
	return modalResponse(buildSubmitModal(key, defaultName));
}

export async function handleAddModalSubmit(interaction, env, ctx, key) {
	const session = await state.peek(env.STATE, `session:${key}`);
	if (!session) {
		return ephemeralReply('⏱ セッションが期限切れです。`/emoji add` をやり直してください。');
	}
	await state.remove(env.STATE, `session:${key}`);

	const name = readModalField(interaction, 'name');
	const category = readModalField(interaction, 'category');
	const tags = readModalField(interaction, 'tags');
	const license = readModalField(interaction, 'license');

	const meta = normalizeMeta({
		name,
		category: category || undefined,
		aliases: tags ? tags.split(/[,、]/).map(s => s.trim()).filter(Boolean) : [],
		license: license || undefined,
		isSensitive: session.sensitive,
		localOnly: session.localOnly,
	}, session.attachment);

	const approvalKey = state.newKey();
	const submitterId = interaction.member?.user?.id ?? interaction.user?.id;
	const submitterTag = (interaction.member?.user ?? interaction.user)?.username;
	const channelId = interaction.channel_id;

	const baseState = {
		submitterId,
		submitterTag,
		channelId,
		attachment: session.attachment,
		meta,
		status: 'pending',
	};

	const approvalChannelId = env.DISCORD_APPROVAL_CHANNEL_ID || null;

	if (approvalChannelId) {
		await state.put(env.STATE, approvalKey, { ...baseState, approvalChannelId });
		ctx.waitUntil((async () => {
			try {
				const posted = await postMessage(env.DISCORD_TOKEN, approvalChannelId, {
					content: `📥 <@${submitterId}> から絵文字登録の申請があります`,
					embeds: [buildApprovalEmbed(approvalKey, { ...baseState, approvalChannelId })],
					components: [buildApprovalButtons(approvalKey, 'pending')],
					allowed_mentions: { users: [] },
				});
				await state.update(env.STATE, approvalKey, s => ({ ...s, approvalMessageId: posted.id }));
			} catch (e) {
				console.error('[post approval-message]', e);
			}
		})());
		return {
			type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
			data: {
				content: '📥 申請を受け付けました。承認をお待ちください。',
				components: [buildSubmitterReceiptButtons(approvalKey)],
				flags: MessageFlags.EPHEMERAL,
			},
		};
	}

	// Inline mode: approval message lives in the same channel as the request.
	await state.put(env.STATE, approvalKey, { ...baseState, approvalChannelId: channelId });
	ctx.waitUntil((async () => {
		try {
			const original = await fetch(
				`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`,
			).then(r => r.json());
			if (original?.id) {
				await state.update(env.STATE, approvalKey, s => ({ ...s, approvalMessageId: original.id }));
			}
		} catch (e) {
			console.error('[fetch original]', e);
		}
	})());
	return {
		type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
		data: {
			embeds: [buildApprovalEmbed(approvalKey, { ...baseState, approvalChannelId: channelId })],
			components: [buildApprovalButtons(approvalKey, 'pending')],
		},
	};
}

export async function handleButton(interaction, env, ctx) {
	const customId = interaction.data.custom_id;
	const [prefix, key] = splitCustomId(customId);
	const action = prefix === 'emoji-approve' ? 'approve'
		: prefix === 'emoji-reject' ? 'reject'
		: prefix === 'emoji-edit' ? 'edit'
		: null;
	if (!action) return ephemeralReply('Unknown button.');

	const current = await state.peek(env.STATE, key);
	if (!current) {
		return ephemeralReply('⏱ このリクエストは期限切れ or 既に処理済みです。');
	}
	if (current.status !== 'pending') {
		return ephemeralReply(`このリクエストは既に \`${current.status}\` です。`);
	}

	const approverRoleIds = parseRoleIds(env.APPROVER_ROLE_IDS);
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const isSubmitter = userId === current.submitterId;
	const isApprover = hasApproverRole(interaction.member, approverRoleIds);

	if (action === 'edit') {
		if (!isSubmitter && !isApprover) {
			return ephemeralReply('🔒 編集権限がありません (申請者または承認者のみ)');
		}
		return modalResponse(buildEditModal(key, current));
	}

	if (!isApprover) {
		return ephemeralReply('🔒 承認権限がありません。');
	}

	const approverTag = (interaction.member?.user ?? interaction.user)?.username;

	if (action === 'reject') {
		const updated = await state.update(env.STATE, key, s => ({
			...s, status: 'rejected', approverTag, approverId: userId,
		}));
		ctx.waitUntil(notifySubmitter(env, updated, 'rejected', approverTag, null));
		return {
			type: InteractionResponseType.UPDATE_MESSAGE,
			data: {
				embeds: [buildApprovalEmbed(key, updated)],
				components: [buildApprovalButtons(key, 'rejected')],
			},
		};
	}

	// approve — defer, then do the heavy lifting in waitUntil
	ctx.waitUntil(handleApproveBackground(env, interaction, key, current, approverTag, userId));
	return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

async function handleApproveBackground(env, interaction, key, current, approverTag, approverId) {
	const result = await registerEmojiFromAttachment({
		attachment: current.attachment,
		meta: current.meta,
		defaults: {
			category: env.DEFAULT_CATEGORY || null,
			license: env.DEFAULT_LICENSE || null,
		},
		config: { baseUrl: env.MISSKEY_URL, token: env.MISSKEY_TOKEN },
	});

	const channelId = interaction.message.channel_id;
	const messageId = interaction.message.id;

	if (result.ok) {
		const updated = await state.update(env.STATE, key, s => ({
			...s,
			status: 'approved',
			approverTag,
			approverId,
			registeredName: result.name,
			registeredId: result.id,
		}));
		try {
			await patchMessage(env.DISCORD_TOKEN, channelId, messageId, {
				embeds: [buildApprovalEmbed(key, updated)],
				components: [buildApprovalButtons(key, 'approved')],
			});
		} catch (e) {
			console.error('[patch approved message]', e);
		}
		console.log(`[approved] ${current.attachment.name} -> :${result.name}: (id=${result.id}) by ${approverTag}`);
		await notifySubmitter(env, updated, 'approved', approverTag, result.name);
		await state.remove(env.STATE, key);
	} else {
		const updated = await state.update(env.STATE, key, s => ({ ...s, status: 'pending', error: result.error }));
		try {
			await patchMessage(env.DISCORD_TOKEN, channelId, messageId, {
				embeds: [buildApprovalEmbed(key, updated)],
				components: [buildApprovalButtons(key, 'pending')],
			});
		} catch (e) {
			console.error('[patch failed message]', e);
		}
		console.log(`[approve-failed] ${current.attachment.name} by ${approverTag}: ${result.error}`);
	}
}

export async function handleEditModalSubmit(interaction, env, ctx, key) {
	const current = await state.peek(env.STATE, key);
	if (!current) {
		return ephemeralReply('⏱ このリクエストは期限切れ or 処理済みです。');
	}

	const approverRoleIds = parseRoleIds(env.APPROVER_ROLE_IDS);
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const isSubmitter = userId === current.submitterId;
	const isApprover = hasApproverRole(interaction.member, approverRoleIds);
	if (!isSubmitter && !isApprover) {
		return ephemeralReply('🔒 編集権限がありません (申請者または承認者のみ)');
	}

	const name = readModalField(interaction, 'name');
	const category = readModalField(interaction, 'category');
	const tags = readModalField(interaction, 'tags');
	const license = readModalField(interaction, 'license');

	const updated = await state.update(env.STATE, key, s => ({
		...s,
		meta: {
			...s.meta,
			name,
			category: category || undefined,
			aliases: tags ? tags.split(/[,、]/).map(t => t.trim()).filter(Boolean) : [],
			license: license || undefined,
		},
		error: undefined,
	}));

	const fromApprovalMessage = interaction.message?.id && interaction.message.id === current.approvalMessageId;

	if (fromApprovalMessage) {
		return {
			type: InteractionResponseType.UPDATE_MESSAGE,
			data: {
				embeds: [buildApprovalEmbed(key, updated)],
				components: [buildApprovalButtons(key, 'pending')],
			},
		};
	}

	if (updated.approvalChannelId && updated.approvalMessageId) {
		ctx.waitUntil((async () => {
			try {
				await patchMessage(env.DISCORD_TOKEN, updated.approvalChannelId, updated.approvalMessageId, {
					embeds: [buildApprovalEmbed(key, updated)],
					components: [buildApprovalButtons(key, 'pending')],
				});
			} catch (e) {
				console.error('[patch approval-message after edit]', e);
			}
		})());
	}
	return ephemeralReply('✏️ 編集を保存しました');
}

async function notifySubmitter(env, current, status, approverTag, registeredName) {
	if (!current?.channelId) return;
	if (current.channelId === current.approvalChannelId) return;

	const mention = `<@${current.submitterId}>`;
	let content;
	if (status === 'approved') {
		content = `✅ ${mention} 申請された絵文字 \`:${registeredName}:\` が登録されました (by ${approverTag})`;
	} else if (status === 'rejected') {
		content = `❌ ${mention} 申請が却下されました (by ${approverTag})`;
	} else {
		return;
	}
	try {
		await postMessage(env.DISCORD_TOKEN, current.channelId, {
			content,
			allowed_mentions: { users: [current.submitterId] },
		});
	} catch (e) {
		console.error('[notify failed]', e);
	}
}

function splitCustomId(customId) {
	const i = customId.indexOf(':');
	return i < 0 ? [customId, ''] : [customId.slice(0, i), customId.slice(i + 1)];
}

function parseRoleIds(raw) {
	return new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean));
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
