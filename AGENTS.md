# AGENTS.md

Iris プロジェクトに参画するエージェント（Claude Code、Pi、ローカル LLM 等）向けの
ナビゲーションドキュメント。

## プロジェクト概要

**Iris** は **Slack と agent CLI をつなぐ最小構成のブリッジ**です。
Slack のスレッドから、ローカルで動く agent プロセスを操作できます。

- ギリシャ神話の虹の女神 **Iris**（神々と人間をつなぐ伝令）に由来。
- [cc-connect](https://github.com/chenhg5/cc-connect)（14 エージェント × 13 プラットフォーム対応の汎用ブリッジ）の設計思想だけを参考に、**Slack + agent CLI の組み合わせに絞って自作**した。汎用化のための抽象（プラグインレジストリ・40 以上のオプショナルインターフェース・provider 切替・cron・relay 等）は意図的に持たない。
- 規模はソース約 7,000 行（テスト除く実測）、cc-connect の約 1/10。

### サポートする agent CLI（4 backend）

TOML の `agent` キーでプロジェクトごとに選択する（既定 `claude`）。

| `agent` | backend ファイル | 既定バイナリ（`*_bin` で変更可） | プロトコル |
|---|---|---|---|
| `claude`（既定） | `src/backends/claude.ts` | `claude`（`claude_bin`） | stream-json（stdin/stdout） |
| `pi` | `src/backends/pi.ts` | `pi`（`pi_bin`） | JSONL over stdio（RPC） |
| `hermes` | `src/backends/hermes.ts` | `hermes`（`hermes_bin`） | ACP over stdio |
| `copilot` | `src/backends/copilot.ts` | `copilot`（`copilot_bin`） | ACP over stdio |

backend 選択は `src/index.ts`（`p.agent` の分岐）→ 各 backend は `src/agent.ts` の
`AgentProcess` インターフェースを実装する。新 backend の拡張点は `src/backends/`。

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
   backends/<agent>.ts ── agent 子プロセス
         │                    （claude: stream-json / pi: RPC JSONL /
         │                      copilot・hermes: ACP）
   backends/<agent>-protocol.ts ── stdout 1 行を純粋関数で正規化イベントへ
         │
   format.ts ── agent 出力 → Slack mrkdwn / NO_REPLY
```

## モジュール責務

### コア（backend 非依存）

| ファイル | 責務 |
|---|---|
| `src/index.ts` | Bolt アプリ（Socket Mode）の起動。設定ロード、プロジェクトごとの `SessionManager` 生成、Slack イベントのルーティング、outbox 契約テキスト（`buildSystemPrompt`）生成、agent 出力の Slack 送信 |
| `src/cli.ts` | CLI エントリポイント（`iris` の既定は start。subcommand: `init` / `config` / `install` / `uninstall` / `status` / `start` / `--help` / `--version`） |
| `src/config.ts` | 設定ロード（TOML 一本 + 環境変数によるトークン上書き）。`[[projects]]` で work_dir・許可リスト・権限モード・`agent`・model を使い分け。`routeChannel` / `routeUser` で受信メッセージを最初にマッチするプロジェクトへルーティング。`[[projects]]` 無し時は env から単一プロジェクトを合成（後方互換） |
| `src/agent.ts` | agent プロセスの抽象インターフェース（`AgentProcess`）。`send` / `respondPermission` / `close` / `isAlive` / `getSessionId` / `getPid` + `on(event)`。backend 切替の拡張点 |
| `src/session.ts` | `thread_ts → AgentProcess` の Map。新規スレッドは新規 spawn、プロセス死亡後は保持したセッション ID で resume。`/switch` の carryOver と `appendSystemPrompt` のマージもここ |
| `src/permission.ts` | agent の権限要求を Block Kit の Allow/Deny ボタンに変換。`request_id` で逆引きするレジストリ |
| `src/format.ts` | agent の Markdown → Slack mrkdwn 変換、`NO_REPLY` 沈黙マーカー処理、ツール進捗行の整形 |
| `src/commands.ts` | Slack スラッシュコマンド処理（`/help` / `/sessions` / `/clear` 等） |
| `src/attachments.ts` | 添付ファイル処理（入向: 画像・ファイルの保存／出向: `outboxDir(workDir, sessionKey)` の規約） |
| `src/file-upload.ts` | outbox のファイルを Slack へアップロード（転送後削除） |
| `src/stream-buffer.ts` | ストリーム出力のバッファリング・分割 |
| `src/dedup.ts` | 重複検出（同一メッセージの再処理防止） |
| `src/log.ts` | レベル付きロガー |
| `src/slack/messages.ts` | Slack メッセージ投稿ユーティリティ |
| `src/slack/thread-history.ts` | `/switch` 用にスレッドのユーザー発言を読み出す（backend は cwd をまたいで resume できないため、切替時は respawn し文脈を Slack から再注入する） |
| `src/slack/throttle.ts` | Slack 送信のレート制御 |

### backend 別

| ファイル | 責務 |
|---|---|
| `src/backends/claude.ts` | Claude Code CLI を spawn。stdin に user メッセージ / 権限応答を書き、stdout を `protocol.ts` でパースしてイベント emit |
| `src/protocol.ts` | **純粋関数** `parseLine()`。Claude stream-json の 1 行を正規化イベント配列に変換。IO を持たないので単体テスト容易 |
| `src/claude-sessions.ts` | Claude の `~/.claude/` セッションスキャン・一覧 |
| `src/backends/pi.ts` | Pi CLI を `--mode rpc` で spawn。RPC（`get_state` / `set_model` 等）と JSONL 読取。`--session-dir` でプロジェクト別セッション分離 |
| `src/backends/pi-protocol.ts` | Pi の stdout 行 → 正規化イベント（純粋関数） |
| `src/backends/copilot.ts` | Copilot CLI を `--acp --stdio` で spawn。**ACP 完了時にのみターン確定**（streaming delta で確定しない）。権限ゲートは起動時 `--allow-*` フラグ固定（#99/R2、後述） |
| `src/backends/copilot-protocol.ts` | Copilot ACP イベント → 正規化イベント（純粋関数） |
| `src/backends/copilot-sessions.ts` | Copilot セッション一覧（`--resume` 用の session ID 抽出） |
| `src/backends/hermes.ts` | Hermes を `acp` サブコマンドで spawn。セッション home を `HERMES_HOME` で分離（既定 `~/.iris-slack/hermes-home/<sessionKey>`）し sessions/state/memories の漏れを防止 |
| `src/backends/hermes-protocol.ts` / `hermes-permission.ts` / `hermes-health.ts` | Hermes の ACP パース / 権限要求マッピング / 起動時 health gate（純粋関数中心） |

## ディレクトリ構成

```
iris/
├── AGENTS.md                 # ← you are here (共通ナビゲーション)
├── .claude/CLAUDE.md         # Claude Code 専用設定 + 本ファイル参照
├── CONTRIBUTING.md           # 開発者向け手順（secrets・リリース含む）
├── package.json              # パッケージ定義・スクリプト
├── tsconfig.json / tsconfig.build.json
├── biome.json                # Biome 2.5.10 設定（実効値のピン留め・strict JSON）
├── lefthook.yml              # git hooks (pre-commit / pre-push)
├── iris.config.example.toml  # 設定テンプレート（プレースホルダ）
├── src/
│   ├── index.ts              # 入口 (Bolt app)
│   ├── cli.ts / config.ts / agent.ts / session.ts / permission.ts
│   ├── format.ts / commands.ts / protocol.ts / log.ts
│   ├── attachments.ts / file-upload.ts / stream-buffer.ts / dedup.ts
│   ├── claude-sessions.ts
│   ├── slack/{messages,thread-history,throttle}.ts
│   ├── backends/
│   │   ├── claude.ts / protocol.ts 系（claude はトップレベル）
│   │   ├── pi.ts / pi-protocol.ts
│   │   ├── copilot.ts / copilot-protocol.ts / copilot-sessions.ts
│   │   └── hermes.ts / hermes-protocol.ts / hermes-permission.ts / hermes-health.ts
│   └── *.test.ts             # vitest（27 files / 361 tests 時点）。契约テスト含む:
│                             #   lint-config.test.ts (biome.json) / release-workflow.test.ts (release.yml)
├── docs/
│   ├── slack-setup.md        # Slack App 作成手順（日本語）
│   ├── backends/             # copilot-backend.md / copilot-wbs.md（backend 設計・WBS）
│   └── specs/                # 承認待ち/承認済み SPEC（copilot-backend.md 等）
├── scripts/
│   ├── build-sea.sh / build-sea-signed.sh   # SEA ビルド（release.yml から呼ばれる）
│   ├── check-complexity.sh                  # 複雑度チェック（1 ディレクトリ 15 ファイル上限）
│   ├── iris.entitlements.plist              # macOS 署名 entitlements
│   └── smoke-{claude,pi,copilot,hermes}.ts  # 実機スモーク（pnpm smoke:<backend>）
└── .github/workflows/
    ├── ci.yml                # CI (verify + coverage)
    ├── codeql.yml            # SAST
    └── release.yml           # tag v* → npm publish (OIDC) + 4 platforms + Release
```

## backend 共通契約: outbox 出向ファイル転送

転送したいファイルは **本文へのパス記述ではなく、outbox へ置く**ことで確定転送される。
4 backend すべてで契約テキスト（`index.ts#buildSystemPrompt`）は同一。**契約を知ら
ない agent はファイルを送れない**（旧来の「本文からパスを拾う」ヒューリスティックは
#79 で廃止済み）。

- **outbox**: `<work_dir>/.iris/outbox/<thread_ts>/`（受信インボックス `attachments/` とは別）。
- 転送は **この outbox の現存ファイルだけ**を転送し、転送後に削除する（一時キュー）。
  1 ファイル失敗でも他ファイルの転送と削除は継続する。
- 返信本文に絶対パスを書いても、ファイルの中身を貼り付けても転送されない。
- agent への周知（= 契約の注入）は `appendSystemPrompt` 経由。**carrier は CLI ごとに
  異なる**（各 backend ソースで検証済み）:

| backend | carrier |
|---|---|
| claude / pi | `--append-system-prompt <契約全文>`（argv 直渡し。pi のパーサは複数行値をテキスト扱い） |
| copilot | `~/.iris-slack/copilot-instructions/<sessionKey>/iris-outbox.instructions.md`（mode 0600）を `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` で export。ACP に per-session prompt注入手段がなく、workDir 内ファイルはユーザーの repo を汚すため |
| hermes | `HERMES_HOME` 内の `SOUL.md`（Hermes が自動読込） |

## プロセス間通信（参照プロトコル: Claude stream-json）

Claude 以外の backend は各自の `-protocol.ts` に純粋関数アダプタを持つ（Pi は RPC
コマンド表を `backends/pi.ts`、copilot/hermes は ACP イベント）。新規 spawn の起動
コマンド:

| backend | 起動コマンド |
|---|---|
| claude | `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --replay-user-messages --verbose [--resume <id>] [--append-system-prompt <text>] [--model <model>]` |
| pi | `pi --mode rpc [--session <id>] [--session-dir <dir>] [--append-system-prompt <text>]` |
| copilot | `copilot --acp --stdio`（PATH に `node` 必須） |
| hermes | `hermes acp`（`HERMES_HOME` = セッション別 home） |

### Claude の stdin/stdout メッセージ（他 backend の対照として）

- ユーザーメッセージ: `{"type":"user","message":{"role":"user","content":"..."}}`
- 権限応答: `{"type":"control_response","response":{"subtype":"success","request_id":"...","response":{"behavior":"allow","updatedInput":{}}}}`
- stdout は `type` で分岐: `system`（session_id 捕捉）/ `assistant`（content[]）/ `control_request`（権限要求）/ `result`（ターン終了）/ `user`（replay、無視）

## 権限モード

設定の `permission_mode` で制御（既定 `manual`。トップレベル / 各 project で指定）。

- `manual` — 全ツールを手動承認（Slack のボタンで許可/拒否）
- `acceptEdits` — 編集系ツール（Edit/Write/NotebookEdit/MultiEdit）は自動許可、それ以外は手動
- `auto` — 全ツール自動許可（信頼できるチャンネルのみで使う）

`auto` / `acceptEdits` の自動許可は各 backend 内で Slack を経由せず即応答する。
権限要求の運搬手段は backend ごとに異なる（各 backend ソースで検証済み）:

| backend | 権限ゲート | per-call 承認（Slack ボタン） |
|---|---|---|
| claude | `--permission-prompt-tool stdio` の `control_request` | あり（`permission.ts` レジストリ） |
| pi | `extension_ui_request`（confirm）→ permission イベント | あり |
| hermes | ACP permission（`hermes-permission.ts`） | あり |
| copilot | **起動時フラグ固定**: `auto`→`--allow-all` / `acceptEdits`→`--allow-tool write` / `manual`→フラグなし | **v1 なし**（ACP が per-call の `session/request_permission` を出さない。`manual` ではツールが実行できず、**outbox 転送も不可**。実運用は `acceptEdits` / `auto`。follow-up: `session/set_mode`） |

## セキュリティ方針（内製の主目的）

1. **デフォルト拒否**: `allow_channels` / `allow_users` が空なら無視する。
2. **権限の既定は手動承認**: `auto` は明示的に opt-in したときのみ。
3. **外向き転送は outbox 限定**: cron / relay / provider 切替 / 汎用リレー等は未実装。出方向の唯一の転送は「ファイルの outbox 転送」で、本文走査ではなく `<work_dir>/.iris/outbox/<thread_ts>/` の現存ファイルを転送して削除する。攻撃面は「Slack 受信 → agent CLI 実行 → outbox 転送」のみ。
   - **outbox の脅威モデル境界（既知・受容）**: outbox は **ホストローカル・単一ユーザ前提**の転送機構。outbox 内のファイルは `0644` で書かれるため、同一ホストの**他サービス/他ユーザ**は投入・改変・削除により転送を偽装可能。複数ユーザ/非信頼サービスが同居するホストでは outbox ディレクトリを `0700` にし、他プロセスの書き込みを遮断する（運用上の推奨、コードでは未対応）。また outbox 内の **symlink は現在検査していない**（外部パスへの転向になり得る）。いずれも本ツールの脅威モデル（単一ユーザ）では実害は小さいため受け入れ、将来の強化作業（`lstat` で symlink 弾き・`realpath` 閉域チェック・ディレクトリ権限 `0700` 化）に残す。
   - **copilot 契約 carrier の保管（#110）**: copilot は `/switch` の carryOver が
     `appendSystemPrompt` に混ざるため、carrier ファイルに**会話テキストが載り得る**。
     よって workDir ではなく `~/.iris-slack/` に置き、mode 0600（親 dir も）で
     作成する。同様の理由で Hermes は `HERMES_HOME` を `~/.iris-slack/hermes-home/` に
     分離している。
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
| `pnpm smoke:{pi,copilot,hermes}` | backend スモーク（`scripts/smoke-claude.ts` はあるが npm script 未接続） |
| `pnpm verify` | typecheck → check → lint:complexity → test（**push 前のゲート**） |

### コードスタイル

- TypeScript / ESM（`type: module`）。Node 22（`.node-version` で 22.18.0 に固定）。
- Biome（`biome.json`）で lint + format を一元管理。**実効値は `biome.json` にピン留め**（`indentStyle: tab` / `lineWidth: 80` / `quoteStyle: double` / `bracketSpacing: true` / `trailingCommas: all`）。複雑度（ディレクトリファイル数）は `scripts/check-complexity.sh` が補完。
- **`biome.json` はコメント不可（strict JSON）**。JSONC で書くと Biome が設定一式を
  無言で破棄して default で動く（exit 0・警告なし＝リポジトリを無傷に見せながら実質
  未設定）。`src/lint-config.test.ts` がこの契約の gate。
- 型付きルール（元 `typescript-eslint` の `no-floating-promises` / `no-unsafe-argument`）は Biome が持たないため `typecheck`(`tsc --noEmit`, `noUncheckedIndexedAccess` 等) でカバー。
- パッケージマネージャは **pnpm**。

### Biome 設定の設計判断（安易な変更禁止）

`biome.json` の各項目は「理想」でなく**実測に基づく意図的な値**。変更前に必ず計測する:

- **`useLiteralKeys: off`（115 箇所）**: wire protocol の field name を grep 可能に
  保つ意図的な bracket notation（`msg["session_id"]` 等。`src/protocol.ts` に明記）。
  `noPropertyAccessFromIndexSignature`（実効制約）を生かす写法でもある。
- **`noNonNullAssertion: off` は `*.test.ts` の限定**（39 箇所、off にしたのはテスト
  のみ）。fixture の `events[0]!` は生成側が要素を入れる前提。`noUncheckedIndexedAccess`
  との組合せで本番コード側は assertion 不要な構造を維持。
- **`json.formatter`（space / indentWidth 2）を個別 pin**: root が `tab` のまま
  `check:fix` すると `package.json` 等が再整形され diff が汚れる。
- **`vcs.useIgnoreFile: true`**: `iris.config.toml`（トークン）や `dist/` への
  `check:fix` の書き込みを防ぐ唯一の実効的防御。`useIgnorePatterns` は glob 非対応で
  使えない（count=0 を返すだけ）。

### テスト

- **vitest**。`*.test.ts` を `src/` に配置（`import {expect, test, describe, it} from "vitest"`）。
- 純粋ロジック（protocol / format / permission / 各 backend の protocol 変換）を中心にテスト。
- IO を持つ層（spawn / Bolt）は単体テストしない。ロジックは `protocol.ts` のように純粋関数へ切り出してテストする。
- 例外として**契約テスト**（`lint-config.test.ts` = biome.json、`release-workflow.test.ts` = release.yml の OIDC 設定）は設定ファイルの退行を CI で止める。
- backend の argv / spawn 検証は fake binary で argv を記録する方式（NUL 区切りで
  引数境界を保つ。複数行引数は `"$*"` ログでは検証できない）。

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

1. **lefthook** の `pre-push` で `pnpm verify` が自動実行される（`pnpm install` 時に `prepare` が `lefthook install` する）。
2. **GitHub Actions**（`.github/workflows/ci.yml`）でも push / PR 時に verify + coverage を実行。
3. **リリース**: tag `v*` → `release.yml` が npm（**Trusted Publishing / OIDC。`NPM_TOKEN` 不使用**）と 4 プラットフォームバイナリ、GitHub Release を生成。秘密と手動手順は `CONTRIBUTING.md`。tag push は `~/.npmrc` の `min-release-age=7` を超えていない環境からの publish にも影響しない（これは install 側の設定）。tag push 前に `pnpm verify` と version bump を確認する。

## 注意事項

- **commit / push はしない**: orchestrator が担当
- **config ファイルの無断変更は禁物**: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts` は issue で明示的に要求されない限り変更しない
- **パッケージマネージャ**: `pnpm` を使う（npm / yarn 禁止）

## 関連ドキュメント

- [README.md](README.md) — 概要・セットアップ（英語）
- [README.ja.md](README.ja.md) — 概要・セットアップ（日本語）
- [docs/slack-setup.md](docs/slack-setup.md) — Slack App 作成手順（日本語）
- 設計メモ（リポジトリ外）: `react-lab-mono/.claude/out/iris-design.md`
