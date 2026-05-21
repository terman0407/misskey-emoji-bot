import { verifyDiscordRequest } from './verify.js';
import {
	InteractionType,
	InteractionResponseType,
	json,
} from './discord.js';
import {
	handleSlashCommand,
	handleAddModalSubmit,
	handleButton,
	handleEditModalSubmit,
} from './handlers.js';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/') {
			return new Response('misskey-emoji-bot (HTTP Interactions)\n', {
				headers: { 'content-type': 'text/plain' },
			});
		}

		if (request.method !== 'POST' || url.pathname !== '/interactions') {
			return new Response('Not found', { status: 404 });
		}

		const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
		if (!valid) {
			return new Response('invalid request signature', { status: 401 });
		}

		const interaction = JSON.parse(body);

		try {
			if (interaction.type === InteractionType.PING) {
				return json({ type: InteractionResponseType.PONG });
			}

			if (interaction.type === InteractionType.APPLICATION_COMMAND) {
				return json(await handleSlashCommand(interaction, env, ctx));
			}

			if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
				return json(await handleButton(interaction, env, ctx));
			}

			if (interaction.type === InteractionType.MODAL_SUBMIT) {
				const customId = interaction.data.custom_id;
				if (customId.startsWith('emoji-edit-modal:')) {
					return json(await handleEditModalSubmit(interaction, env, ctx, customId.slice('emoji-edit-modal:'.length)));
				}
				if (customId.startsWith('emoji-add:')) {
					return json(await handleAddModalSubmit(interaction, env, ctx, customId.slice('emoji-add:'.length)));
				}
				return json({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: 'Unknown modal', flags: 64 },
				});
			}

			return new Response('unsupported interaction type', { status: 400 });
		} catch (e) {
			console.error('[interaction error]', e);
			return json({
				type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
				data: { content: `❌ エラー: ${e.message ?? 'unknown'}`, flags: 64 },
			});
		}
	},
};
