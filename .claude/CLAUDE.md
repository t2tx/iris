# Iris 開発ガイド

## プロジェクト概要

Iris は **Slack と Claude Code をつなぐ最小構成のブリッジ**です。Slack のスレッドから、ローカルで動く Claude Code CLI を操作できます。

- ギリシャ神話の虹の女神 **Iris**（神々と人間をつなぐ伝令）に由来。
- [cc-connect](https://github.com/chenhg5/cc-connect)（14 エージェント × 13 プラットフォーム対応の汎用ブリッジ）の設計思想だけを参考に、**Slack + Claude Code の 1 組み合わせに絞って自作**したもの。汎用化のための抽象（プラグインレジストリ・40 以上のオプショナルインターフェース・provider 切替・cron・relay 等）は意図的に持たない。
- 規模はソース約 700 行。cc-connect の約 1/100。

## 設計の背骨

> **1 Slack スレッド = 1 Claude セッション = 1 常駐プロセス**

これが全アーキテクチャの中心。スレッドごとに Claude Code プロセスを 1 本立て、`thread_ts` で対応づける。

```
 Slack (Socket Mode / WebSocket)
        │  app_mention / message.channels / block_actions
        ▼
   index.ts (Bolt app)  ──── Slack イベント受信・送信
        │                         ▲
   session.ts                permission.ts
   thread_ts ⇄ ClaudeProcess  権限要求 ⇄ Block Kit ボタン
        │
   claude.ts ── Claude Code 子プロセス (stream-json)
        │
   protocol.ts ── stdout の 1 行を純粋関数でパース
        │
   format.ts ── Claude 出力 → Slack mrkdwn / NO_REPLY
```

## モジュール責務

| ファイル | 責務 |
|---|---|
| `src/index.ts` | Bolt アプリ（Socket Mode）の起動。設定をロードし、プロジェクトごとに `SessionManager` を生成。Slack イベント（`app_mention` / スレッド返信 / DM / ボタン）を受け、ルーティングしてセッションへ橋渡し。Claude の出力を Slack へ送信 |
| `src/config.ts` | 設定ロード（TOML + 環境変数）。`[[projects]]` 配列で work_dir・許可リスト・権限モードを使い分け。`routeChannel` / `routeUser` で受信メッセージを最初にマッチするプロジェクトへルーティング。`[[projects]]` 無し時は env から単一プロジェクトを合成（後方互換） |
| `src/claude.ts` | Claude Code を子プロセスとして spawn。stdin に user メッセージ / 権限応答を書き、stdout を `protocol.ts` でパースしてイベントを emit（`EventEmitter`） |
| `src/protocol.ts` | **純粋関数** `parseLine()`。stream-json の 1 行を正規化イベント配列に変換。IO を持たないので単体テスト容易 |
| `src/session.ts` | `thread_ts → ClaudeProcess` の Map。新規スレッドは新規 spawn、プロセス死亡後は保持した `session_id` で `--resume` |
| `src/permission.ts` | Claude の権限要求（`control_request`）を Block Kit の Allow/Deny ボタンに変換。`request_id` で逆引きするレジストリ |
| `src/format.ts` | Claude の Markdown → Slack mrkdwn 変換、`NO_REPLY` 沈黙マーカーの処理、ツール進捗行の整形 |

## Claude Code との通信プロトコル

Claude Code を以下で起動し、stdin/stdout で改行区切り JSON をやり取りする（仕様は cc-connect の `agent/claudecode/session.go` を逐語確認済み）。

```
claude --output-format stream-json --input-format stream-json \
       --permission-prompt-tool stdio --replay-user-messages --verbose \
       [--resume <session_id>] [--append-system-prompt <text>] [--model <model>]
```

### stdin へ書く（Iris → Claude）

- ユーザーメッセージ: `{"type":"user","message":{"role":"user","content":"..."}}`
- 権限応答: `{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow","updatedInput":{}}}}`

### stdout を読む（Claude → Iris）— `type` で分岐

| type | Iris の扱い |
|---|---|
| `system` | `session_id` を捕捉（`--resume` 用） |
| `assistant` | `content[]` の text / thinking / tool_use を emit |
| `control_request`（`subtype: can_use_tool`） | 権限要求として emit → ボタン投稿 |
| `result` | ターン終了 |
| `user`（replay） | 無視 |

## 権限モード

設定の `permission_mode` で制御（既定 `manual`。トップレベル / 各 project で指定）。

- `manual` — 全ツールを手動承認（Slack のボタンで許可/拒否）
- `acceptEdits` — 編集系ツール（Edit/Write/NotebookEdit/MultiEdit）は自動許可、それ以外は手動
- `auto` — 全ツール自動許可（信頼できるチャンネルのみで使う）

`auto` / `acceptEdits` の自動許可は `claude.ts` 内で Slack を経由せず即応答する。

## セキュリティ方針（内製の主目的）

1. **デフォルト拒否**: `allow_channels` / `allow_users` が空なら無視する。
2. **権限の既定は手動承認**: `auto` は明示的に opt-in したときのみ。
3. **外向き機能を持たない**: cron / relay / provider 切替 / 添付送信などは未実装。攻撃面は「Slack 受信 → Claude CLI 実行」のみ。
4. **設定は TOML 一本**（`iris.config.toml` / `~/.iris-slack/config.toml`、トークン込み）。コードやリポジトリに秘密を置かない（`iris.config.toml` は gitignore、`iris.config.example.toml` はプレースホルダのみ）。`.env` は使わない。

## 開発ルール

### コードスタイル

- TypeScript / ESM（`type: module`）。Node 22（`.node-version` で 22.18.0 に固定）。
- Prettier 設定: `singleQuote` / `trailingComma: all` / `bracketSpacing: false`（mile-server-monitor と同じ流儀）。
- ESLint は flat config + `typescript-eslint` の型付きルール + `prettier`。
- パッケージマネージャは **pnpm**。

### 既知の流儀・ハマり所

- `@slack/bolt` v4 は CommonJS で named export → `import * as bolt` で取る。
- `KnownBlock` 型は `import type {types} from '@slack/bolt'` の `types.KnownBlock` から取る（`@slack/types` は推移的依存なので直接 import しない）。
- Bolt のリスナーは戻り値が `Promise<void>` 必須 → ハンドラは `async` を維持する（`require-await` は off にしてある）。
- IO を持つ層（spawn / Bolt）は単体テストしない。ロジックは `protocol.ts` のように純粋関数へ切り出してテストする。

## テスト

- **node:test + tsx**（追加依存ゼロ）。`*.test.ts` を `src/` に配置。
- 純粋ロジック（protocol / format / permission）を中心にテスト。

```bash
pnpm test            # 単体テスト
pnpm test:coverage   # カバレッジ（lcov.info を出力）
```

## 品質ゲート

```bash
pnpm verify          # typecheck → lint → format:check → test（push 前にこれが全部通ること）
```

- **lefthook** の `pre-push` で `pnpm verify` が自動実行される（`pnpm install` 時に `prepare` が `lefthook install` する）。
- **GitHub Actions**（`.github/workflows/ci.yml`）でも push / PR 時に verify + coverage を実行。

### コミット前チェックリスト

1. `pnpm verify` が通る
2. 新しいユーザー向け文字列・挙動にはテストを足す
3. 秘密情報（トークン・キー）がコードに入っていない
4. `core` 思想（Slack/Claude のロジックを分離、純粋関数はテスト可能に）を崩していない

## 関連ドキュメント

- [README.md](../README.md) — 概要・セットアップ
- [docs/slack-setup.md](../docs/slack-setup.md) — Slack App 作成手順（日本語）
- 設計メモ（リポジトリ外）: `react-lab-mono/.claude/out/iris-design.md`
