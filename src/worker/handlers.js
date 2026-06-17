import { sanitizeEmojiName, isValidEmojiName } from '../sanitize.js';
import { ALLOWED_TYPES, downloadAttachment, uploadBufferToDrive, registerEmojiByFileId, cleanupDriveFile } from '../register.js';
import { fetchAllCategories } from '../misskey.js';
import * as state from './state.js';
import {
	InteractionResponseType,
	MessageFlags,
	buildApprovalEmbed,
	buildApprovalButtons,
	buildSubmitterReceiptButtons,
	buildEditModal,
	buildCategorySelectPayload,
	buildNewCategoryModal,
	CATEGORY_NEW_VALUE,
	patchMessage,
	postMessage,
	readModalField,
	hasApproverRole,
} from './discord.js';

async function deleteR2Image(env, r2Key) {
	if (!r2Key) return;
	try {
		await env.EMOJI_BUCKET.delete(r2Key);
	} catch (e) {
		console.error('[r2 delete]', e);
	}
}

async function patchSubmitterReceipt(env, approvalKey, current) {
	if (!current?.submitterInteractionToken) return;
	const body = {
		embeds: [buildApprovalEmbed(approvalKey, current)],
		components: current.status === 'pending' ? [buildSubmitterReceiptButtons(approvalKey)] : [],
	};
	try {
		const res = await fetch(
			`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${current.submitterInteractionToken}/messages/@original`,
			{ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
		);
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.error(`[patch submitter receipt] ${res.status}: ${text}`);
		}
	} catch (e) {
		console.error('[patch submitter receipt]', e);
	}
}

const EDIT_SESSION_TTL = 15 * 60;

function modalResponse(modal) {
	return { type: InteractionResponseType.MODAL, data: modal };
}

function updateMessageEphemeral(content) {
	return {
		type: InteractionResponseType.UPDATE_MESSAGE,
		data: { content, components: [], flags: MessageFlags.EPHEMERAL },
	};
}

const CATEGORY_CACHE_KEY = 'cache:categories';
const CATEGORY_CACHE_TTL = 60 * 60;

function ephemeralReply(content) {
	return {
		type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
		data: { content, flags: MessageFlags.EPHEMERAL },
	};
}

function autocompleteResponse(choices) {
	return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
}

function parseRoleIds(raw) {
	return new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean));
}

async function getCachedCategories(env) {
	const cached = await env.STATE.get(CATEGORY_CACHE_KEY, 'json');
	if (cached) return cached;
	try {
		const fetched = await fetchAllCategories({ baseUrl: env.MISSKEY_URL, token: env.MISSKEY_TOKEN });
		await env.STATE.put(CATEGORY_CACHE_KEY, JSON.stringify(fetched), { expirationTtl: CATEGORY_CACHE_TTL });
		return fetched;
	} catch (e) {
		console.error('[fetch categories]', e);
		return [];
	}
}

export async function handleSlashCommand(interaction, env, ctx) {
	if (interaction.data.name !== 'emoji') return ephemeralReply('Unknown command.');
	const sub = interaction.data.options?.[0];
	if (sub?.name === 'add') return handleAddCommand(interaction, env, ctx, sub);
	if (sub?.name === 'edit') return handleEditCommand(interaction, env, ctx, sub);
	return ephemeralReply('Unknown subcommand.');
}

async function handleAddCommand(interaction, env, ctx, sub) {
	const opts = Object.fromEntries((sub.options ?? []).map(o => [o.name, o.value]));
	const attachmentId = opts.image;
	const attachment = interaction.data.resolved?.attachments?.[attachmentId];
	if (!attachment) return ephemeralReply('❌ 添付ファイルが取得できませんでした。');

	if (!ALLOWED_TYPES.has(attachment.content_type ?? '')) {
		return ephemeralReply(`❌ 対応していない画像タイプです: \`${attachment.content_type ?? 'unknown'}\``);
	}

	let name = (opts.name || '').trim();
	if (!name) name = sanitizeEmojiName(attachment.filename);
	else if (!isValidEmojiName(name)) name = sanitizeEmojiName(name);
	if (!isValidEmojiName(name)) {
		return ephemeralReply(`❌ 絵文字名を決められませんでした (元: \`${opts.name || attachment.filename}\`)。a-z 0-9 _ のみ使用可能です。`);
	}

	const category = (opts.category || '').trim();
	if (!category) return ephemeralReply('❌ カテゴリは必須です。');

	const meta = {
		name,
		category,
		aliases: opts.tags ? opts.tags.split(/[,、]/).map(s => s.trim()).filter(Boolean) : [],
		license: opts.license || undefined,
		isSensitive: !!opts.sensitive,
		localOnly: !!opts.localonly,
	};

	// Download from Discord and store the image in R2 (instead of pushing to
	// Misskey drive immediately). This way the submitter can cancel before
	// approval and nothing ever lands in Misskey.
	const dl = await downloadAttachment({
		name: attachment.filename,
		url: attachment.url,
		contentType: attachment.content_type,
	});
	if (!dl.ok) {
		return ephemeralReply(`❌ 画像の保存に失敗しました: ${dl.error}`);
	}

	const approvalKey = state.newKey();
	const r2Key = `${env.R2_KEY_PREFIX}${approvalKey}`;
	try {
		await env.EMOJI_BUCKET.put(r2Key, dl.data, {
			httpMetadata: { contentType: attachment.content_type },
		});
	} catch (e) {
		console.error('[r2 put]', e);
		return ephemeralReply(`❌ 画像の保存に失敗しました: ${e.message ?? 'R2 アップロード失敗'}`);
	}
	const publicUrl = `${env.R2_PUBLIC_URL_BASE}${r2Key}`;

	const submitterId = interaction.member?.user?.id ?? interaction.user?.id;
	const submitterTag = (interaction.member?.user ?? interaction.user)?.username;
	const channelId = interaction.channel_id;

	const approvalChannelId = env.DISCORD_APPROVAL_CHANNEL_ID || null;
	const targetChannelId = approvalChannelId || channelId;

	const approvalState = {
		submitterId,
		submitterTag,
		channelId,
		attachment: {
			name: attachment.filename,
			contentType: attachment.content_type,
			r2Key,
			url: publicUrl,
		},
		meta,
		status: 'pending',
		approvalChannelId: targetChannelId,
		submitterInteractionToken: interaction.token,
	};
	await state.put(env.STATE, approvalKey, approvalState);

	ctx.waitUntil((async () => {
		try {
			const payload = {
				embeds: [buildApprovalEmbed(approvalKey, approvalState)],
				components: [buildApprovalButtons(approvalKey, 'pending')],
			};
			if (approvalChannelId) {
				payload.content = `📥 <@${submitterId}> から絵文字登録の申請があります`;
				payload.allowed_mentions = { users: [] };
			}
			const posted = await postMessage(env.DISCORD_TOKEN, targetChannelId, payload);
			await state.update(env.STATE, approvalKey, s => ({ ...s, approvalMessageId: posted.id }));
		} catch (e) {
			console.error('[post approval-message]', e);
		}
	})());

	return {
		type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
		data: {
			content: `📥 申請を受け付けました (request_id: \`${approvalKey}\`)。承認をお待ちください。`,
			embeds: [buildApprovalEmbed(approvalKey, approvalState)],
			components: [buildSubmitterReceiptButtons(approvalKey)],
			flags: MessageFlags.EPHEMERAL,
		},
	};
}

async function handleEditCommand(interaction, env, ctx, sub) {
	const opts = Object.fromEntries((sub.options ?? []).map(o => [o.name, o.value]));
	const approvalKey = opts.request_id;
	if (!approvalKey) return ephemeralReply('❌ request_id が必要です。');

	const current = await state.peek(env.STATE, approvalKey);
	if (!current) return ephemeralReply('⏱ そのリクエストは存在しないか期限切れです。');
	if (current.status !== 'pending') {
		return ephemeralReply(`このリクエストは既に \`${current.status}\` です。`);
	}

	const approverRoleIds = parseRoleIds(env.APPROVER_ROLE_IDS);
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const isSubmitter = userId === current.submitterId;
	const isApprover = hasApproverRole(interaction.member, approverRoleIds);
	if (!isSubmitter && !isApprover) {
		return ephemeralReply('🔒 編集権限がありません (申請者または承認者のみ)');
	}

	const newMeta = { ...current.meta };
	if (opts.name !== undefined) {
		let n = String(opts.name).trim();
		if (!isValidEmojiName(n)) n = sanitizeEmojiName(n);
		if (!isValidEmojiName(n)) return ephemeralReply('❌ 絵文字名が不正です。');
		newMeta.name = n;
	}
	if (opts.category !== undefined) newMeta.category = String(opts.category).trim();
	if (opts.tags !== undefined) {
		newMeta.aliases = opts.tags ? String(opts.tags).split(/[,、]/).map(s => s.trim()).filter(Boolean) : [];
	}
	if (opts.license !== undefined) newMeta.license = opts.license || undefined;
	if (opts.sensitive !== undefined) newMeta.isSensitive = !!opts.sensitive;
	if (opts.localonly !== undefined) newMeta.localOnly = !!opts.localonly;

	const updated = await state.update(env.STATE, approvalKey, s => ({ ...s, meta: newMeta, error: undefined }));

	if (updated?.approvalChannelId && updated?.approvalMessageId) {
		ctx.waitUntil((async () => {
			try {
				await patchMessage(env.DISCORD_TOKEN, updated.approvalChannelId, updated.approvalMessageId, {
					embeds: [buildApprovalEmbed(approvalKey, updated)],
					components: [buildApprovalButtons(approvalKey, 'pending')],
				});
			} catch (e) {
				console.error('[patch after edit]', e);
			}
		})());
	}
	ctx.waitUntil(patchSubmitterReceipt(env, approvalKey, updated));

	return ephemeralReply(`✏️ 編集を保存しました (request_id: \`${approvalKey}\`)`);
}

export async function handleAutocomplete(interaction, env) {
	const focused = findFocusedOption(interaction.data.options);
	if (!focused) return autocompleteResponse([]);

	if (focused.name === 'category') {
		return autocompleteCategory(focused, env);
	}
	if (focused.name === 'request_id') {
		return autocompleteRequestId(focused, env, interaction);
	}
	return autocompleteResponse([]);
}

async function autocompleteCategory(focused, env) {
	const query = (focused.value ?? '').trim();
	const lower = query.toLowerCase();
	const categories = await getCachedCategories(env);

	let matches = lower
		? categories.filter(c => c.toLowerCase().includes(lower))
		: categories.slice();
	matches = matches.slice(0, 25);

	if (query && !categories.some(c => c.toLowerCase() === lower)) {
		if (matches.length === 25) matches.pop();
		matches.unshift(`✨ 新規: ${query.slice(0, 80)}`);
	}

	const choices = matches.map(m => {
		const isNew = m.startsWith('✨ 新規: ');
		const value = isNew ? m.slice('✨ 新規: '.length) : m;
		return { name: m.slice(0, 100), value: value.slice(0, 100) };
	});
	return autocompleteResponse(choices);
}

async function autocompleteRequestId(focused, env, interaction) {
	const query = (focused.value ?? '').trim().toLowerCase();
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const approverRoleIds = parseRoleIds(env.APPROVER_ROLE_IDS);
	const isApprover = hasApproverRole(interaction.member, approverRoleIds);

	const pending = await listPendingApprovals(env, userId, isApprover);
	const matches = pending
		.filter(p => !query
			|| p.key.toLowerCase().includes(query)
			|| (p.meta?.name ?? '').toLowerCase().includes(query)
			|| (p.meta?.category ?? '').toLowerCase().includes(query))
		.slice(0, 25);

	const choices = matches.map(p => ({
		name: `${p.meta?.name ?? '???'} (${p.meta?.category ?? '-'}) — ${p.key}`.slice(0, 100),
		value: p.key,
	}));
	return autocompleteResponse(choices);
}

async function listPendingApprovals(env, userId, isApprover) {
	const list = await env.STATE.list();
	const pending = [];
	for (const k of list.keys) {
		const name = k.name;
		if (name.startsWith('session:') || name.startsWith('cache:') || name.startsWith('edit-session:')) continue;
		const data = await env.STATE.get(name, 'json');
		if (!data || data.status !== 'pending') continue;
		if (!isApprover && data.submitterId !== userId) continue;
		pending.push({ key: name, ...data });
	}
	return pending;
}

function findFocusedOption(options) {
	if (!options) return null;
	for (const o of options) {
		if (o.focused) return o;
		if (o.options) {
			const nested = findFocusedOption(o.options);
			if (nested) return nested;
		}
	}
	return null;
}

export async function handleButton(interaction, env, ctx) {
	const customId = interaction.data.custom_id;
	const [prefix, key] = splitCustomId(customId);
	const action = prefix === 'emoji-approve' ? 'approve'
		: prefix === 'emoji-reject' ? 'reject'
		: prefix === 'emoji-edit' ? 'edit'
		: prefix === 'emoji-cancel' ? 'cancel'
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
		return modalResponse(buildEditModal(key, current.meta));
	}

	if (action === 'cancel') {
		if (!isSubmitter) {
			return ephemeralReply('🔒 取り消しは申請者本人のみ可能です。承認者は ❌ 却下を使用してください。');
		}
		const updated = await state.update(env.STATE, key, s => ({ ...s, status: 'cancelled' }));
		ctx.waitUntil(deleteR2Image(env, current.attachment?.r2Key));
		if (current.attachment?.driveFileId) {
			ctx.waitUntil(cleanupDriveFile({
				fileId: current.attachment.driveFileId,
				config: { baseUrl: env.MISSKEY_URL, token: env.MISSKEY_TOKEN },
			}));
		}
		if (updated?.approvalChannelId && updated?.approvalMessageId) {
			ctx.waitUntil((async () => {
				try {
					await patchMessage(env.DISCORD_TOKEN, updated.approvalChannelId, updated.approvalMessageId, {
						embeds: [buildApprovalEmbed(key, updated)],
						components: [buildApprovalButtons(key, 'cancelled')],
					});
				} catch (e) {
					console.error('[patch on cancel]', e);
				}
			})());
		}
		return {
			type: InteractionResponseType.UPDATE_MESSAGE,
			data: {
				content: '🚫 申請を取り消しました。',
				embeds: [buildApprovalEmbed(key, updated)],
				components: [],
				flags: MessageFlags.EPHEMERAL,
			},
		};
	}

	if (!isApprover) return ephemeralReply('🔒 承認権限がありません。');

	const approverTag = (interaction.member?.user ?? interaction.user)?.username;

	if (action === 'reject') {
		const updated = await state.update(env.STATE, key, s => ({
			...s, status: 'rejected', approverTag, approverId: userId,
		}));
		ctx.waitUntil(notifySubmitter(env, updated, 'rejected', approverTag, null));
		ctx.waitUntil(patchSubmitterReceipt(env, key, updated));
		ctx.waitUntil(deleteR2Image(env, current.attachment?.r2Key));
		if (current.attachment?.driveFileId) {
			ctx.waitUntil(cleanupDriveFile({
				fileId: current.attachment.driveFileId,
				config: { baseUrl: env.MISSKEY_URL, token: env.MISSKEY_TOKEN },
			}));
		}
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
	const config = { baseUrl: env.MISSKEY_URL, token: env.MISSKEY_TOKEN };
	const defaults = { category: env.DEFAULT_CATEGORY || null, license: env.DEFAULT_LICENSE || null };

	// At approval time, ensure we have a Misskey drive fileId. New requests are
	// stored in R2 and need to be uploaded to the drive here; older pending
	// requests already have driveFileId from the previous pre-upload flow.
	let fileId = current.attachment?.driveFileId;
	let driveUrl = null;
	if (!fileId && current.attachment?.r2Key) {
		const obj = await env.EMOJI_BUCKET.get(current.attachment.r2Key);
		if (!obj) {
			const updated = await state.update(env.STATE, key, s => ({ ...s, status: 'pending', error: 'R2 から画像を取得できませんでした (削除済み or 期限切れ)。' }));
			await patchMessage(env.DISCORD_TOKEN, interaction.message.channel_id, interaction.message.id, {
				embeds: [buildApprovalEmbed(key, updated)],
				components: [buildApprovalButtons(key, 'pending')],
			}).catch(e => console.error('[patch on r2-miss]', e));
			return;
		}
		const data = await obj.arrayBuffer();
		const upload = await uploadBufferToDrive({
			data,
			name: current.attachment.name,
			contentType: current.attachment.contentType,
			config,
		});
		if (!upload.ok) {
			const updated = await state.update(env.STATE, key, s => ({ ...s, status: 'pending', error: upload.error }));
			await patchMessage(env.DISCORD_TOKEN, interaction.message.channel_id, interaction.message.id, {
				embeds: [buildApprovalEmbed(key, updated)],
				components: [buildApprovalButtons(key, 'pending')],
			}).catch(e => console.error('[patch on drive-upload-fail]', e));
			return;
		}
		fileId = upload.fileId;
		driveUrl = upload.url;
	}

	const result = fileId
		? await registerEmojiByFileId({ fileId, meta: current.meta, defaults, config })
		: { ok: false, error: '画像ファイルが見つかりません。再申請してください。' };

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
			attachment: { ...s.attachment, url: driveUrl ?? s.attachment.url },
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
		await patchSubmitterReceipt(env, key, updated);
		await deleteR2Image(env, current.attachment?.r2Key);
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
		await patchSubmitterReceipt(env, key, updated);
		console.log(`[approve-failed] ${current.attachment.name} by ${approverTag}: ${result.error}`);
	}
}

async function notifySubmitter(env, current, status, approverTag, registeredName) {
	if (!current?.channelId) return;
	if (current.channelId === current.approvalChannelId) return;

	const mention = `<@${current.submitterId}>`;
	if (status === 'approved') {
		// メンションなしの承認完了通知 (画像付き)
		try {
			await postMessage(env.DISCORD_TOKEN, current.channelId, {
				content: `✅ 申請された絵文字 \`:${registeredName}:\` が登録されました (by \`${approverTag}\`)`,
				embeds: [{
					color: 0x44cc44,
					image: { url: current.attachment.url },
				}],
				allowed_mentions: { parse: [] },
			});
		} catch (e) {
			console.error('[notify failed]', e);
		}
		return;
	}
	if (status !== 'rejected') return;
	const content = `❌ ${mention} 申請が却下されました (by \`${approverTag}\`)`;
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

export async function handleEditModalSubmit(interaction, env, ctx, approvalKey) {
	const current = await state.peek(env.STATE, approvalKey);
	if (!current) {
		return ephemeralReply('⏱ このリクエストは期限切れ or 処理済みです。');
	}
	if (current.status !== 'pending') {
		return ephemeralReply(`このリクエストは既に \`${current.status}\` です。`);
	}

	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const isSubmitter = userId === current.submitterId;
	const isApprover = hasApproverRole(interaction.member, parseRoleIds(env.APPROVER_ROLE_IDS));
	if (!isSubmitter && !isApprover) {
		return ephemeralReply('🔒 編集権限がありません');
	}

	const name = readModalField(interaction, 'name');
	const tags = readModalField(interaction, 'tags');
	const license = readModalField(interaction, 'license');

	await state.put(env.STATE, `edit-session:${approvalKey}`, {
		name, tags, license, editorId: userId,
	}, EDIT_SESSION_TTL);

	const categories = await getCachedCategories(env);
	const content = `📁 **新しいカテゴリを選んでください** (現在: \`${current.meta?.category || '未設定'}\`)`;
	return {
		type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
		data: buildCategorySelectPayload(`emoji-cat-edit-select:${approvalKey}`, categories, content),
	};
}

export async function handleCategoryEditSelect(interaction, env, ctx, approvalKey) {
	const editSession = await state.peek(env.STATE, `edit-session:${approvalKey}`);
	if (!editSession) {
		return updateMessageEphemeral('⏱ 編集セッションが期限切れです。もう一度 ✏️ ボタンから始めてください。');
	}
	const selectedValue = interaction.data.values?.[0];
	if (!selectedValue) return ephemeralReply('カテゴリを選択してください。');

	if (selectedValue === CATEGORY_NEW_VALUE) {
		return modalResponse(buildNewCategoryModal(`emoji-cat-edit-new:${approvalKey}`));
	}
	return finalizeEdit(env, ctx, approvalKey, editSession, selectedValue);
}

export async function handleNewCategoryEditModalSubmit(interaction, env, ctx, approvalKey) {
	const editSession = await state.peek(env.STATE, `edit-session:${approvalKey}`);
	if (!editSession) {
		return ephemeralReply('⏱ 編集セッションが期限切れです。もう一度 ✏️ ボタンから始めてください。');
	}
	const category = readModalField(interaction, 'category');
	if (!category) return ephemeralReply('カテゴリを入力してください。');
	return finalizeEdit(env, ctx, approvalKey, editSession, category);
}

async function finalizeEdit(env, ctx, approvalKey, editSession, category) {
	const current = await state.peek(env.STATE, approvalKey);
	if (!current || current.status !== 'pending') {
		await state.remove(env.STATE, `edit-session:${approvalKey}`);
		return updateMessageEphemeral('⏱ このリクエストは期限切れ or 処理済みです。');
	}

	let name = editSession.name?.trim() || current.meta.name;
	if (!isValidEmojiName(name)) name = sanitizeEmojiName(name);
	const aliases = editSession.tags
		? editSession.tags.split(/[,、]/).map(t => t.trim()).filter(Boolean)
		: [];
	const license = editSession.license?.trim() || undefined;

	const updated = await state.update(env.STATE, approvalKey, s => ({
		...s,
		meta: { ...s.meta, name, category, aliases, license },
		error: undefined,
	}));

	await state.remove(env.STATE, `edit-session:${approvalKey}`);

	if (updated?.approvalChannelId && updated?.approvalMessageId) {
		ctx.waitUntil((async () => {
			try {
				await patchMessage(env.DISCORD_TOKEN, updated.approvalChannelId, updated.approvalMessageId, {
					embeds: [buildApprovalEmbed(approvalKey, updated)],
					components: [buildApprovalButtons(approvalKey, 'pending')],
				});
			} catch (e) {
				console.error('[patch after button edit]', e);
			}
		})());
	}
	ctx.waitUntil(patchSubmitterReceipt(env, approvalKey, updated));

	return updateMessageEphemeral(`✏️ 編集を保存しました (カテゴリ: \`${category}\`)`);
}
