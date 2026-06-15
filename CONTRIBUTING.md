# Iris 開発ガイド（コントリビューター向け）

このドキュメントは Iris を**開発する人**向けです。Iris を**使うだけ**なら
[README.md](./README.md) と [docs/slack-setup.md](./docs/slack-setup.md) で完結します
（Slack App は 1 つ作れば十分です）。

設計・アーキテクチャの詳細は [.claude/CLAUDE.md](./.claude/CLAUDE.md) を参照してください。

## 前提

- Node 22（`.node-version` で 22.18.0 に固定。nodenv 等で合わせる）
- pnpm

```bash
pnpm install   # 初回。prepare フックで lefthook も入る
```

## 品質ゲート

```bash
pnpm verify          # typecheck → lint → format:check → test（push 前にこれが通ること）
pnpm test            # 単体テスト（node:test）
pnpm test:coverage   # カバレッジ（lcov.info を出力）
pnpm lint            # eslint + 複雑度チェック
pnpm format          # prettier --write
```

- `pre-push` で `pnpm verify` が自動実行されます（lefthook）。
- GitHub Actions でも push / PR 時に verify + coverage を実行します。

## ブランチ運用

`feature/*`（または `refactor/*` `fix/*`）ブランチ → Pull Request → CI 確認 → マージ。
`main` への直 push はしません。

```bash
git checkout -b feature/xxx
# 変更・pnpm verify
git push -u origin feature/xxx
gh pr create --base main --fill
gh pr merge --squash --delete-branch
```

## 設定ファイル（TOML 一本）

設定はすべて 1 つの TOML ファイルです。`.env` は使いません。探索順:

| 条件 | 使うファイル |
|------|-------------|
| `IRIS_CONFIG=<path>` | その指定パス |
| （未指定） | `./iris.config.toml`（リポジトリ内 = 開発） |
| （上が無ければ） | `~/.iris-slack/config.toml`（本番 / インストール後） |

開発では **リポジトリ直下の `iris.config.toml`** を置けば自動で使われます
（テンプレート: [iris.config.example.toml](./iris.config.example.toml)。`iris.config.toml`
は gitignore 済み）。

```bash
cp iris.config.example.toml iris.config.toml   # トークン・work_dir・許可リストを記入
pnpm dev                                        # tsx watch（自動再起動）で起動
```

## 本番と開発を同時に動かす（Slack App を分ける）

1 つの Slack App は Socket Mode の接続枠を 1 つしか持ちません。本番（launchd 常駐）と
開発（ローカル `src` 起動）が**同じ App のトークンを共有すると、メッセージがどちらの
接続に届くか不定**になり混線します（実際に起きます）。

そこで **開発用の Slack App を別に作り**（本番と同じスコープ / イベント / Interactivity
設定）、その**開発用トークンを開発の `iris.config.toml` に書きます**。本番は
`~/.iris-slack/config.toml`（本番 App トークン）。設定ファイルが別なので、本番を
止めずに開発用 App でローカルの `src` を再起動し放題になります。

## 起動方法まとめ

| コマンド | 用途 | 使う設定 | コード |
|----------|------|---------|--------|
| `pnpm dev` | 開発（監視・自動再起動） | `./iris.config.toml` | `src`（tsx） |
| `pnpm start:dev` | 開発（単発） | `./iris.config.toml` | `src`（tsx） |
| `iris install` | 本番（launchd 常駐） | `~/.iris-slack/config.toml` | `dist`（npm 配布物） |

> 検証で複数プロセスを立てると混乱のもとです。`ps aux | grep -iE "iris|dist/cli"`
> で `src` 系・`dist` 系を**広く**確認し、不要なプロセスは PID 指定で停止してください
> （`pkill` で `claude` 系を巻き込むと他セッションに影響するので避ける）。

## プロジェクト構成

| ファイル | 責務 |
|------|------|
| `src/index.ts` | Bolt（Socket Mode）。設定ロード・ルーティング・Slack 送受信 |
| `src/claude.ts` | Claude Code 子プロセス + stream-json |
| `src/protocol.ts` | stream-json の純粋パーサ（テスト容易） |
| `src/session.ts` | thread_ts ⇄ プロセスの対応表、resume / clear |
| `src/permission.ts` | 権限要求 ⇄ Block Kit ボタン |
| `src/attachments.ts` | 受信ファイル（画像 base64 / ファイル保存） |
| `src/file-upload.ts` | 生成ファイルの Slack アップロード |
| `src/stream-buffer.ts` | ストリーミングの逐次更新 |
| `src/commands.ts` | スラッシュコマンド |
| `src/config.ts` | TOML + 環境変数の設定ロード |
| `src/format.ts` | mrkdwn 変換 / `NO_REPLY` / usage footer |
| `src/cli.ts` | `iris` CLI（install / uninstall / status） |

## macOS スタンドアロンバイナリ（Node 不要）

`@t2tx/iris` の npm 配布とは別に、Node ランタイムを同梱した単一実行バイナリ（Node
SEA）を作れます。利用者は Node/npm 無しでダウンロード＆実行できます。

```bash
pnpm build:sea          # ad-hoc 署名（自分の Mac 用）→ dist-sea/iris （arm64, ~108MB）
```

中身: esbuild で 1 ファイルに bundle → Node SEA でブロブを node バイナリ
（nodenv shim でなく `process.execPath` の実 Mach-O）に postject で注入 → 署名。
`cli.ts` は `node:sea` で SEA 実行を検出し、launchd plist を「バイナリ直実行」に
する（`node <script>` ではなく）。

### 他人に配る場合（Developer ID 署名 + 公証）

ad-hoc 署名だと他人の Mac で Gatekeeper に止められます。配布するには Apple
Developer の **Developer ID Application** 証明書で署名し、**notarization（公証）**
します。秘密は環境変数で渡します（スクリプトに直書きしない）。

```bash
IRIS_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" \
IRIS_NOTARY_APPLE_ID="you@example.com" \
IRIS_NOTARY_TEAM_ID="TEAMID" \
IRIS_NOTARY_PASSWORD="<app-specific-password>" \
pnpm build:sea:signed
```

- `IRIS_SIGN_IDENTITY` が未設定なら ad-hoc にフォールバック。`IRIS_NOTARY_*` が
  揃わなければ署名のみ（公証なし）。
- Hardened Runtime + `scripts/iris.entitlements.plist`（Node の JIT 用 entitlements）
  で署名 → `notarytool submit --wait` で公証。
- App 用パスワードは [account.apple.com](https://account.apple.com) →
  サインインとセキュリティ → アプリ用パスワード で発行（Apple ID 本体の PW は不可）。
- 単一バイナリは公証チケットの stapler 不可だが、公証記録は Apple サーバに残るため
  `spctl -t install` が `Notarized Developer ID` で accept する。
- **CI 自動ビルド**: GitHub Actions の macOS runner（無料）でビルド・署名・公証・
  Release 添付まで自動化している（`.github/workflows/release.yml`）。署名証明書/
  Apple 認証は GitHub Secrets で渡す（下記）。手元でビルドしたい場合のみ上記の
  `pnpm build:sea:signed` を使う。

## リリース手順

バージョンタグ（`v*.*.*`）を push すると GitHub Actions の `Release` ワークフローが
自動で **public npm publish** と **GitHub Release 作成 + macOS バイナリ添付** を行います。

1. `package.json` の `version` を上げる。PR → main。
2. main で**タグの version と一致する**タグを切って push:

   ```bash
   git checkout main && git pull
   git tag v0.1.1            # 必ず v<package.json の version>
   git push origin v0.1.1
   ```

3. ワークフローが走る:
   - `npm` ジョブ: タグと version の一致を検証 → `npm publish --access public`
   - `macos-binary` ジョブ（macOS runner）: SEA バイナリをビルド・署名・公証 →
     GitHub Release に `iris-macos-arm64.zip` を添付

> タグと `package.json` の version がずれると npm ジョブは失敗します（事故防止）。

### 必要な GitHub Secrets

| Secret | 用途 |
|--------|------|
| `NPM_TOKEN` | npm publish（npmjs.com の自動化トークン） |
| `MACOS_CERT_P12` | Developer ID Application 証明書（.p12 を base64 化） |
| `MACOS_CERT_PASSWORD` | 上記 .p12 のパスワード |
| `MACOS_SIGN_IDENTITY` | 例 `Developer ID Application: NAME (TEAMID)` |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_PASSWORD` | notarization 用 |

### 利用者のインストール

```bash
npm install -g @t2tx/iris      # public npm
# または Releases から macOS バイナリをダウンロード（Node 不要）
```
