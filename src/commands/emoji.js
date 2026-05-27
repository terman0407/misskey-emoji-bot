import { SlashCommandBuilder } from 'discord.js';

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
		.addStringOption(o => o
			.setName('category')
			.setDescription('カテゴリ (タイプして検索 / 新規も可)')
			.setRequired(true)
			.setAutocomplete(true))
		.addStringOption(o => o
			.setName('name')
			.setDescription('絵文字名 (a-z 0-9 _。省略時はファイル名から生成)')
			.setRequired(false)
			.setMaxLength(128))
		.addStringOption(o => o
			.setName('tags')
			.setDescription('タグ (カンマ区切り)')
			.setRequired(false)
			.setMaxLength(256))
		.addStringOption(o => o
			.setName('license')
			.setDescription('ライセンス')
			.setRequired(false)
			.setMaxLength(256))
		.addBooleanOption(o => o
			.setName('sensitive')
			.setDescription('センシティブ扱いにする')
			.setRequired(false))
		.addBooleanOption(o => o
			.setName('localonly')
			.setDescription('ローカル限定 (連合しない)')
			.setRequired(false)))
	.addSubcommand(sub => sub
		.setName('edit')
		.setDescription('保留中の絵文字申請を編集')
		.addStringOption(o => o
			.setName('request_id')
			.setDescription('編集する申請の ID (タイプで絞り込み)')
			.setRequired(true)
			.setAutocomplete(true))
		.addStringOption(o => o
			.setName('name')
			.setDescription('絵文字名 (小文字 a-z 0-9 _ のみ。大文字不可)')
			.setRequired(false)
			.setMaxLength(128))
		.addStringOption(o => o
			.setName('category')
			.setDescription('カテゴリ (タイプして検索 / 新規も可)')
			.setRequired(false)
			.setAutocomplete(true))
		.addStringOption(o => o
			.setName('tags')
			.setDescription('タグ (カンマ区切り)')
			.setRequired(false)
			.setMaxLength(256))
		.addStringOption(o => o
			.setName('license')
			.setDescription('ライセンス')
			.setRequired(false)
			.setMaxLength(256))
		.addBooleanOption(o => o
			.setName('sensitive')
			.setDescription('センシティブ扱いにする')
			.setRequired(false))
		.addBooleanOption(o => o
			.setName('localonly')
			.setDescription('ローカル限定 (連合しない)')
			.setRequired(false)));
