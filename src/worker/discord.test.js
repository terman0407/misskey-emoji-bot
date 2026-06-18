import {
	unwrapUserMentions,
	buildCategoryOptions,
	readModalField,
	readModalSelect,
	readModalValues,
} from './discord.js';

const resolved = {
	users: {
		'922784856423940146': { username: 'fun_t_g', global_name: 'Fun' },
	},
};

const cases = [
	// The reported bug: Discord converted `@fun_t_g` into a mention token.
	['<@922784856423940146>@misskey.design', resolved, '@fun_t_g@misskey.design'],
	// Bang form (`<@!id>`) is treated the same.
	['<@!922784856423940146>@misskey.design', resolved, '@fun_t_g@misskey.design'],
	// Unknown id (not in resolved) is left untouched rather than guessed.
	['<@111>@misskey.design', resolved, '<@111>@misskey.design'],
	// Falls back to username when present, ignores global_name.
	['<@922784856423940146>', resolved, '@fun_t_g'],
	// Plain text passes through unchanged.
	['CC0', resolved, 'CC0'],
	['@plain@misskey.design', resolved, '@plain@misskey.design'],
	// Nullish input is preserved.
	[undefined, resolved, undefined],
	[null, resolved, null],
	// Missing resolved data leaves tokens intact.
	['<@922784856423940146>', undefined, '<@922784856423940146>'],
];

let fail = 0;
for (const [input, res, expected] of cases) {
	const actual = unwrapUserMentions(input, res);
	const ok = actual === expected;
	console.log(`${ok ? 'OK ' : 'NG '} unwrapUserMentions(${JSON.stringify(input)}) = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
	if (!ok) fail++;
}

// --- buildCategoryOptions ---
function eq(actual, expected, label) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`${ok ? 'OK ' : 'NG '} ${label} = ${JSON.stringify(actual)}`);
	if (!ok) {
		console.log(`     expected ${JSON.stringify(expected)}`);
		fail++;
	}
}

eq(buildCategoryOptions(['a', 'a', '', 'b']), [
	{ label: 'a', value: 'a' },
	{ label: 'b', value: 'b' },
], 'buildCategoryOptions dedupes and drops empty');

eq(buildCategoryOptions(['a', 'b'], 'b'), [
	{ label: 'a', value: 'a' },
	{ label: 'b', value: 'b', default: true },
], 'buildCategoryOptions marks current as default');

eq(buildCategoryOptions(['a', 'b'], 'zzz'), [
	{ label: 'zzz', value: 'zzz', default: true },
	{ label: 'a', value: 'a' },
	{ label: 'b', value: 'b' },
], 'buildCategoryOptions prepends out-of-list current');

eq(buildCategoryOptions(Array.from({ length: 30 }, (_, i) => `c${i}`)).length, 25,
	'buildCategoryOptions caps at 25');

// --- modal readers: tolerate Label-wrapped (new) and action-row (legacy) shapes ---
const newFormatSubmit = {
	data: {
		components: [
			{ type: 18, component: { type: 4, custom_id: 'license', value: '@fun_t_g@misskey.design' } },
			{ type: 18, component: { type: 3, custom_id: 'category_select', values: ['animal'] } },
			// checkbox group returns checked values under `value` as an array
			{ type: 18, component: { type: 22, custom_id: 'options', value: ['sensitive'] } },
		],
	},
};
eq(readModalField(newFormatSubmit, 'license'), '@fun_t_g@misskey.design', 'readModalField (Label/text)');
eq(readModalSelect(newFormatSubmit, 'category_select'), 'animal', 'readModalSelect (Label/select)');
eq(readModalValues(newFormatSubmit, 'options'), ['sensitive'], 'readModalValues (checkbox group, value array)');
eq(readModalValues(newFormatSubmit, 'missing'), [], 'readModalValues (absent) → []');

const legacyFormatSubmit = {
	data: {
		components: [
			{ type: 1, components: [{ type: 4, custom_id: 'name', value: 'kawaii_neko' }] },
		],
	},
};
eq(readModalField(legacyFormatSubmit, 'name'), 'kawaii_neko', 'readModalField (legacy action row)');

// single checkbox returns a string "true"/"false"
const singleCheckbox = { data: { components: [{ type: 18, component: { type: 23, custom_id: 'agree', value: 'true' } }] } };
eq(readModalValues(singleCheckbox, 'agree'), ['true'], 'readModalValues (single checkbox string)');

if (fail > 0) {
	console.error(`\n${fail} test(s) failed`);
	process.exit(1);
}
console.log('\nall tests passed');
