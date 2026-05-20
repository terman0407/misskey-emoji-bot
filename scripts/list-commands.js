import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
	console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required');
	process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

console.log(`client_id=${DISCORD_CLIENT_ID}`);
console.log(`guild_id=${DISCORD_GUILD_ID ?? '(none)'}`);

console.log('\n=== GLOBAL commands ===');
const global = await rest.get(Routes.applicationCommands(DISCORD_CLIENT_ID));
console.log(JSON.stringify(global, null, 2));

if (DISCORD_GUILD_ID) {
	console.log(`\n=== GUILD ${DISCORD_GUILD_ID} commands ===`);
	const guild = await rest.get(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID));
	console.log(JSON.stringify(guild, null, 2));
}
