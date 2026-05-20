import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { sanitizeEmojiName } from '../sanitize.js';
import { ALLOWED_TYPES } from '../register.js';
import { put, take, peek, newKey } from '../state.js';
import { createApproval, buildApprovalEmbed, buildApprovalButtons, buildSubmitterReceiptButtons, postApprovalMessage } from '../approvals.js';
import { update as updateState } from '../state.js';

export const data = new SlashCommandBuilder()
	.setName('emoji')
	.setDescription('Misskey カスタム絵文字を登録します')
	.setDMPermission(false)
	.addSubcommand(sub => sub
		.setName('add')
		.setDescription('画像を Misskey にカスタム絵文字として登録 (承認制)')
		.addAttachmentOption(o => o
			.setName('image')
			.setDescription('絵文字にする画像 (PNG/GIF/WEBP/APNG/JPEG)')
			.setRequired(true))
		.addBooleanOption(o => o
			.setName('sensitive')
			.setDescription('センシティブ扱いにする')
			.setRequired(false))
		.addBooleanOption(o => o
			.setName('localonly')
			.setDescription('ローカル限定 (連合しない)')
			.setRequired(false)));

const MODAL_PREFIX = 'emoji-add:';

export async function handleSlashCommand(interaction) {
	if (interaction.commandName !== 'emoji') return false;
	if (interaction.options.getSubcommand() !== 'add') return false;

	const attachment = interaction.options.getAttachment('image', true);
	const sensitive = interaction.options.getBoolean('sensitive') ?? false;
	const localOnly = interaction.options.getBoolean('localonly') ?? false;

	if (!ALLOWED_TYPES.has(attachment.contentType ?? '')) {
		await interaction.reply({
			content: `❌ 対応していない画像タイプです: \`${attachment.contentType ?? 'unknown'}\``,
			flags: MessageFlags.Ephemeral,
		});
		return true;
	}

	const key = newKey();
	put(key, { attachment: serializeAttachment(attachment), sensitive, localOnly });

	const defaultName = sanitizeEmojiName(attachment.name);

	const modal = new ModalBuilder()
		.setCustomId(`${MODAL_PREFIX}${key}`)
		.setTitle('カスタム絵文字の登録 (申請)');

	const nameInput = new TextInputBuilder()
		.setCustomId('name')
		.setLabel('絵文字名 (a-z 0-9 _)')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(128)
		.setPlaceholder('kawaii_neko');
	if (defaultName) nameInput.setValue(defaultName);

	const categoryInput = new TextInputBuilder()
		.setCustomId('category')
		.setLabel('カテゴリ (任意)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(128);

	const tagsInput = new TextInputBuilder()
		.setCustomId('tags')
		.setLabel('タグ (任意、カンマ区切り)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(256)
		.setPlaceholder('cat, cute, ねこ');

	const licenseInput = new TextInputBuilder()
		.setCustomId('license')
		.setLabel('ライセンス (任意)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(256);

	modal.addComponents(
		new ActionRowBuilder().addComponents(nameInput),
		new ActionRowBuilder().addComponents(categoryInput),
		new ActionRowBuilder().addComponents(tagsInput),
		new ActionRowBuilder().addComponents(licenseInput),
	);

	await interaction.showModal(modal);
	return true;
}

export async function handleModalSubmit(interaction, ctx) {
	if (!interaction.customId.startsWith(MODAL_PREFIX)) return false;

	const key = interaction.customId.slice(MODAL_PREFIX.length);
	const session = take(key);
	if (!session) {
		await interaction.reply({
			content: '⏱ セッションが期限切れです。`/emoji add` をやり直してください。',
			flags: MessageFlags.Ephemeral,
		});
		return true;
	}

	const name = interaction.fields.getTextInputValue('name').trim();
	const category = interaction.fields.getTextInputValue('category').trim();
	const tagsRaw = interaction.fields.getTextInputValue('tags').trim();
	const license = interaction.fields.getTextInputValue('license').trim();

	const meta = {
		name,
		category: category || undefined,
		aliases: tagsRaw ? tagsRaw.split(/[,、]/).map(s => s.trim()).filter(Boolean) : [],
		license: license || undefined,
		isSensitive: session.sensitive,
		localOnly: session.localOnly,
	};

	const approvalKey = createApproval({
		submitterId: interaction.user.id,
		submitterTag: interaction.user.tag,
		channelId: interaction.channelId,
		attachment: session.attachment,
		meta,
	});
	const state = peek(approvalKey);

	const posted = await postApprovalMessage({ client: interaction.client, ctx, key: approvalKey, state });

	if (posted.location === 'approval-channel') {
		await interaction.reply({
			content: '📥 申請を受け付けました。承認をお待ちください。',
			components: [buildSubmitterReceiptButtons(approvalKey)],
			flags: MessageFlags.Ephemeral,
		});
	} else {
		const reply = await interaction.reply({ ...posted.payload, fetchReply: true });
		updateState(approvalKey, s => ({ ...s, approvalMessageId: reply.id, approvalChannelId: interaction.channelId }), 7 * 24 * 60 * 60 * 1000);
	}

	return true;
}

function serializeAttachment(att) {
	return {
		name: att.name,
		url: att.url,
		contentType: att.contentType,
	};
}
