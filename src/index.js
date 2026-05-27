import 'dotenv/config';
import {
	Client, GatewayIntentBits, Events, MessageFlags,
	EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
	ActionRowBuilder, ButtonBuilder, ButtonStyle,
	StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} from 'discord.js';
import { sanitizeEmojiName, isValidEmojiName } from './sanitize.js';
import { ALLOWED_TYPES, registerEmojiFromAttachment } from './register.js';
import { fetchAllCategories } from './misskey.js';
import { put, peek, update, remove, newKey, listPendingApprovals } from './state.js';

const {
	DISCORD_TOKEN,
	DISCORD_APPROVAL_CHANNEL_ID,
	MISSKEY_URL,
	MISSKEY_TOKEN,
	DEFAULT_CATEGORY,
	DEFAULT_LICENSE,
	APPROVER_ROLE_IDS,
} = process.env;

for (const [k, v] of Object.entries({ DISCORD_TOKEN, MISSKEY_URL, MISSKEY_TOKEN })) {
	if (!v) {
		console.error(`Missing required env: ${k}`);
		process.exit(1);
	}
}

const approverRoleIds = new Set(
	(APPROVER_ROLE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
);
const misskeyConfig = { baseUrl: MISSKEY_URL, token: MISSKEY_TOKEN };
const defaults = { category: DEFAULT_CATEGORY || null, license: DEFAULT_LICENSE || null };
const approvalChannelId = (DISCORD_APPROVAL_CHANNEL_ID ?? '').trim() || null;

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EDIT_SESSION_TTL_MS = 15 * 60 * 1000;
const CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000;
const CATEGORY_NEW_VALUE = '__NEW__';

let categoryCache = { ts: 0, value: [] };

async function getCachedCategories() {
	const now = Date.now();
	if (now - categoryCache.ts < CATEGORY_CACHE_TTL_MS && categoryCache.value.length > 0) {
		return categoryCache.value;
	}
	try {
		const cats = await fetchAllCategories(misskeyConfig);
		categoryCache = { ts: now, value: cats };
		return cats;
	} catch (e) {
		console.error('[fetch categories]', e);
		return categoryCache.value;
	}
}

function hasApproverRole(member) {
	if (!member || approverRoleIds.size === 0) return false;
	if (member.roles?.cache) {
		for (const id of member.roles.cache.keys()) {
			if (approverRoleIds.has(id)) return true;
		}
	}
	return false;
}

function inlineCode(value) {
	const s = String(value ?? '').replace(/`/g, "'").trim();
	return '`' + (s.length ? s : '(未設定)') + '`';
}

function buildApprovalEmbed(key, state) {
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
		.setFooter({ text: `request_id: ${key}` })
		.addFields({ name: '申請者', value: inlineCode(`${state.submitterTag} (${state.submitterId})`), inline: true });

	if (status === 'approved' && state.approverTag) embed.addFields({ name: '承認者', value: inlineCode(state.approverTag), inline: false });
	if (status === 'rejected' && state.approverTag) embed.addFields({ name: '却下者', value: inlineCode(state.approverTag), inline: false });
	if (state.error) embed.addFields({ name: 'エラー', value: '```' + state.error.slice(0, 500).replace(/```/g, "'''") + '```' });
	return embed;
}

function buildApprovalButtons(key, status = 'pending') {
	if (status !== 'pending') {
		return new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`emoji-noop:${key}`).setLabel('処理済み').setStyle(ButtonStyle.Secondary).setDisabled(true),
		);
	}
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`emoji-approve:${key}`).setLabel('承認').setEmoji('✅').setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`emoji-reject:${key}`).setLabel('却下').setEmoji('❌').setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId(`emoji-edit:${key}`).setLabel('編集').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
	);
}

function buildSubmitterReceiptButtons(approvalKey) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`emoji-edit:${approvalKey}`).setLabel('編集').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
	);
}

function buildEditModal(approvalKey, currentMeta) {
	const modal = new ModalBuilder()
		.setCustomId(`emoji-edit-modal:${approvalKey}`)
		.setTitle('リクエストを編集');
	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder().setCustomId('name').setLabel('絵文字名 (小文字 a-z 0-9 _、大文字不可)').setStyle(TextInputStyle.Short)
				.setRequired(true).setMaxLength(128).setValue(currentMeta.name ?? '').setPlaceholder('kawaii_neko (大文字は使用できません)'),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder().setCustomId('tags').setLabel('タグ (カンマ区切り)').setStyle(TextInputStyle.Short)
				.setRequired(false).setMaxLength(256).setValue((currentMeta.aliases ?? []).join(', ')),
		),
		new ActionRowBuilder().addComponents(
			new TextInputBuilder().setCustomId('license').setLabel('ライセンス').setStyle(TextInputStyle.Short)
				.setRequired(false).setMaxLength(256).setValue(currentMeta.license ?? ''),
		),
	);
	return modal;
}

function buildCategorySelectComponents(approvalKey, categories) {
	const opts = [
		new StringSelectMenuOptionBuilder().setLabel('✨ 新規カテゴリを入力...').setValue(CATEGORY_NEW_VALUE).setDescription('テキスト入力モーダルが開きます').setEmoji('✨'),
		...categories.slice(0, 24).map(c =>
			new StringSelectMenuOptionBuilder().setLabel(c.slice(0, 100)).setValue(c.slice(0, 100))),
	];
	const select = new StringSelectMenuBuilder()
		.setCustomId(`emoji-cat-edit-select:${approvalKey}`)
		.setPlaceholder('カテゴリを選択')
		.setMinValues(1).setMaxValues(1)
		.addOptions(opts);
	return [new ActionRowBuilder().addComponents(select)];
}

function buildNewCategoryModal(approvalKey) {
	const modal = new ModalBuilder()
		.setCustomId(`emoji-cat-edit-new:${approvalKey}`)
		.setTitle('新規カテゴリ名');
	modal.addComponents(
		new ActionRowBuilder().addComponents(
			new TextInputBuilder().setCustomId('category').setLabel('カテゴリ').setStyle(TextInputStyle.Short)
				.setRequired(true).setMaxLength(128).setPlaceholder('例: animal, food, kawaii'),
		),
	);
	return modal;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
	console.log(`[ready] logged in as ${client.user.tag}`);
	if (approverRoleIds.size === 0) console.warn('[ready] WARNING: APPROVER_ROLE_IDS not set');
	console.log(`[ready] approval channel: ${approvalChannelId ?? '(inline)'}`);
	console.log(`[ready] target Misskey: ${MISSKEY_URL}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isChatInputCommand() && interaction.commandName === 'emoji') {
			const sub = interaction.options.getSubcommand();
			if (sub === 'add') return handleAddCommand(interaction);
			if (sub === 'edit') return handleEditCommand(interaction);
		}
		if (interaction.isAutocomplete() && interaction.commandName === 'emoji') {
			return handleAutocomplete(interaction);
		}
		if (interaction.isButton()) return handleButton(interaction);
		if (interaction.isStringSelectMenu() && interaction.customId.startsWith('emoji-cat-edit-select:')) {
			return handleCategoryEditSelect(interaction);
		}
		if (interaction.isModalSubmit()) {
			if (interaction.customId.startsWith('emoji-edit-modal:')) return handleEditModalSubmit(interaction);
			if (interaction.customId.startsWith('emoji-cat-edit-new:')) return handleNewCategoryEditModalSubmit(interaction);
		}
	} catch (e) {
		console.error('[interaction error]', e);
		try {
			if (interaction.deferred || interaction.replied) {
				await interaction.followUp({ content: `❌ エラー: ${e.message}`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `❌ エラー: ${e.message}`, flags: MessageFlags.Ephemeral });
			}
		} catch {}
	}
});

async function handleAddCommand(interaction) {
	const attachment = interaction.options.getAttachment('image', true);
	const category = interaction.options.getString('category', true).trim();
	const nameInput = (interaction.options.getString('name') ?? '').trim();
	const tags = (interaction.options.getString('tags') ?? '').trim();
	const license = (interaction.options.getString('license') ?? '').trim();
	const sensitive = interaction.options.getBoolean('sensitive') ?? false;
	const localOnly = interaction.options.getBoolean('localonly') ?? false;

	if (!ALLOWED_TYPES.has(attachment.contentType ?? '')) {
		await interaction.reply({ content: `❌ 対応していない画像タイプです: \`${attachment.contentType ?? 'unknown'}\``, flags: MessageFlags.Ephemeral });
		return;
	}

	let name = nameInput || sanitizeEmojiName(attachment.name);
	if (!isValidEmojiName(name)) name = sanitizeEmojiName(name);
	if (!isValidEmojiName(name)) {
		await interaction.reply({ content: `❌ 絵文字名を決められませんでした。a-z 0-9 _ のみ使用可能です。`, flags: MessageFlags.Ephemeral });
		return;
	}

	if (!category) {
		await interaction.reply({ content: '❌ カテゴリは必須です。', flags: MessageFlags.Ephemeral });
		return;
	}

	const meta = {
		name, category,
		aliases: tags ? tags.split(/[,、]/).map(s => s.trim()).filter(Boolean) : [],
		license: license || undefined,
		isSensitive: sensitive,
		localOnly,
	};

	const approvalKey = newKey();
	const targetChannelId = approvalChannelId || interaction.channelId;
	const approvalState = {
		submitterId: interaction.user.id,
		submitterTag: interaction.user.tag,
		channelId: interaction.channelId,
		attachment: { name: attachment.name, url: attachment.url, contentType: attachment.contentType },
		meta,
		status: 'pending',
		approvalChannelId: targetChannelId,
		submitterInteractionToken: interaction.token,
	};
	put(approvalKey, approvalState, APPROVAL_TTL_MS);

	try {
		const channel = await client.channels.fetch(targetChannelId);
		const payload = {
			embeds: [buildApprovalEmbed(approvalKey, approvalState)],
			components: [buildApprovalButtons(approvalKey, 'pending')],
		};
		if (approvalChannelId) {
			payload.content = `📥 <@${interaction.user.id}> から絵文字登録の申請があります`;
			payload.allowedMentions = { users: [] };
		}
		const posted = await channel.send(payload);
		update(approvalKey, s => ({ ...s, approvalMessageId: posted.id }), APPROVAL_TTL_MS);
	} catch (e) {
		console.error('[post approval-message]', e);
	}

	await interaction.reply({
		content: `📥 申請を受け付けました (request_id: \`${approvalKey}\`)。承認をお待ちください。`,
		embeds: [buildApprovalEmbed(approvalKey, approvalState)],
		components: [buildSubmitterReceiptButtons(approvalKey)],
		flags: MessageFlags.Ephemeral,
	});
}

async function handleEditCommand(interaction) {
	const approvalKey = interaction.options.getString('request_id', true);
	const current = peek(approvalKey);
	if (!current) {
		await interaction.reply({ content: '⏱ そのリクエストは存在しないか期限切れです。', flags: MessageFlags.Ephemeral });
		return;
	}
	if (current.status !== 'pending') {
		await interaction.reply({ content: `このリクエストは既に \`${current.status}\` です。`, flags: MessageFlags.Ephemeral });
		return;
	}
	const userId = interaction.user.id;
	const isSubmitter = userId === current.submitterId;
	const isApprover = hasApproverRole(interaction.member);
	if (!isSubmitter && !isApprover) {
		await interaction.reply({ content: '🔒 編集権限がありません (申請者または承認者のみ)', flags: MessageFlags.Ephemeral });
		return;
	}

	const newMeta = { ...current.meta };
	const name = interaction.options.getString('name');
	const category = interaction.options.getString('category');
	const tags = interaction.options.getString('tags');
	const license = interaction.options.getString('license');
	const sensitive = interaction.options.getBoolean('sensitive');
	const localonly = interaction.options.getBoolean('localonly');

	if (name !== null) {
		let n = name.trim();
		if (!isValidEmojiName(n)) n = sanitizeEmojiName(n);
		if (!isValidEmojiName(n)) {
			await interaction.reply({ content: '❌ 絵文字名が不正です。', flags: MessageFlags.Ephemeral });
			return;
		}
		newMeta.name = n;
	}
	if (category !== null) newMeta.category = category.trim();
	if (tags !== null) newMeta.aliases = tags ? tags.split(/[,、]/).map(s => s.trim()).filter(Boolean) : [];
	if (license !== null) newMeta.license = license || undefined;
	if (sensitive !== null) newMeta.isSensitive = sensitive;
	if (localonly !== null) newMeta.localOnly = localonly;

	const updated = update(approvalKey, s => ({ ...s, meta: newMeta, error: undefined }), APPROVAL_TTL_MS);
	await patchApprovalMessage(updated, approvalKey);
	await patchSubmitterReceipt(updated, approvalKey);
	await interaction.reply({ content: `✏️ 編集を保存しました (request_id: \`${approvalKey}\`)`, flags: MessageFlags.Ephemeral });
}

async function handleAutocomplete(interaction) {
	const focused = interaction.options.getFocused(true);
	if (focused.name === 'category') return autocompleteCategory(interaction, focused.value);
	if (focused.name === 'request_id') return autocompleteRequestId(interaction, focused.value);
	await interaction.respond([]);
}

async function autocompleteCategory(interaction, query) {
	const q = (query ?? '').trim();
	const lower = q.toLowerCase();
	const categories = await getCachedCategories();
	let matches = lower ? categories.filter(c => c.toLowerCase().includes(lower)) : categories.slice();
	matches = matches.slice(0, 25);
	if (q && !categories.some(c => c.toLowerCase() === lower)) {
		if (matches.length === 25) matches.pop();
		matches.unshift(`✨ 新規: ${q.slice(0, 80)}`);
	}
	const choices = matches.map(m => {
		const isNew = m.startsWith('✨ 新規: ');
		const value = isNew ? m.slice('✨ 新規: '.length) : m;
		return { name: m.slice(0, 100), value: value.slice(0, 100) };
	});
	await interaction.respond(choices);
}

async function autocompleteRequestId(interaction, query) {
	const q = (query ?? '').trim().toLowerCase();
	const isApprover = hasApproverRole(interaction.member);
	const pending = listPendingApprovals(interaction.user.id, isApprover);
	const matches = pending.filter(p =>
		!q
		|| p.key.toLowerCase().includes(q)
		|| (p.meta?.name ?? '').toLowerCase().includes(q)
		|| (p.meta?.category ?? '').toLowerCase().includes(q)
	).slice(0, 25);
	await interaction.respond(matches.map(p => ({
		name: `${p.meta?.name ?? '???'} (${p.meta?.category ?? '-'}) — ${p.key}`.slice(0, 100),
		value: p.key,
	})));
}

async function handleButton(interaction) {
	const customId = interaction.customId;
	let action, key;
	if (customId.startsWith('emoji-approve:')) { action = 'approve'; key = customId.slice('emoji-approve:'.length); }
	else if (customId.startsWith('emoji-reject:')) { action = 'reject'; key = customId.slice('emoji-reject:'.length); }
	else if (customId.startsWith('emoji-edit:')) { action = 'edit'; key = customId.slice('emoji-edit:'.length); }
	else return;

	const current = peek(key);
	if (!current) {
		await interaction.reply({ content: '⏱ このリクエストは期限切れ or 既に処理済みです。', flags: MessageFlags.Ephemeral });
		return;
	}
	if (current.status !== 'pending') {
		await interaction.reply({ content: `このリクエストは既に \`${current.status}\` です。`, flags: MessageFlags.Ephemeral });
		return;
	}

	const userId = interaction.user.id;
	const isSubmitter = userId === current.submitterId;
	const isApprover = hasApproverRole(interaction.member);

	if (action === 'edit') {
		if (!isSubmitter && !isApprover) {
			await interaction.reply({ content: '🔒 編集権限がありません (申請者または承認者のみ)', flags: MessageFlags.Ephemeral });
			return;
		}
		await interaction.showModal(buildEditModal(key, current.meta));
		return;
	}

	if (!isApprover) {
		await interaction.reply({ content: '🔒 承認権限がありません。', flags: MessageFlags.Ephemeral });
		return;
	}

	const approverTag = interaction.user.tag;

	if (action === 'reject') {
		const updated = update(key, s => ({ ...s, status: 'rejected', approverTag, approverId: userId }), APPROVAL_TTL_MS);
		await interaction.update({
			embeds: [buildApprovalEmbed(key, updated)],
			components: [buildApprovalButtons(key, 'rejected')],
		});
		await patchSubmitterReceipt(updated, key);
		await notifySubmitter(updated, 'rejected', approverTag, null);
		return;
	}

	// approve
	await interaction.deferUpdate();
	const result = await registerEmojiFromAttachment({
		attachment: current.attachment, meta: current.meta, defaults, config: misskeyConfig,
	});
	if (result.ok) {
		const updated = update(key, s => ({
			...s, status: 'approved', approverTag, approverId: userId,
			registeredName: result.name, registeredId: result.id,
		}), APPROVAL_TTL_MS);
		await interaction.editReply({
			embeds: [buildApprovalEmbed(key, updated)],
			components: [buildApprovalButtons(key, 'approved')],
		});
		console.log(`[approved] ${current.attachment.name} -> :${result.name}: by ${approverTag}`);
		await patchSubmitterReceipt(updated, key);
		await notifySubmitter(updated, 'approved', approverTag, result.name);
		remove(key);
	} else {
		const updated = update(key, s => ({ ...s, status: 'pending', error: result.error }), APPROVAL_TTL_MS);
		await interaction.editReply({
			embeds: [buildApprovalEmbed(key, updated)],
			components: [buildApprovalButtons(key, 'pending')],
		});
		await patchSubmitterReceipt(updated, key);
		console.log(`[approve-failed] ${current.attachment.name}: ${result.error}`);
	}
}

async function handleEditModalSubmit(interaction) {
	const approvalKey = interaction.customId.slice('emoji-edit-modal:'.length);
	const current = peek(approvalKey);
	if (!current) {
		await interaction.reply({ content: '⏱ このリクエストは期限切れ or 処理済みです。', flags: MessageFlags.Ephemeral });
		return;
	}
	const isSubmitter = interaction.user.id === current.submitterId;
	const isApprover = hasApproverRole(interaction.member);
	if (!isSubmitter && !isApprover) {
		await interaction.reply({ content: '🔒 編集権限がありません', flags: MessageFlags.Ephemeral });
		return;
	}

	put(`edit-session:${approvalKey}`, {
		name: interaction.fields.getTextInputValue('name'),
		tags: interaction.fields.getTextInputValue('tags'),
		license: interaction.fields.getTextInputValue('license'),
		editorId: interaction.user.id,
	}, EDIT_SESSION_TTL_MS);

	const categories = await getCachedCategories();
	await interaction.reply({
		content: `📁 **新しいカテゴリを選んでください** (現在: \`${current.meta?.category || '未設定'}\`)`,
		components: buildCategorySelectComponents(approvalKey, categories),
		flags: MessageFlags.Ephemeral,
	});
}

async function handleCategoryEditSelect(interaction) {
	const approvalKey = interaction.customId.slice('emoji-cat-edit-select:'.length);
	const editSession = peek(`edit-session:${approvalKey}`);
	if (!editSession) {
		await interaction.update({ content: '⏱ 編集セッションが期限切れです。', components: [] });
		return;
	}
	const selected = interaction.values?.[0];
	if (!selected) return;
	if (selected === CATEGORY_NEW_VALUE) {
		await interaction.showModal(buildNewCategoryModal(approvalKey));
		return;
	}
	await finalizeEdit(interaction, approvalKey, editSession, selected, /* isModalSubmit */ false);
}

async function handleNewCategoryEditModalSubmit(interaction) {
	const approvalKey = interaction.customId.slice('emoji-cat-edit-new:'.length);
	const editSession = peek(`edit-session:${approvalKey}`);
	if (!editSession) {
		await interaction.reply({ content: '⏱ 編集セッションが期限切れです。', flags: MessageFlags.Ephemeral });
		return;
	}
	const category = interaction.fields.getTextInputValue('category').trim();
	if (!category) {
		await interaction.reply({ content: 'カテゴリを入力してください。', flags: MessageFlags.Ephemeral });
		return;
	}
	await finalizeEdit(interaction, approvalKey, editSession, category, /* isModalSubmit */ true);
}

async function finalizeEdit(interaction, approvalKey, editSession, category, isModalSubmit) {
	const current = peek(approvalKey);
	if (!current || current.status !== 'pending') {
		const msg = '⏱ このリクエストは期限切れ or 処理済みです。';
		if (isModalSubmit) await interaction.update({ content: msg, components: [] });
		else await interaction.update({ content: msg, components: [] });
		remove(`edit-session:${approvalKey}`);
		return;
	}

	let name = editSession.name?.trim() || current.meta.name;
	if (!isValidEmojiName(name)) name = sanitizeEmojiName(name);
	const aliases = editSession.tags ? editSession.tags.split(/[,、]/).map(t => t.trim()).filter(Boolean) : [];
	const license = editSession.license?.trim() || undefined;

	const updated = update(approvalKey, s => ({
		...s,
		meta: { ...s.meta, name, category, aliases, license },
		error: undefined,
	}), APPROVAL_TTL_MS);

	remove(`edit-session:${approvalKey}`);
	await patchApprovalMessage(updated, approvalKey);
	await patchSubmitterReceipt(updated, approvalKey);

	const confirmation = { content: `✏️ 編集を保存しました (カテゴリ: \`${category}\`)`, components: [] };
	await interaction.update(confirmation);
}

async function patchSubmitterReceipt(state, approvalKey) {
	if (!state?.submitterInteractionToken) return;
	const applicationId = client.application?.id;
	if (!applicationId) return;
	const body = {
		embeds: [buildApprovalEmbed(approvalKey, state).toJSON()],
		components: state.status === 'pending'
			? [buildSubmitterReceiptButtons(approvalKey).toJSON()]
			: [],
	};
	try {
		const res = await fetch(
			`https://discord.com/api/v10/webhooks/${applicationId}/${state.submitterInteractionToken}/messages/@original`,
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

async function patchApprovalMessage(state, approvalKey) {
	if (!state?.approvalChannelId || !state?.approvalMessageId) return;
	try {
		const channel = await client.channels.fetch(state.approvalChannelId);
		const msg = await channel.messages.fetch(state.approvalMessageId);
		await msg.edit({
			embeds: [buildApprovalEmbed(approvalKey, state)],
			components: [buildApprovalButtons(approvalKey, state.status)],
		});
	} catch (e) {
		console.error('[patch approval-message]', e);
	}
}

async function notifySubmitter(state, status, approverTag, registeredName) {
	if (!state?.channelId) return;
	if (state.channelId === state.approvalChannelId) return;
	const mention = `<@${state.submitterId}>`;
	let content;
	if (status === 'approved') content = `✅ ${mention} 申請された絵文字 \`:${registeredName}:\` が登録されました (by ${approverTag})`;
	else if (status === 'rejected') content = `❌ ${mention} 申請が却下されました (by ${approverTag})`;
	else return;
	try {
		const channel = await client.channels.fetch(state.channelId);
		await channel.send({ content, allowedMentions: { users: [state.submitterId] } });
	} catch (e) {
		console.error('[notify failed]', e);
	}
}

client.login(DISCORD_TOKEN);
