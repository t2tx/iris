# Slack App セットアップ手順

このガイドでは、**Iris** を Slack に接続し、Slack のスレッドからローカルの Claude Code を操作できるようにするまでの手順を説明します。

> 💡 **メリット**: Socket Mode（WebSocket）を使うため、**公開 IP・ドメイン・リバースプロキシは一切不要**です。社内ネットワークや開発者のローカルマシンだけで完結します。

## 前提条件

- Slack App を作成できる権限を持つ Slack ワークスペースのアカウント
- Iris を動かせるマシン（公開 IP 不要）
- Claude Code CLI がインストール・設定済みであること

---

## ステップ 1: Slack App を作成する

### 1.1 Slack API コンソールを開く

[Slack API（https://api.slack.com/apps）](https://api.slack.com/apps) にアクセスし、Slack アカウントでサインインします。

### 1.2 新しい App を作成する

1. 「**Create New App**」をクリック
2. 「**From scratch**」を選択
3. アプリ情報を入力する

   | 項目 | 推奨値 |
   |------|--------|
   | App Name | `Iris` |
   | Development Slack Workspace | 使用するワークスペースを選択 |

4. 「**Create App**」をクリック

---

## ステップ 2: Bot ユーザーを設定する

### 2.1 App Home を開く

左サイドバーの「**App Home**」をクリックします。

### 2.2 Bot 情報を設定する

「**Edit**」から表示名を設定します。

| 項目 | 推奨値 |
|------|--------|
| Display Name (Bot Name) | `Iris` |
| Default Username | `iris` |

### 2.3 常にオンライン表示にする（任意）

「**Always Show My Bot as Online**」をオンにします。

### 2.4 DM を受け付ける（DM 運用する場合）

Bot に DM で話しかけたい場合は、App Home で次をオンにします。

- 「**Allow users to send Slash commands and messages from the messages tab**」（メッセージタブからの送信を許可）

これをオンにしないと、ユーザーが Bot に DM を送れません。

---

## ステップ 3: 権限（OAuth スコープ）を設定する

### 3.1 OAuth & Permissions を開く

左サイドバーの「**OAuth & Permissions**」をクリックします。

### 3.2 Bot Token Scopes を追加する

「**Scopes**」→「**Bot Token Scopes**」に以下を追加します。

| スコープ | 用途 | 必須 |
|----------|------|------|
| `app_mentions:read` | @メンションを読む | ✅ 必須 |
| `chat:write` | メッセージを送信する | ✅ 必須 |
| `channels:history` | パブリックチャンネルのメッセージ（スレッド返信）を読む | ✅ 必須 |
| `groups:history` | プライベートチャンネルのメッセージを読む | 任意 |
| `im:history` | DM 履歴を読む（DM 運用する場合） | 任意 |
| `files:read` | ユーザーが添付した画像/ファイルをダウンロードする | 任意（受信添付を使う場合は必須） |
| `files:write` | Claude が生成したファイル（PDF・画像など）を Slack にアップロードする | 任意（送信を使う場合は必須） |

> Iris は「チャンネルで `@Iris` とメンション → 立ったスレッド内で会話を続ける」という運用が基本です。そのため `app_mentions:read`・`chat:write`・`channels:history` が中心になります。
>
> ユーザーが画像やファイルを Bot に送って Claude に解析させたい場合は `files:read` を追加してください（画像は Claude が直接「見る」、その他のファイルはローカルに保存して Claude が読みます）。
>
> 逆に、Claude が生成したファイル（PDF・グラフ画像など）を Slack に送り返してほしい場合は `files:write` を追加してください。Iris は Claude の出力に含まれるローカルパスを検出し、実在するファイルを自動でアップロードします。**`files:write` が無いと `missing_scope` エラーでアップロードに失敗します。**
>
> スコープ追加後は **再インストール**が必要です。

---

## ステップ 4: Socket Mode を有効にする

### 4.1 Socket Mode 設定を開く

左サイドバーの「**Socket Mode**」をクリックします。

### 4.2 Socket Mode を有効化する

1. 「**Enable Socket Mode**」をオンにする
2. App-Level Token の生成を求められます

### 4.3 App-Level Token を生成する

1. トークン名を入力（例: `iris-socket-token`）
2. 次のスコープを追加する
   - `connections:write` — WebSocket 接続を確立するため
3. 「**Generate**」をクリック

### 4.4 トークンを保存する

`xapp-...` 形式の **App-Level Token** が生成されます。これが `SLACK_APP_TOKEN` になります。

> ⚠️ このトークンは生成時に一度しか表示されません。**すぐにコピーして保存**してください。

---

## ステップ 5: Event Subscriptions を設定する

### 5.1 Event Subscriptions を開く

左サイドバーの「**Event Subscriptions**」をクリックします。

### 5.2 Events を有効化する

1. 「**Enable Events**」をオンにする
2. Socket Mode を使うため、**Request URL は不要**です

### 5.3 Bot イベントを購読する

「**Subscribe to bot events**」に以下を追加します。

| イベント | 用途 |
|----------|------|
| `app_mention` | Bot が @メンションされたときに発火（スレッドの起点） |
| `message.channels` | パブリックチャンネルのメッセージ受信（スレッド内の継続会話） |
| `message.groups` | プライベートチャンネルのメッセージ受信（任意） |
| `message.im` | DM 受信（DM 運用する場合は追加、任意） |

### 5.4 変更を保存する

「**Save Changes**」をクリックします。

---

## ステップ 6: Interactivity を有効にする（権限ボタン用）

Iris はツール実行の許可を **Block Kit のボタン**（✅ 許可 / ❌ 拒否）で尋ねます。ボタンのクリックを受け取るために Interactivity を有効化します。

1. 左サイドバーの「**Interactivity & Shortcuts**」を開く
2. 「**Interactivity**」をオンにする
3. Socket Mode を使うため、**Request URL は不要**です
4. 「**Save Changes**」をクリック

---

## ステップ 7: App をワークスペースにインストールする

### 7.1 インストール

左サイドバーの「**Install App**」→「**Install to Workspace**」をクリックします。

### 7.2 権限を承認する

権限を確認して「**Allow**」をクリックします。

### 7.3 Bot Token を取得する

インストール後、以下が表示されます。

```
Bot User OAuth Token: xoxb-xxxxxxx...
```

これが `SLACK_BOT_TOKEN` になります。

> ⚠️ このトークンも保存してください。設定で使います。

---

## ステップ 8: チャンネル ID を調べる

Iris は**デフォルト拒否**です。設定ファイルの `allow_channels` に許可するチャンネル ID を書かない限り、どのチャンネルにも反応しません。

チャンネル ID の調べ方:

1. Slack でチャンネルを開く
2. チャンネル名をクリック → 一番下の「**チャンネル ID**」をコピー（`C` から始まる文字列。例: `C0123ABCDEF`）

> 複数チャンネルを許可する場合は配列で指定します（例: `allow_channels = ["C0123", "C0456"]`）。
>
> チャンネルを使わず DM だけで運用する場合は、このステップは不要です（次のステップ 8.5 へ）。

### ステップ 8.5: ユーザー ID を調べる（DM 運用する場合）

DM は**送信者のユーザー ID** で許可します（設定ファイルの `allow_users`）。空なら DM を全拒否します。

ユーザー ID の調べ方:

1. Slack で自分（または許可したい人）のプロフィールを開く
2. 「**⋮（その他）**」→「**メンバー ID をコピー**」（`U` から始まる文字列。例: `U09XXXXXXX`）

> 複数ユーザーを許可する場合はカンマ区切りで指定します（例: `U0AAA,U0BBB`）。

---

## ステップ 9: Iris をインストールする

**方法 A: スタンドアロンバイナリ（推奨・Node 不要）**

[Releases](https://github.com/t2tx/iris/releases) から `iris` バイナリ（macOS
arm64）をダウンロードして配置します。Node/npm 不要、Apple 署名・公証済みです。

```bash
chmod +x iris
mv iris /usr/local/bin/iris   # PATH の通った場所へ
iris --help
```

**方法 B: npm（Node 環境がある場合）**

```bash
npm install -g @t2tx/iris
```

> **Claude の認証について**: Iris は `claude` CLI を起動するだけで、API キーは扱いません。`claude` 自体が認証済み（`claude` で一度ログイン済み、または環境に Claude 用の認証が設定済み）であることが前提です。ターミナルでそのまま `claude` が起動するなら OK です。

---

## ステップ 10: 設定ファイルを作る

設定はすべて 1 つの TOML ファイル `~/.iris-slack/config.toml` に書きます。

```bash
mkdir -p ~/.iris-slack
```

`~/.iris-slack/config.toml` を作成し、これまでのステップで取得した値を入れます。

```toml
# トップレベルのキー（permission_mode など）は、必ず [slack] や [[projects]] の
# 見出しより「前」に書きます（後ろに書くとそのテーブル内のキー扱いになり効きません）。
permission_mode = "manual"    # manual（毎回確認）| acceptEdits | auto（全自動）

[slack]
bot_token = "xoxb-..."        # ステップ 7 の Bot Token
app_token = "xapp-..."        # ステップ 4 の App-Level Token

[[projects]]
name = "default"
work_dir = "/path/to/your/repo"   # Claude が作業するディレクトリ
allow_channels = ["C0123ABCDEF"]  # ステップ 8 のチャンネル ID（このチャンネルで @Iris に反応）
allow_users = ["U09XXXXXXX"]      # ステップ 8.5 のユーザー ID（この人の DM に反応）
```

ポイント:

- **デフォルト拒否**: `allow_channels` / `allow_users` に書いた相手にだけ反応します。両方空（または未記載）だと何にも反応しません。
- **チャンネルだけ使う**なら `allow_users` を省略、**DM だけ使う**なら `allow_channels` を省略してかまいません。
- トークンを含むファイルなので、**他人に読まれない場所・権限**で保管してください（`chmod 600 ~/.iris-slack/config.toml` 推奨）。
- 作業ディレクトリや権限モードを相手ごとに変えたい場合は、`[[projects]]` を複数並べられます（最初にマッチしたものが使われます）。

| トークン | 接頭辞 | 用途 |
|----------|--------|------|
| Bot Token | `xoxb-` | Bot の API 認証 |
| App-Level Token | `xapp-` | Socket Mode 接続 |

---

## ステップ 11: 起動する

常駐サービスとして登録します（ログイン中ずっと動き、自動再起動されます）。

```bash
iris install          # ~/.iris-slack/config.toml を読んで launchd に登録・起動
iris status           # 稼働状況を確認
iris uninstall        # 停止して登録解除
```

> 別の場所の設定ファイルを使う場合は `iris install --config /path/to/config.toml`。

試しに前景で動かすだけなら、設定ファイルを置いた状態で `iris` を実行します（Ctrl-C で停止）。起動に成功すると次のようなログが出ます。

```
Iris started. 1 project(s):
  • default: workDir=/path/to/your/repo mode=manual channels=[C0123ABCDEF] dmUsers=[U09XXXXXXX]
```

> 許可リストが両方空のときは「すべてのメッセージを無視する（default-deny）」という警告が出ます。

---

## ステップ 12: 使ってみる

### 12.1 Bot をチャンネルに招待する

許可したチャンネルで次を実行します。

```
/invite @Iris
```

### 12.2 メンションして会話を始める（チャンネル）

```
@Iris このプロジェクトの構成を説明して
```

Iris が返信し、**そのスレッド内で会話を継続**できます。スレッド内では @メンション不要で続けて話しかけられます。

### 12.3 DM で会話する

Slack の検索などから Bot（`Iris`）を開いて DM を送ります。

```
このリポジトリの構成を教えて
```

- DM はスレッドを使わない**フラットな会話**で、その DM 全体が 1 セッションになります。
- 画像やファイルを添付すると Claude に渡せます（画像はそのまま認識、その他のファイルは読み込んで解析。`files:read` スコープが必要）。
- スラッシュコマンド（`/help` など）も使えます。

### 12.4 ツール実行の許可

Claude がファイル編集やコマンド実行をしようとすると、Iris が次のようなボタンを出します。

```
🔒 Permission request — Claude wants to use *Bash*
   ```ls -la```
   [ ✅ Allow ]  [ ❌ Deny ]
```

- 「✅ Allow」を押すとツールが実行されます。
- 「❌ Deny」を押すと拒否され、Claude は指示待ちに戻ります。

`permission_mode = "acceptEdits"` にすると編集系ツールは自動許可、`"auto"` にすると全ツール自動許可になります（信頼できる相手でのみ使用してください）。

---

## トラブルシューティング

設定はすべて `~/.iris-slack/config.toml` です。変更したら `iris uninstall && iris install`（または `iris` を再起動）で反映します。

| 症状 | 確認点 |
|------|--------|
| チャンネルで反応しない | `allow_channels` にそのチャンネル ID が入っているか。Bot がチャンネルに招待されているか |
| DM で反応しない | `allow_users` に自分のユーザー ID が入っているか。App Home の「メッセージタブからの送信を許可」（ステップ 2.4）がオンか。`message.im` イベント・`im:history` スコープがあるか |
| DM の入力欄が無効／送れない | App Home の Messages Tab 設定（ステップ 2.4）を確認 |
| 起動時に `invalid_auth` | `[slack]` の `bot_token` / `app_token` が正しいか（接頭辞 `xoxb-` / `xapp-`） |
| ボタンを押しても反応しない | ステップ 6 の Interactivity が有効になっているか |
| スレッドの 2 通目以降に反応しない | `message.channels`（プライベートなら `message.groups`）を購読しているか、`channels:history` スコープがあるか |
| 添付ファイルが Claude に渡らない | `files:read` スコープがあるか（追加後は再インストール） |
| 古い応答が返る／反応が不安定 | 同じ Slack App で Iris が二重起動していないか（`iris status` や `ps` で確認）。Socket Mode は接続が 1 つのため、複数起動すると混線します |
| `claude: command not found` | トップレベルの `claude_bin` に claude CLI の正しいパスを指定する（例: `claude_bin = "/opt/homebrew/bin/claude"`） |
