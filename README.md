# misskey-emoji-bot

Discord から **Misskey カスタム絵文字** を承認制で登録できる Bot です。
`/emoji add` で画像とメタデータを送ると、承認用チャンネルにリクエストが投稿され、
承認ロールを持つメンバーが ✅ 承認 / ❌ 却下 / ✏️ 編集 のボタンで処理できます。

## 主な機能

- `/emoji add` スラッシュコマンドで画像 + 名前 / カテゴリ / タグ / ライセンスを申請
- 申請内容は **承認チャンネル** に Embed + ボタン付きで投稿
- ✅ 承認で Misskey ドライブへアップロード→ `admin/emoji/add` で登録
- ❌ 却下 / ✏️ 編集（申請者と承認者のみ可能）に対応
- 申請者には元チャンネルで承認結果を通知（メンション付き）
- Misskey 側のエラーコード（`DUPLICATE_NAME`, `INAPPROPRIATE` 等）を日本語に翻訳して表示
- 絵文字名のサニタイズ（`a-z 0-9 _` 以外を `_` に置換）
- 申請の有効期限: 7 日（メモリ上の TTL ストア）

## 必要なもの

- Node.js **v24 以上**
- Discord Bot（[Discord Developer Portal](https://discord.com/developers/applications) で作成）
  - Bot Token
  - Application (Client) ID
  - サーバーに招待するときに `applications.commands` スコープを付与
- Misskey アカウントの **アクセストークン**
  - `write:admin:emoji` スコープが必要
  - アカウントには `canManageCustomEmojis` 権限のあるロールを付与しておく
  - 発行場所: 設定 → API → アクセストークン発行
- Discord サーバー側で**承認ロール**を 1 つ以上用意

## セットアップ

```bash
# 1. 依存をインストール
npm install

# 2. .env を作成
cp sample.env .env
# .env を編集して以下を埋める:
#   DISCORD_TOKEN, DISCORD_CLIENT_ID,
#   MISSKEY_URL, MISSKEY_TOKEN,
#   APPROVER_ROLE_IDS,
#   (任意) DISCORD_APPROVAL_CHANNEL_ID,
#          DEFAULT_CATEGORY, DEFAULT_LICENSE

# 3. スラッシュコマンドを登録
#    .env に DISCORD_GUILD_ID を設定するとそのサーバーだけに即時反映、
#    未設定だとグローバル登録（反映に最大 1 時間）
npm run register

# 4. Bot を起動
npm start
# 開発時 (ファイル変更で再起動):
npm run dev
```

## 環境変数

| 変数名 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | ◯ | Discord Bot のトークン |
| `DISCORD_CLIENT_ID` | ◯ (register 時) | Discord Application (Client) ID |
| `DISCORD_GUILD_ID` | △ | 指定するとそのサーバーにだけコマンドを登録（即時反映） |
| `MISSKEY_URL` | ◯ | Misskey のベース URL（末尾 `/` なし） |
| `MISSKEY_TOKEN` | ◯ | `write:admin:emoji` スコープのトークン |
| `APPROVER_ROLE_IDS` | ◯ | 承認可能ロールの ID をカンマ区切りで列挙 |
| `DISCORD_APPROVAL_CHANNEL_ID` | × | 承認ボタンを投稿する専用チャンネル ID。未指定なら申請が行われた同じチャンネルに投稿 |
| `DEFAULT_CATEGORY` | × | カテゴリ未指定時のデフォルト |
| `DEFAULT_LICENSE` | × | ライセンス未指定時のデフォルト |

> ロール ID は Discord の開発者モードを ON にした状態で、サーバー設定 → ロールから右クリック →「ID をコピー」で取得できます。

## 使い方

1. Discord で `/emoji add` を入力し、絵文字にする画像を添付（PNG / GIF / WEBP / APNG / JPEG）
2. 出てきたモーダルで以下を入力
   - **絵文字名**（必須、`a-z 0-9 _`）
   - カテゴリ / タグ（カンマ区切り）/ ライセンス（任意）
3. 承認チャンネルにリクエストが投稿される
4. 承認ロールを持つメンバーが
   - ✅ 承認 → Misskey に登録
   - ❌ 却下
   - ✏️ 編集（申請者本人も可能）
5. 申請者の元チャンネルに承認結果が通知される

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm start` | Bot を起動 |
| `npm run dev` | `--watch` 付きで起動（ファイル変更で再起動） |
| `npm run register` | スラッシュコマンドを Discord に登録 |
| `node scripts/list-commands.js` | 登録済みのスラッシュコマンドを表示 |

## ディレクトリ構成

```
src/
├── index.js          # エントリポイント / Discord クライアント
├── commands/
│   └── emoji.js      # /emoji add コマンドと申請モーダル
├── approvals.js      # 承認ボタン / 編集モーダルのハンドラ
├── register.js       # Misskey への登録ロジック + エラー翻訳
├── misskey.js        # Misskey API ラッパ (drive/files/create, admin/emoji/add)
├── sanitize.js       # 絵文字名サニタイズ
├── state.js          # TTL 付きインメモリストア
└── sanitize.test.js  # サニタイズ関数のテスト
scripts/
├── register-commands.js  # スラッシュコマンド登録
└── list-commands.js      # 登録済みコマンド確認
```

## 注意

- 申請は **インメモリ** で管理しています。Bot を再起動すると保留中のリクエストは失われます。
- `.env` には機密情報（Discord / Misskey のトークン）が含まれます。**絶対にコミットしないでください**（`.gitignore` 設定済み）。
- Misskey 側に同名の絵文字が既にあると `DUPLICATE_NAME` で失敗します。名前を変えて再申請してください。

## ライセンス

[MIT License](./LICENSE)
