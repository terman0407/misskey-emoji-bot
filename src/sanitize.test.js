import { sanitizeEmojiName, isValidEmojiName, parseMessageMeta } from './sanitize.js';

const cases = [
	['Hello.png', 'hello'],
	['かわいい猫.gif', ''],
	['Cat_v2-final.PNG', 'cat_v2_final'],
	['  spaced name  .webp', 'spaced_name'],
	['MULTI___underscore.apng', 'multi_underscore'],
	['123abc.png', '123abc'],
	['-_-.png', ''],
];

let fail = 0;
for (const [input, expected] of cases) {
	const actual = sanitizeEmojiName(input);
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} sanitize(${JSON.stringify(input)}) = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
	if (!ok) fail++;
}

const validity = [
	['hello', true],
	['', false],
	['hello world', false],
	['CamelCase', true],
	['123', true],
	['-bad', false],
];
for (const [input, expected] of validity) {
	const actual = isValidEmojiName(input);
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} isValid(${JSON.stringify(input)}) = ${actual} (expected ${expected})`);
	if (!ok) fail++;
}

const meta = parseMessageMeta(`name: kawaii_neko
category: 動物
tags: cat, cute, ねこ
license: CC0
sensitive: true`);
const metaExpected = { name: 'kawaii_neko', category: '動物', aliases: ['cat', 'cute', 'ねこ'], license: 'CC0', isSensitive: true };
const metaOk = JSON.stringify(meta) === JSON.stringify(metaExpected);
console.log(`${metaOk ? 'OK ' : 'NG '} parseMessageMeta = ${JSON.stringify(meta)}`);
if (!metaOk) fail++;

if (fail > 0) {
	console.error(`\n${fail} test(s) failed`);
	process.exit(1);
}
console.log('\nall tests passed');
