# misskey-emoji-bot

Discord から **Misskey カスタム絵文字** を承認制で登録できる Bot です。
`/emoji add` で画像とメタデータを送ると、承認用チャンネルにリクエストが投稿され、
承認ロールを持つメンバーが ✅ 承認 / ❌ 却下 / ✏️ 編集 のボタンで処理できます。

## 主な機能

- **`/emoji add`** スラッシュコマンドで 1 コマンド申請 (画像 + カテゴリ + 任意で名前 / タグ / ライセンス / sensitive / localonly)
- **カテゴリ autocomplete** — タイプで Misskey 上の既存カテゴリを検索、「✨ 新規」で新規作成も可
- 申請内容は **承認チャンネル** に Embed + ボタン付きで投稿
- ✅ **承認** で Misskey ドライブへアップロード→ `admin/emoji/add` で登録
- ❌ **却下**
- ✏️ **編集** ボタン (申請者または承認者) → モーダル (名前/タグ/ライセンス) → カテゴリ select (検索付き) → 確定
- `/emoji edit request_id:<autocomplete>` でコマンドからも編集可
- 申請者には元チャンネルで承認結果を通知 (メンション付き)
- Misskey 側のエラーコード (`DUPLICATE_NAME`, `INAPPROPRIATE` 等) を日本語に翻訳して表示
- 絵文字名のサニタイズ (`a-z 0-9 _` 以外を `_` に置換)
- 申請の有効期限: 7 日 (Workers KV の TTL で自動削除)

## 動作モード

| モード | エントリ | 用途 |
| --- | --- | --- |
| **Cloudflare Workers (HTTP Interactions)** ✅ 推奨 | [src/worker/](src/worker/) | サーバーレス。常時起動不要、無料枠で運用可 |
| **Gateway (`discord.js` / WebSocket)** | [src/index.js](src/index.js) | 自前ホスト (VPS や Docker)。state はインメモリ |

どちらも `/emoji add` / `/emoji edit` / 承認・却下・編集ボタン / カテゴリ autocomplete に対応。スラッシュコマンド定義 ([src/commands/emoji.js](src/commands/emoji.js)) は共有。

## 必要なもの

- **Node.js v24 以上** (ローカル開発と `npm run register` のため)
- **Cloudflare アカウント** (Workers デプロイ用、無料プランで OK)
- **Discord Bot** ([Discord Developer Portal](https://discord.com/developers/applications) で作成)
  - Bot Token
  - Application (Client) ID
  - **Public Key** (HTTP Interactions の署名検証で必須)
  - サーバーに招待するときに `bot` + `applications.commands` スコープ
- **Misskey アカウントのアクセストークン** (下記スコープが必要)
  - `write:drive` — 画像をドライブにアップロード (`drive/files/create`)
  - `write:admin:emoji` — 絵文字を登録 (`admin/emoji/add`)
  - `read:admin:emoji` — 既存カテゴリを取得 (`admin/emoji/list`、autocomplete 用)
  - アカウントには **`canManageCustomEmojis` 権限のあるロール**を付与しておく (スコープに加えて role 権限も必須)
  - 発行場所: 設定 → API → アクセストークン発行
- **Discord サーバー側で承認ロール**を 1 つ以上用意 (承認者にだけ付与)

## Cloudflare Workers セットアップ

> **`wrangler.jsonc` の KV ID について**: コミット済みの設定は `REPLACE_WITH_KV_NAMESPACE_ID` というプレースホルダです。clone 後にステップ 3 で出力された **あなたのアカウント固有の ID** に必ず差し替えてください (差し替えずに deploy するとエラーになります)。

```bash
# 1. 依存をインストール
npm install

# 2. Cloudflare にログイン
npx wrangler login

# 3. KV namespace を作成
npx wrangler kv namespace create STATE
# → 出力された id を wrangler.jsonc の "REPLACE_WITH_KV_NAMESPACE_ID" に貼り付け

# 4. シークレットを登録 (Workers Secrets に保存)
#    .secrets.json を作って bulk 登録すると楽:
#    {"DISCORD_TOKEN": "...", "DISCORD_PUBLIC_KEY": "...", ...}
npx wrangler secret bulk .secrets.json
#    あるいは個別に:
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put MISSKEY_URL
npx wrangler secret put MISSKEY_TOKEN
npx wrangler secret put APPROVER_ROLE_IDS
# 任意:
npx wrangler secret put DISCORD_APPROVAL_CHANNEL_ID
npx wrangler secret put DEFAULT_CATEGORY
npx wrangler secret put DEFAULT_LICENSE

# 5. スラッシュコマンドを Discord に登録
#    .env に DISCORD_TOKEN, DISCORD_CLIENT_ID, (任意) DISCORD_GUILD_ID を記載
npm run register

# 6. デプロイ
npm run worker:deploy
# → デプロイ URL が表示される。例: https://misskey-emoji-bot.<account>.workers.dev

# 7. Discord Developer Portal で Interactions Endpoint URL を設定
#    https://discord.com/developers/applications/<app-id>/information
#    "Interactions Endpoint URL" にデプロイ URL を設定 → Save
#    Discord が PING + 無効署名の検証 → ✅ なら保存成功
#    (URL 末尾の /interactions は付けても付けなくても OK)
```

> `wrangler.jsonc` をローカルで編集したまま git の追跡から外したい場合は、編集後に `git update-index --skip-worktree wrangler.jsonc` を実行してください。`git pull` 時に競合しません (必要に応じて `--no-skip-worktree` で戻せます)。

### ローカル開発

```bash
# .dev.vars を作成 (wrangler dev が自動で読む。フォーマットは KEY=VALUE)
cp sample.env .dev.vars
# .dev.vars に各値を埋める

npm run worker:dev
# → http://localhost:8787 で待受

# 別ターミナルでトンネル張る (Discord から到達するため)
npx untun@latest tunnel http://localhost:8787
# → https://xxxx-yyyy.trycloudflare.com 系の URL が出るので
#   Discord Developer Portal の Interactions Endpoint URL に貼って Save
```

`.dev.vars` は `.gitignore` 済みです。

### ログ確認

```bash
npm run worker:tail
```

## Gateway モードのセットアップ (代替)

サーバーレスでなく自前ホスト (VPS / Docker / ローカル) で常時起動したい場合。

```bash
# 1. 依存インストール
npm install

# 2. .env を作成
cp sample.env .env
# .env を埋める。Gateway モードでは DISCORD_PUBLIC_KEY と DISCORD_APPLICATION_ID は不要、
# 他 (DISCORD_TOKEN, MISSKEY_URL, MISSKEY_TOKEN, APPROVER_ROLE_IDS) は必須。

# 3. スラッシュコマンドを登録
npm run register

# 4. 起動
npm start
# 開発時 (ファイル変更で再起動):
npm run dev
```

Gateway モードでは Discord Developer Portal の **Interactions Endpoint URL は未設定にしてください** (設定すると HTTP モードが優先され、Gateway 側に interaction が届きません)。

state は **インメモリ** なので、再起動すると保留中のリクエストは失われます。永続化が必要なら Workers モードを推奨。

## 環境変数 / シークレット

| 変数名 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | ◯ | Discord Bot のトークン |
| `DISCORD_PUBLIC_KEY` | ◯ | Discord Application の Public Key (Ed25519 署名検証) |
| `DISCORD_APPLICATION_ID` | ◯ | Discord Application (Client) ID |
| `DISCORD_CLIENT_ID` | ◯ (register 時) | Discord Application (Client) ID — `npm run register` 用に `.env` に書く |
| `DISCORD_GUILD_ID` | △ | register 時、指定するとそのサーバーにだけコマンドを登録 (即時反映) |
| `MISSKEY_URL` | ◯ | Misskey のベース URL (末尾 `/` なし) |
| `MISSKEY_TOKEN` | ◯ | `write:drive` + `write:admin:emoji` + `read:admin:emoji` スコープのトークン |
| `APPROVER_ROLE_IDS` | ◯ | 承認可能ロールの ID をカンマ区切りで列挙 |
| `DISCORD_APPROVAL_CHANNEL_ID` | × | 承認ボタンを投稿する専用チャンネル ID。未指定なら申請が行われた同じチャンネルに投稿 |
| `DEFAULT_CATEGORY` | × | カテゴリ未指定時のデフォルト (現状の `/emoji add` ではカテゴリ必須なので影響なし) |
| `DEFAULT_LICENSE` | × | ライセンス未指定時のデフォルト |

> ロール ID は Discord の開発者モードを ON にした状態で、サーバー設定 → ロールから右クリック → 「ID をコピー」で取得できます。

## 使い方

### 申請

```
/emoji add image:<画像> category:<タイプして検索 or 新規> [name:<絵文字名>] [tags:<カンマ区切り>] [license:<ライセンス>] [sensitive:<bool>] [localonly:<bool>]
```

- `image` (必須) — PNG / GIF / WEBP / APNG / JPEG
- `category` (必須) — autocomplete で既存カテゴリから選択、あるいは「✨ 新規: <typed>」で新規作成
- `name` (任意) — 省略時は画像ファイル名からサニタイズして自動生成
- `tags` / `license` (任意)
- `sensitive` / `localonly` (任意、デフォルト false)

→ 承認チャンネル (or 同チャンネル) に Embed + 承認/却下/編集ボタン付きで投稿される。
申請者には **ephemeral で受付メッセージ + 自分の申請内容の Embed (画像プレビュー付き) + ✏️ 編集ボタン** が表示される (本人のみ可視)。

### 承認 / 却下 (承認者のみ)

承認メッセージのボタンをクリック:
- ✅ **承認** — Misskey に登録し、申請チャンネルに結果を通知
- ❌ **却下** — Embed を「却下」状態に更新し、申請チャンネルに通知

### 編集 (申請者 or 承認者)

2 通り:

#### A. ✏️ ボタン (ワンクリック)
1. 承認メッセージの ✏️ をクリック
2. モーダルが開く (名前 / タグ / ライセンス、現在値プリフィル)
3. Submit すると ephemeral にカテゴリ select (現在カテゴリも表示)
4. 既存選択 → 確定 / 「✨ 新規」→ 新規モーダル → 確定
5. 承認メッセージが PATCH される

#### B. `/emoji edit` (コマンド)
```
/emoji edit request_id:<タイプで絞り込み> [name] [category:<autocomplete>] [tags] [license] [sensitive] [localonly]
```
変えたい項目だけ指定。`request_id` は autocomplete で `name (category) — id` 形式の候補から選べる。

### 権限

| 役割 | ✏️ 編集 | ✅/❌ 承認/却下 |
| --- | --- | --- |
| 申請者本人 | ✅ | ❌ |
| 承認者ロール持ち | ✅ | ✅ |
| それ以外 | ❌ | ❌ |

権限がない人がボタンを押すと、その人だけに見える ephemeral でエラーが返ります。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run register` | スラッシュコマンドを Discord に登録 (`/emoji add`, `/emoji edit`) |
| `npm start` | Gateway モードで起動 |
| `npm run dev` | Gateway モードで起動 (`--watch` で自動再起動) |
| `npm run worker:dev` | ローカルで Workers を起動 (`.dev.vars` から secrets 読み込み) |
| `npm run worker:deploy` | Cloudflare に Workers をデプロイ |
| `npm run worker:tail` | デプロイ済み Workers のログをライブ表示 |
| `node scripts/list-commands.js` | 登録済みのスラッシュコマンドを表示 |
| `node src/sanitize.test.js` | sanitize 関数のテスト |

## ディレクトリ構成

```
src/
├── sanitize.js        # 絵文字名サニタイズ (両モード共通)
├── sanitize.test.js   # サニタイズ関数のテスト
├── misskey.js         # Misskey API ラッパ (drive/files/create, admin/emoji/{add,list})
├── register.js        # Misskey 登録ロジック + エラー翻訳 (両モード共通)
├── commands/
│   └── emoji.js       # /emoji {add,edit} の SlashCommandBuilder 定義 (両モード共通)
├── index.js           # Gateway モードのエントリ + 全 interaction handler
├── state.js           # Gateway: TTL 付きインメモリストア
└── worker/            # Cloudflare Workers モード
    ├── index.js       # fetch エントリポイント、interaction type 別ルーティング
    ├── verify.js      # Ed25519 署名検証 (WebCrypto)
    ├── handlers.js    # 全 interaction ハンドラ (slash, button, modal, autocomplete, select)
    ├── discord.js     # Discord API helper + Embed/Button/Modal/Select の JSON ビルダ
    └── state.js       # Workers KV ベースの state ストア

scripts/
├── register-commands.js  # スラッシュコマンド登録 (両モード共通)
└── list-commands.js      # 登録済みコマンド確認

wrangler.jsonc             # Workers の設定 (KV namespace ID は手動で埋める)
.dev.vars                  # ローカル secrets (gitignore 済み)
.env                       # register-commands.js / Gateway モードが読む (gitignore 済み)
```

## 内部の特徴

- **state は Workers KV** にキー単位で保存。`expirationTtl: 7 日` で自動 GC
- 承認の重い処理 (Misskey API 呼び出し) は `ctx.waitUntil` で deferred response (type 6) の後にバックグラウンド実行 → Discord の 3 秒制限を確実に回避
- 署名検証は **WebCrypto の Ed25519** で実装 ([src/worker/verify.js](src/worker/verify.js))、追加依存ゼロ
- `discord.js` npm パッケージは Workers モードでは **不使用** (Node.js 専用 API に依存するため)。Embed / Button / Modal / Select は生 JSON で構築 ([src/worker/discord.js](src/worker/discord.js))
- カテゴリは Misskey から `admin/emoji/list` で取得して **KV キャッシュ 1h**。autocomplete 応答が速い

## 注意

- `.env` / `.dev.vars` には機密情報 (Discord / Misskey のトークン) が含まれます。**絶対にコミットしないでください** (`.gitignore` 設定済み)
- Misskey 側に同名の絵文字が既にあると `DUPLICATE_NAME` で失敗します。名前を変えて再申請してください
- Workers KV の autocomplete (`request_id` の絞り込み) は全 key スキャンするので、**保留中の申請が数百件規模になると遅くなる可能性**あり。通常運用では問題なし
- `MISSKEY_URL` を `http://localhost:3000` のようなローカル URL にすると **デプロイ後の Workers から到達できません**。本番では public な URL を `wrangler secret put MISSKEY_URL` で上書きしてください

## ライセンス

[MIT License](./LICENSE)

Misskey 本体 (AGPL-3.0) とは独立した HTTP API クライアントであり、Misskey のコード自体は含みません。
