# Iris

Slack ⇄ AIエージェント・ブリッジ — 最小構成・自己ホスト型。

<p align="right"><a href="./README.en.md">English</a></p>

Iris は Slack ワークスペースと、ローカルで動く **エージェント CLI**（[Claude Code](https://claude.com/claude-code) ・ [**Pi**](https://github.com/earendil-works/pi) ・ **Hermes**）をつなぎます。Slack のスレッドからエージェントに話しかけると、Iris がそのエージェントを常駐プロセスとして起動し、出力をストリームで返し、ツール実行の許可をクリック可能なボタンとして提示します。

これは [cc-connect](https://github.com/chenhg5/cc-connect)（14 エージェント × 13 プラットフォーム対応の汎用ブリッジ）の設計思想だけを参考に、**Slack ＋ 選択可能なエージェント・バックエンド（Claude Code / Pi / Hermes）**に絞って意図的に小さく作り直したものです。プラグインレジストリ・マルチプラットフォームの抽象・provider 切替・cron・relay・TTS などは持ちません。約 700 行（cc-connect の約 1/100）。

> 虹の女神 **Iris**（神々と人間をつなぐ伝令）に由来。Hermes / Mnemosyne / Argus と同じ神話系の命名。

## しくみ

```
Slack (Socket Mode) ──▶ index.ts ──▶ session.ts ──▶ <backend> ──▶ agent CLI
     ▲   block_actions                  thread_ts      (claude.ts | pi.ts | hermes.ts)
     └──── chat.postMessage ◀── format.ts ◀──────────────── events
```

- **1 Slack スレッド = 1 エージェント・セッション = 1 常駐プロセス**
- Claude Code は `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio` で起動。Pi / Hermes はそれぞれ独自プロトコル。Iris は stdin にユーザーメッセージ / 権限応答を書き、stdout の JSON イベントストリームをパースします。
- 権限要求は Block Kit の 許可 / 拒否 ボタンになり、クリックはエージェントへ返されます（Claude Code は `control_request`、Hermes は ACP `session/request_permission`、Pi は独自の RPC を経由）。
- プロセスが終了しても `session_id` を保持し、次のメッセージで会話を継続します（Claude Code は `--resume`、Pi は `--session`、Hermes は `session/resume`）。

## セットアップ

### 1. Slack App を作る

詳細な手順は **[docs/slack-setup.md](./docs/slack-setup.md)（日本語）** を参照してください。要点だけ書くと:

- **Socket Mode** を有効化 → App-Level Token（`xapp-...`）を生成（スコープ `connections:write`）
- **Bot Token Scopes**: `app_mentions:read`、`chat:write`、`channels:history`、`files:read`（ユーザーが送る画像/ファイルを受け取る場合）
- **Event Subscriptions**: `app_mention`、`message.channels`
- **Interactivity** を有効化（権限ボタン用）
- ワークスペースにインストール → Bot Token（`xoxb-...`）を取得

### 2. インストールする

**方法 A: スタンドアロンバイナリ（推奨・Node 不要）**

[Releases](https://github.com/t2tx/iris/releases) からお使いのプラットフォーム用バイナリをダウンロードして配置するだけです。

| プラットフォーム | アセット | 備考 |
|---|---|---|
| macOS arm64 | `iris-macos-arm64.zip` | Apple 署名・公証済み |
| Linux x86_64 | `iris-linux-x64.tar.gz` | |
| Linux arm64 | `iris-linux-arm64.tar.gz` | AWS Graviton, Raspberry Pi 等 |
| Windows x86_64 | `iris-windows-x64.zip` | |

```bash
# macOS / Linux
tar xzf iris-linux-x64.tar.gz   # or unzip iris-macos-arm64.zip
mv iris /usr/local/bin/iris
iris --help
```

```powershell
# Windows (PowerShell)
Expand-Archive iris-windows-x64.zip -DestinationPath .
.\iris.exe --help
```

**方法 B: npm（Node 環境がある場合）**

```bash
npm install -g @t2tx/iris
```

> Iris は `claude` CLI を起動するだけで API キーは扱いません。`claude` が認証済みである
> ことが前提です。

### 3. 設定ファイルを作る

設定はすべて 1 つの TOML ファイルです。`iris init` でコメント付きの雛形を生成できます（本番は `~/.iris-slack/config.toml`、権限 600 で作成。既存ファイルは上書きしません）。

```bash
iris init                 # 雛形を生成（~/.iris-slack/config.toml）
# → エディタで開いて [slack] のトークンと [[projects]] を埋める
iris config check         # 起動せずに設定を検証（OK ならプロジェクト一覧を表示）
iris config path          # いま使われる設定ファイルのパスを表示
```

埋める中身は次のとおり（トップレベルのキーは `[slack]` / `[[projects]]` より「前」に置くこと）:

```toml
permission_mode = "manual"    # manual（毎回確認）| acceptEdits | auto

[slack]
bot_token = "xoxb-..."        # Bot Token
app_token = "xapp-..."        # App-Level Token（Socket Mode）

[[projects]]
name = "default"
work_dir = "/path/to/your/repo"
allow_channels = ["C0123ABCDEF"]  # このチャンネルで @Iris に反応
allow_users = ["U09XXXXXXX"]      # この人の DM に反応
```

サンプル: [iris.config.example.toml](./iris.config.example.toml)。詳細な手順は **[docs/slack-setup.md](./docs/slack-setup.md)** を参照。

### エージェント・バックエンドの選定

Iris は既定で [Claude Code](https://claude.com/claude-code)（`claude` CLI）を駆動します。
[**Pi** コーディング・エージェント](https://github.com/earendil-works/pi)（`agent = "pi"`）
や、[**Hermes**](https://github.com/hermes-agent/hermes)（`agent = "hermes"`）も選べます
（プロジェクト単位、またはトップレベルの既定で）。

- トップレベルの `agent` キーでバックエンドを選定（既定 `claude`、各プロジェクトで上書き可）。
- 既定の Claude バックエンドは何も変更不要。`agent` 未指定 = `claude`。

```toml
# 全プロジェクトで Pi を使う場合（トップレベル既定。各プロジェクトで上書き可）:
agent = "pi"
# pi_bin = "pi"             # Pi CLI のパス（既定 "pi"。PATH に無ければこのパスを指定）

[[projects]]
name = "pi-lab"
work_dir = "/path/to/your/repo"
allow_users = ["U09XXXXXXX"]
# agent = "pi"             # プロジェクト単位の指定（省略時はトップレベルを継承）

# もしくは Hermes を ACP（Agent Client Protocol）経由で駆動:
# agent = "hermes"
# hermes_bin = "hermes"     # Hermes CLI のパス（既定 "hermes"。PATH に無ければこのパスを指定）
```

- **Pi のインストール**: Iris は `pi` CLI を起動するだけで、インストールは行いません。
  Pi のインストール・認証は [Pi リポジトリ](https://github.com/earendil-works/pi)
  の手順に従って行ってください。PATH に無ければ `pi_bin` でパスを指定します。
- **Hermes の運転**: Iris は `hermes acp` を起動するだけで、インストールも model 設定も
  行いません。Agent Client Protocol（ACP）を話す `hermes acp` に対するその ACP 依存
  （`agent-client-protocol`）の確保・model 設定は Hermes 側の手順で済ませます。PATH に
  無ければ `hermes_bin` でパスを指定します。3 バックエンドは同一の outbox / セッション再開
  規約を持ち、違いは wire プロトコルのみ（Claude Code = `stream-json`＋標準の権限ツール、
  Pi = 独自 RPC、Hermes = ACP / JSON-RPC）。
- 全バックエンドとも Slack に向けて同じ面（権限ボタン・進捗表示・セッション再開）を
  提示します。違いは駆動する CLI のみです。

### 4. 起動する

```bash
iris            # フォアグラウンドで起動（全プラットフォーム共通）
iris install    # launchd に常駐登録して起動（macOS のみ）
iris status     # launchd の稼働確認（macOS のみ）
```

### 5. Slack で使う

**チャンネル**: 許可したチャンネルに Bot を招待し（`/invite @Iris`）、`@Iris ○○して` とメンションします。以降はそのスレッド内で会話を継続できます。

**DM**: Bot に直接 DM を送ります（`allow_users` に自分のユーザー ID が必要）。DM はスレッドを使わないフラットな会話で、1 つの DM = 1 セッションです。

## 設定（TOML）

設定ファイルは次の順で探索されます:

1. `IRIS_CONFIG=<path>`（明示）
2. `./iris.config.toml`（カレントディレクトリ = 開発時）
3. `~/.iris-slack/config.toml`（インストール後の既定）

| キー | 場所 | 意味 |
|-----|------|------|
| `bot_token` / `app_token` | `[slack]` | Slack トークン（`xoxb-` / `xapp-`） |
| `claude_bin` | トップレベル | claude CLI のパス（既定 `claude`） |
| `agent` | トップレベル / 各 project | バックエンド `claude` \| `pi` \| `hermes`（既定 `claude`） |
| `pi_bin` | トップレベル | Pi CLI のパス（既定 `pi`、`agent = "pi"` のとき使用） |
| `hermes_bin` | トップレベル | Hermes CLI のパス（既定 `hermes`、`agent = "hermes"` のとき使用。ACP `hermes acp` を駆動） |
| `permission_mode` | トップレベル / 各 project | `manual` \| `acceptEdits` \| `auto` |
| `log_level` | トップレベル | `debug` \| `info` \| `warn` \| `error`（既定 `info`） |
| `idle_ttl_min` | トップレベル | 無操作が続いたセッションのプロセスを終了するまでの分数（既定 `1440`＝24h、`0` で無効）。環境変数 `IRIS_IDLE_TTL_MIN` で上書き可 |
| `model` | トップレベル / 各 project | `--model` の上書き（省略可） |
| `work_dir` | 各 `[[projects]]` | Claude の作業ディレクトリ |
| `allow_channels` | 各 `[[projects]]` | 許可するチャンネル ID。**空 = チャンネル拒否** |
| `allow_users` | 各 `[[projects]]` | 許可するユーザー ID（DM / ユーザー制限）。**空 = DM 拒否** |

- **ルーティング**: 受信メッセージは各プロジェクトの `allow_channels`（チャンネル）/ `allow_users`（DM）で照合され、**最初にマッチしたプロジェクト**の `work_dir`・権限モードで Claude が起動します。どれにもマッチしなければ無視（デフォルト拒否）。
- `[[projects]]` を複数並べると、作業ディレクトリ・権限モードを相手ごとに使い分けられます。
- トークンを含むため、設定ファイルは**他人に読まれない権限**で保管してください（`chmod 600`）。`iris.config.toml` は gitignore 済み。

### チーム運用：同じチャンネルで各自の Iris を使う

「各メンバーが自分のマシンで自分の Iris（自分の Slack App）を動かし、同じチャンネルに集める」運用ができます。

- 各自が自分の App を作り（`iris-alice` / `iris-bob` …）、自分のホストで Iris を起動。`allow_channels` に共通チャンネル、`allow_users` に**自分の Slack ユーザー ID だけ**を設定。
- チャンネルは公開なので、`@iris-alice ○○` のやり取りは**チャンネル全員に見える**（情報共有）。一方、実行は mention した bot のホスト（その人の `work_dir` / API キー）で行われ、**作業は各自のマシンで隔離**されます。
- `allow_users` を設定したプロジェクトは「**チャンネル許可 かつ ユーザー許可**」で判定するため、UserA が `@iris-bob` と打っても iris-bob は無反応（UserA は iris-bob の `allow_users` に居ない）。各自の bot は自分の所有者にだけ応答します。
- `allow_users` を空にすると従来通り「許可チャンネルの全員に応答」になります（共有 bot 運用）。

> 最も隔離が強いのは DM 運用です（他者からは見えない）。チャンネル運用は「作業を見せ合いたい」場合に選びます。

## セキュリティ方針

- **デフォルト拒否**: `allow_channels` / `allow_users` が両方空なら、Iris はすべてのメッセージを無視します。チャンネルはチャンネル ID で、DM は送信ユーザー ID で許可します。
- **権限の既定は手動承認**: すべてのツール実行に明示的なクリックが必要です。`acceptEdits` は編集系ツールを自動許可、`auto` はすべて自動許可 — 信頼できる相手でのみ opt-in してください。
- **外向き連携を持たない**（cron / relay / provider 切替なし）。攻撃面は「Slack 受信 → Claude CLI 実行」のみです。
- トークンは設定ファイル（TOML）にのみ置きます。ファイル権限で保護してください。

## 機能

- チャンネル（@mention + スレッド）/ DM での会話、スレッド = セッション
- ツール実行の権限ボタン（許可 / 拒否）、権限モード切替（manual / acceptEdits / auto）
- ストリーミングの逐次更新、使用量フッター（トークン / コスト / 所要時間）
- ユーザー → AI への画像 / ファイル送信（画像は直接認識、ファイルは読み込み）
- AI → ユーザーへの生成ファイル送信
- スラッシュコマンド（`/help` `/status` `/sessions` `/restart` `/clear` `/switch` `/resume` `/summary` `/cc:`）
- `/switch <name>` でセッションごとに作業ディレクトリを切り替え（`work_dir` 配下を検索）
- `/resume` で過去のセッション一覧を表示（claude のみ・ターン数・直近の発言つき）、`/resume <id>` でセッション id で再接続（全 backend で可）
- `/summary` で現在の会話を引き継ぎ用に要約（コードブロックで出力）、`/summary <要望>` で指示を指定
- `/cc:<command> [args]` で Claude Code 側の `/<command>` を実行（**Claude バックエンドのみ**。pi/hermes スレッドではテキストをそのままプロンプトとして渡します）
- 複数プロジェクトのルーティング（TOML config）
- アイドルセッションの自動終了：無操作が `idle_ttl_min` 分（既定 24h）続いたセッションの Claude プロセスを終了してメモリを解放。停止時はスレッドに一時停止を通知し、次のメッセージで `--resume` により再開（再開も通知）するため、文脈は失われない

## 開発に参加する

開発環境のセットアップ、テスト、本番 / 開発の Slack App 分離などは
[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。
