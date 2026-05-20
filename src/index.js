import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { handleSlashCommand, handleModalSubmit as handleEmojiAddModal } from './commands/emoji.js';
import { handleButton as handleApprovalButton, handleEditModalSubmit, MODAL_EDIT } from './approvals.js';

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
const approvalCtx = { misskeyConfig, defaults, approverRoleIds, approvalChannelId };

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
	],
});

client.once('clientReady', () => {
	console.log(`[ready] logged in as ${client.user.tag}`);
	if (approverRoleIds.size > 0) {
		console.log(`[ready] approver roles: ${[...approverRoleIds].join(', ')}`);
	} else {
		console.warn('[ready] WARNING: APPROVER_ROLE_IDS not set — no one will be able to approve requests');
	}
	if (approvalChannelId) {
		console.log(`[ready] approval channel: ${approvalChannelId}`);
	} else {
		console.log('[ready] approval channel: (inline — same channel where /emoji add is invoked)');
	}
	console.log(`[ready] target Misskey: ${MISSKEY_URL}`);
});

client.on('raw', (packet) => {
	if (packet.t === 'INTERACTION_CREATE') {
		const d = packet.d ?? {};
		console.log(`[raw INTERACTION_CREATE] type=${d.type} appId=${d.application_id} name=${d.data?.name ?? '-'} customId=${d.data?.custom_id ?? '-'}`);
	}
});

client.on('interactionCreate', async (interaction) => {
	console.log(`[interaction] type=${interaction.type} cmd=${interaction.commandName ?? '-'} customId=${interaction.customId ?? '-'} user=${interaction.user.tag}`);
	try {
		if (interaction.isChatInputCommand()) {
			await handleSlashCommand(interaction);
			return;
		}
		if (interaction.isButton()) {
			await handleApprovalButton(interaction, approvalCtx);
			return;
		}
		if (interaction.isModalSubmit()) {
			if (interaction.customId.startsWith(MODAL_EDIT)) {
				await handleEditModalSubmit(interaction, approvalCtx);
			} else {
				await handleEmojiAddModal(interaction, approvalCtx);
			}
			return;
		}
	} catch (e) {
		console.error('[interaction failed]', e);
		try {
			if (interaction.deferred || interaction.replied) {
				await interaction.followUp({ content: `❌ エラー: ${e.message}`, ephemeral: true });
			} else {
				await interaction.reply({ content: `❌ エラー: ${e.message}`, ephemeral: true });
			}
		} catch {}
	}
});

client.login(DISCORD_TOKEN);
