import dotenv from 'dotenv';
import { REST, Routes } from 'discord.js';
import { data as emojiCommand } from '../src/commands/emoji.js';

// Load .env if present, then fall back to the Cloudflare Workers local secrets
// file (.dev.vars). dotenv.config() never overrides already-set vars, so real
// environment > .env > .dev.vars.
dotenv.config();
dotenv.config({ path: '.dev.vars' });

const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
// Discord's "Client ID" and "Application ID" are the same value.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
	console.error('DISCORD_TOKEN and (DISCORD_CLIENT_ID or DISCORD_APPLICATION_ID) are required');
	process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const body = [emojiCommand.toJSON()];

const route = DISCORD_GUILD_ID
	? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
	: Routes.applicationCommands(DISCORD_CLIENT_ID);

const scope = DISCORD_GUILD_ID ? `guild ${DISCORD_GUILD_ID}` : 'global (反映に最大1時間)';
console.log(`[register] target: ${scope}`);

try {
	const data = await rest.put(route, { body });
	console.log(`[register] OK: ${Array.isArray(data) ? data.length : 0} commands registered`);
	for (const c of data ?? []) console.log(`  /${c.name}  (id=${c.id})`);
} catch (e) {
	console.error('[register] failed:', e);
	process.exit(1);
}
