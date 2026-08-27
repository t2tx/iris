# AGENTS.md

Iris プロジェクトに参画するエージェント（Claude Code、Pi、ローカル LLM 等）向けの
ナビゲーションドキュメント。

## プロジェクト概要

**Iris** は **Slack と AI agent CLI をつなぐ最小構成のブリッジ**です。
Slack のスレッドから、ローカルで動く agent プロセスを操作できます。

- ギリシャ神話の虹の女神 **Iris**（神々と人間をつなぐ伝令）に由来。
- [cc-connect](https://github.com/chenhg5/cc-connect)（14 エージェント × 13 プラットフォーム対応の汎用ブリッジ）の設計思想だけを参考に、**Slack + agent CLI の 1 組み合わせに絞って自作**したもの。汎用化のための抽象（プラグインレジストリ・40 以上のオプショナルインターフェース・provider 切替・cron・relay 等）は意図的に持たない。
- 規模はソース約 700 行。cc-connect の約 1/100。

現時点でサポートする agent CLI: **Claude Code**（`claude` コマンド）。
将来的に Pi 等が追加された際は、`src/backends/` に新しい backend を追加すればよい。

## 設計の背骨

> **1 Slack スレッド = 1 セッション = 1 常駐プロセス**

これが全アーキテクチャの中心。スレッドごとに agent プロセスを 1 本立て、`thread_ts` で対応づける。

```
 Slack (Socket Mode / WebSocket)
         │  app_mention / message.channels / block_actions
         ▼
   index.ts (Bolt app)  ──── Slack イベント受信・送信
         │                          ▲
   session.ts                permission.ts
   thread_ts ⇄ AgentProcess  権限要求 ⇄ Block Kit ボタン
         │
   backends/claude.ts ── agent 子プロセス (stream-json)
         │
   protocol.ts ── stdout の 1 行を純粋関数でパース
         │
   format.ts ── agent 出力 → Slack mrkdwn / NO_REPLY
```

## モジュール責務

| ファイル | 責務 |
|---|---|
| `src/index.ts` | Bolt アプリ（Socket Mode）の起動。設定をロードし、プロジェクトごとに `SessionManager` を生成。Slack イベント（`app_mention` / スレッド返信 / DM / ボタン）を受け、ルーティングしてセッションへ橋渡し。agent の出力を Slack へ送信 |
| `src/config.ts` | 設定ロード（TOML + 環境変数）。`[[projects]]` 配列で work_dir・許可リスト・権限モードを使い分け。`routeChannel` / `routeUser` で受信メッセージを最初にマッチするプロジェクトへルーティング。`[[projects]]` 無し時は env から単一プロジェクトを合成（後方互換） |
| `src/agent.ts` | agent プロセスの抽象インターフェース。`spawn` / `write` / `on(event)` / `close()`。backend 切替の拡張ポイント |
| `src/backends/claude.ts` | Claude Code CLI を子プロセスとして spawn。stdin に user メッセージ / 権限応答を書き、stdout を `protocol.ts` でパースしてイベントを emit（`EventEmitter`） |
| `src/protocol.ts` | **純粋関数** `parseLine()`。stream-json の 1 行を正規化イベント配列に変換。IO を持たないので単体テスト容易 |
| `src/session.ts` | `thread_ts → AgentProcess` の Map。新規スレッドは新規 spawn、プロセス死亡後は保持した `session_id` で `--resume` |
| `src/permission.ts` | agent の権限要求（`control_request`）を Block Kit の Allow/Deny ボタンに変換。`request_id` で逆引きするレジストリ |
| `src/format.ts` | agent の Markdown → Slack mrkdwn 変換、`NO_REPLY` 沈黙マーカーの処理、ツール進捗行の整形 |
| `src/cli.ts` | CLI エントリポイント（`iris` / `iris install` / `iris status` / `iris config`） |
| `src/commands.ts` | Slack スラッシュコマンド処理（`/help` / `/sessions` / `/clear` 等） |
| `src/claude-sessions.ts` | Claude の `~/.claude/` セッションスキャン・一覧 |
| `src/attachments.ts` | 添付ファイル処理（画像・ファイル） |
| `src/file-upload.ts` | 生成ファイルを Slack へアップロード |
| `src/stream-buffer.ts` | ストリーム出力のバッファリング・分割 |
| `src/dedup.ts` | 重複検出（同一メッセージの再処理防止） |
| `src/log.ts` | レベル付きロガー |
| `src/slack/messages.ts` | Slack メッセージ投稿ユーティリティ |

## ディレクトリ構成

```
iris/
├── AGENTS.md                 # ← you are here (共通ナビゲーション)
├── .claude/
│   └── CLAUDE.md             # Claude Code 専用設定 + 本ファイル参照
├── package.json              # パッケージ定義・スクリプト
├── tsconfig.json             # TypeScript 設定
├── tsconfig.build.json       # ビルド用 TS 設定
├── biome.json                # Biome lint + format 設定
├── lefthook.yml              # git hooks (pre-commit / pre-push)
├── iris.config.example.toml  # 設定テンプレート（プレースホルダ）
├── src/
│   ├── index.ts              # 入口 (Bolt app)
│   ├── cli.ts                # CLI コマンド
│   ├── config.ts             # 設定ロード
│   ├── agent.ts              # agent プロセス抽象
│   ├── protocol.ts           # stream-json パーサ（純粋関数）
│   ├── session.ts            # セッション管理
│   ├── permission.ts         # 権限要求 ↔ ボタン
│   ├── format.ts             # 出力整形
│   ├── commands.ts           # スラッシュコマンド
│   ├── claude-sessions.ts    # Claude セッション一覧
│   ├── attachments.ts        # 添付ファイル
│   ├── file-upload.ts        # ファイルアップロード
│   ├── stream-buffer.ts      # ストリームバッファ
│   ├── dedup.ts              # 重複検出
│   ├── log.ts                # ロガー
│   ├── backends/
│   │   └── claude.ts         # Claude Code CLI backend
│   └── slack/
│       └── messages.ts       # Slack 投稿ユーティリティ
├── docs/
│   └── slack-setup.md        # Slack App 作成手順（日本語）
├── scripts/
│   ├── build-sea.sh          # SEA ビルド
│   ├── build-sea-signed.sh   # 署名付き SEA ビルド (macOS)
│   ├── check-complexity.sh   # 複雑度チェック
│   └── iris.entitlements.plist  # macOS 署名 entitlements
└── .github/workflows/
    ├── ci.yml                # CI (verify + coverage)
    ├── codeql.yml            # SAST
    └── release.yml           # Release 自動化
```

## Agent との通信プロトコル

Iris は agent プロセスと stdin/stdout で改行区切り JSON をやり取りする。
現在の唯一の agent として **Claude Code CLI** を用いる（仕様は cc-connect の `agent/claudecode/session.go` を逐語確認済み）。

### 起動コマンド（Claude Code）

```
claude --output-format stream-json --input-format stream-json \
       --permission-prompt-tool stdio --replay-user-messages --verbose \
       [--resume <session_id>] [--append-system-prompt <text>] [--model <model>]
```

### stdin へ書く（Iris → agent）

- ユーザーメッセージ: `{"type":"user","message":{"role":"user","content":"..."}}`
- 権限応答: `{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow","updatedInput":{}}}}`

### stdout を読む（agent → Iris）— `type` で分岐

| type | Iris の扱い |
|---|---|
| `system` | `session_id` を捕捉（`--resume` 用） |
| `assistant` | `content[]` の text / thinking / tool_use を emit |
| `control_request`（`subtype: can_use_tool`） | 権限要求として emit → ボタン投稿 |
| `result` | ターン終了 |
| `user`（replay） | 無視 |

> Pi 等の新 backend が追加された場合は `src/backends/` にファイルを追加し、
> 上記プロトコル互換または `AgentProcess` インターフェースを実装する。

## 権限モード

設定の `permission_mode` で制御（既定 `manual`。トップレベル / 各 project で指定）。

- `manual` — 全ツールを手動承認（Slack のボタンで許可/拒否）
- `acceptEdits` — 編集系ツール（Edit/Write/NotebookEdit/MultiEdit）は自動許可、それ以外は手動
- `auto` — 全ツール自動許可（信頼できるチャンネルのみで使う）

`auto` / `acceptEdits` の自動許可は `backends/claude.ts` 内で Slack を経由せず即応答する。

## セキュリティ方針（内製の主目的）

1. **デフォルト拒否**: `allow_channels` / `allow_users` が空なら無視する。
2. **権限の既定は手動承認**: `auto` は明示的に opt-in したときのみ。
3. **外向き機能を持たない**: cron / relay / provider 切替 / 添付送信などは未実装。攻撃面は「Slack 受信 → agent CLI 実行」のみ。
4. **設定は TOML 一本**（`iris.config.toml` / `~/.iris-slack/config.toml`、トークン込み）。コードやリポジトリに秘密を置かない（`iris.config.toml` は gitignore、`iris.config.example.toml` はプレースホルダのみ）。`.env` は使わない。

## ビルド・テスト・lint

| コマンド | 用途 |
|---|---|
| `pnpm dev` | tsx watch で開発実行 |
| `pnpm build` | TypeScript コンパイル (`tsc -p tsconfig.build.json`) |
| `pnpm typecheck` | 型チェック (`tsc --noEmit`, `noUncheckedIndexedAccess`) |
| `pnpm check` | Biome lint + format チェック |
| `pnpm check:fix` | Biome 自動修正 |
| `pnpm lint:complexity` | 複雑度チェック (`scripts/check-complexity.sh`) |
| `pnpm test` | 単体テスト (Vitest) |
| `pnpm test:coverage` | カバレッジ付きテスト (v8) |
| `pnpm verify` | typecheck → check → lint:complexity → test（**push 前のゲート**） |

### コードスタイル

- TypeScript / ESM（`type: module`）。Node 22（`.node-version` で 22.18.0 に固定）。
- Biome（`biome.json`）で lint + format を一元管理。`quoteStyle: single` / `trailingCommas: all` / `bracketSpacing: false`。複雑度（ディレクトリファイル数）は `scripts/check-complexity.sh` が補完。
- 型付きルール（元 `typescript-eslint` の `no-floating-promises` / `no-unsafe-argument`）は Biome が持たないため `typecheck`(`tsc --noEmit`, `noUncheckedIndexedAccess` 等) でカバー。
- パッケージマネージャは **pnpm**。

### テスト

- **vitest**。`*.test.ts` を `src/` に配置（`import {expect, test, describe, it} from 'vitest'`）。
- 純粋ロジック（protocol / format / permission）を中心にテスト。
- IO を持つ層（spawn / Bolt）は単体テストしない。ロジックは `protocol.ts` のように純粋関数へ切り出してテストする。

## 開発フロー

1. issue の詳細設計を読み込む
2. 実装ブランチを切出し、実装・テスト
3. `pnpm verify` が全て通過
4. PR を作成

### コミット前チェックリスト

1. `pnpm verify` が通る
2. 新しいユーザー向け文字列・挙動にはテストを足す
3. 秘密情報（トークン・キー）がコードに入っていない
4. `core` 思想（Slack / agent のロジックを分離、純粋関数はテスト可能に）を崩していない

### 品質ゲート

- **lefthook** の `pre-push` で `pnpm verify` が自動実行される（`pnpm install` 時に `prepare` が `lefthook install` する）。
- **GitHub Actions**（`.github/workflows/ci.yml`）でも push / PR 時に verify + coverage を実行。

## 注意事項

- **commit / push はしない**: orchestrator が担当
- **config ファイルの無断変更は禁物**: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts` は issue で明示的に要求されない限り変更しない
- **パッケージマネージャ**: `pnpm` を使う（npm / yarn 禁止）

## 関連ドキュメント

- [README.md](README.md) — 概要・セットアップ（英語）
- [README.ja.md](README.ja.md) — 概要・セットアップ（日本語）
- [docs/slack-setup.md](docs/slack-setup.md) — Slack App 作成手順（日本語）
- 設計メモ（リポジトリ外）: `react-lab-mono/.claude/out/iris-design.md`
