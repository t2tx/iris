# SPEC: Copilot CLI を新たな agent backend として追加

- **status**: draft（2026-09-04 起草）
- **対象 repo**: `iris-oss`
- **検証対象**: `github.com/github/copilot-cli` **v1.0.82**（ご自身の `copilot` 実体、例: Homebrew 版、macOS arm64, Node SEA）
- **詳細設計 / プロトコル根拠**: [`../backends/copilot-backend.md`](../backends/copilot-backend.md)
- **WBS**: [`../backends/copilot-wbs.md`](../backends/copilot-wbs.md)

> 本 SPEC は「copilot を `claude`/`pi` と同型の backend として追加する」ことを定義する。
> プロトコルは `copilot --acp`（Agent Client Protocol, ACP）を **実測** で確定済み。

---

## 1. 背景・目的

`iris-oss` は「Slack⇔AGent CLI ブリッジ」。現行は `claude`（`-p --input-format
stream-json --permission-prompt-tool stdio`）と `pi`（`--mode rpc`, NDJSON over stdio）の
2 backend。後者は **per-turn のリクエスト／完了通知**モデルで、copilot が提供する ACP と
構造が近い。

copilot は「GitHub Copilot 同一の agentic harness が動く CLI」で、
`--acp` で **ACP（JSON-RPC 2.0 over stdio）** を提供する。本 SPEC はこれを新たな backend として
統合し、Slack から copilot を駆動できるようにする。アーキテクチャ前提（`AgentProcess` 抽象 +
`SessionConfig.createProcess` 分岐 + パーサー分離）は既存通りで、**新 backend = 1 ファイル + 1 分岐**
の追加に留める。

## 2. ゴール / 非ゴール

### ゴール（G）

- G1. `config.toml` の `agent = "copilot"` で copilot を起動でき、Slack で対話・ストリーム表示。
- G2. プロンプトは **ACP `session/prompt`**、回答テキストは `agent_message_chunk` → Slack へ逐次。
- G3. ツール呼び出し（`tool_call`/`tool_call_update`）を `tool_use` 相当として Slack 表示。
- G4. `/resume` を **ACP `session/list`** で実現（cwd 範囲の一覧＋番号選択＋`--resume <sid>` 継続）。
- G5. 権限モード（`auto`/`acceptEdits`/`manual`）を **copilot の起動時フラグ**にマッピング。
- G6. `usage_update`/ターン末尾の usage を `result` 相当として蓄積し、`/usage`・`/stats`・
  daily digest で backend 別に整形。
- G7. `AgentProcess` 準拠で、copilot 系は `kill()` / `on()` / 孫プロセス回収に既存ロジックを流用。
- G8. `copilot` 系（`copilot-protocol.ts`, `copilot-sessions.ts`）を**新ファイル**で追加し、
  既存 backend と `index.ts`/`config.ts` の差分を最小にする。

### 非ゴール（NG）（第 1 弾）

- NG1. **対話的 per-action 権限ブロック**（Slack の許可/拒否ボタン）を ACP 経由で取得すること。
   copilot の ACP 非対話ランでは許可要請は発火しない（設計ノート §1.3）。第 2 弾。
- NG2. copilot 側の課金・プラン・quota 制御、IDE 連携、TUI の移植。
- NG3. `~/.copilot/session-store.db`（SQLite, WAL）の直接読み取り。`/resume` は ACP `session/list` で済ませる。

## 3. 要件

### 3.1 機能要件

| ID | 要件 |
|---|---|
| F1 | `agent="copilot"` を選択すると `copilot --resume <sid> --acp --log-level error` を spawn する（`--resume` は 2 ターン目以降） |
| F2 | `initialize`（`protocolVersion=1` 数値）→ `session/new` → `session/prompt` の順でハンドシェイク |
| F3 | `session/update` の各 `update.sessionUpdate` を `ParsedEvent` に変換（`agent_message_chunk`→`text`, `tool_call`/`tool_call_update`→`tool_use`, `end_turn`→完了, `usage_update`→`result` のusage 蓄積） |
| F4 | `session/prompt` の完了は `end_turn`または完了通知（`result`/`stopReason`）で判定し、その場で `onMessage('result', sid, usage)` を 1 回叩く |
| F5 | `session/new` の `sessionId` を保存（`result` に ride）。次 turn は `--resume <sid>` で継続 |
| F6 | `/resume` は `session/list{cwd}` から {sessionId,cwd,title,updatedAt} を取得し、既存 `listClaudeSessions` と等価な API で差し替え |
| F7 | `PermissionMode`→起動フラグ変換（下表）。`--deny-tool` は allow より優先（copilot 側規則） |
| F8 | `AgentKind` に `'copilot'`、`copilotBin`（既定 `copilot`）を追加。既存 2 backend の挙動は不変 |
| F9 | `kill()`/`on()`（`/stop`,`/model`,`/mode`）は `AgentProcess` の既存実装を流用。孫プロセス（bash/MCP）は `kill -9 PID; pkill -P PID` で回収 |

### 3.2 非機能要件

- N1. stdio 汚染なし：ACP 通信は stdout の JSON-RPC に集約。copilot 側ログは `--log-level error`
  で stderr へ抑圧（設計ノート）。
- N2. 破壊的変更耐性：`copilot --version` を smoke 化し、`protocolVersion` 不整合は起動時に検出して
  明確なエラーにする（NG 対応でなく起動拒否）。
- N3. 既存 backend（claude/pi）への影響ゼロ：新 backend は独立ファイル＋分岐 1 本。
- N4. public リポジトリであるため、ドキュメント・ログ・テストに **機密（トークン等）を含まない**
   （参照 §7 の e2e スキーム）。

## 4. プロトコル仕様（実測確定、v1.0.82）

詳細は [`copilot-backend.md`](../backends/copilot-backend.md) §1。要点：

- **transport**: JSON-RPC 2.0 over stdio（1 行 1 メッセージ）。
- **`initialize`**: `protocolVersion` は **数値 `1`**（文字列 `"1"` だと `-32600`）。
   `clientCapabilities:{}`, `clientInfo:{name,version}`。
- **`session/new`**: `params:{cwd, mcpServers:[]}` → `result.sessionId`（resume ハンドル）,
   `models`, `modes{mode:{current,options}}, configOptions`。
- **`session/prompt`**: `params:{sessionId, prompt:[{type:'text',text} | image...] }`。
   完了は `end_turn` / 完了通知で判定。
- **`session/update`**（notification, `id` なし）：`update.sessionUpdate` が種類。
   - `agent_message_chunk` → `{content:{type:'text',text}}`（スレッド）
   - `tool_call` → `{toolCallId, kind, title, rawInput{command?}, status}`
   - `tool_call_update` → 状態遷移＋出力
   - `usage_update` / `available_commands_update` / `session_info_update` / `config_option_update`
   - `end_turn` → ターン完了
- **`session/list`**: `{sessions:[{sessionId,cwd,title,updatedAt}]}`（`/resume` 用）。
- **`session/close`**: `/stop` 相当で明示 close 可。
- **権限**: `--allow-all`/`--allow-tool`/`--deny-tool`/`--available-tools`/`--excluded-tools`/
   `--allowedUrls`/`--no-exec`。対話的要請は ACP 非対話ランで抑制（NG1 参照）。

## 5. 実装設計

```
src/
├─ agent.ts                 # UsageInfo に copilot 系フィールドを追加（後方互換）
├─ backends/
│  ├─ copilot.ts           # CopilotProcess : AgentProcess 準拠
│   └─ copilot-protocol.ts # parseEvent(raw): ParsedEvent[]  （純関数, 単体テスト対象）
└─ copilot-sessions.ts     # /resume ─ session/list を叩き ParsedSession[] を返す
```

### 5.1 `CopilotProcess`（`src/backends/copilot.ts`）

- **spawn**: `copilot [--resume <sid>] --acp --log-level error`。
  `--resume` は 2 ターン目以降（`sid` があれば）。
- **ハンドシェイク**（1 回 / プロセス起動時）: `initialize`→`onMessage('init',...)`、
  `session/new`→`sessionId` を保持。
- **`onMessage(userText)`**: `session/prompt{sessionId, prompt:[{type:'text',text:userText}]}` を 1 つ送信。
  turn 完了（`end_turn`/`stopReason`）で `onMessage('result', sid, usage)` を 1 回。**pi と同型の per-turn**。
- **`kill()`**: SIGTERM→(遅延) SIGKILL ＋ `pkill -P <pid>` で孫プロセスを回収（設計ノート §R1）。
- **`on(type, payload)`**: `permission`/`model`/`mode`/`stop`。copilot は ACP で `set_mode`/
  `set_model`/`close` を使う必要（R4 実測、第 1 弾では `stop`→kill、model/mode は `session/set_mode`
  ・`session/set_model` 実測で実装）。
- 各 `session/update` を `copilot-protocol.ts` の `parseEvent()` に回し、`ParsedEvent[]` を emit。

### 5.2 `copilot-protocol.ts`（パーサー、純関数）

`raw: string`（1 行 JSON）→ `ParsedEvent[]`。
- `session/update` で `update.sessionUpdate` を分岐。
- `agent_message_chunk` → `{kind:'text', text}`。
- `tool_call` → `{kind:'tool_use', toolName, toolInput: rawInput, status}`。
- `tool_call_update` → status/出力で `tool_use` 更新（既存 `PiParseState` 等の状態を copilot 向けに用意）。
- `end_turn` / 完了 → `process close`/`result` 完了信号。
- `usage_update` / usage 付き result → `result` の `UsageInfo` 蓄積。
- 未知 / 非 `session/update`（`initialize`/`session/new` response 等）は**ハンドシェイクは実装側**で扱う。
  （copilot はハンドシェイク response を `id` 付きで返すので、実装側で `id` 照合。パーサーは
   `session/update` notification に集中）

### 5.3 `copilot-sessions.ts`（`/resume`）

- ACP を一時的に起動し `initialize`→`session/list{cwd:<project>}` →
   `{sessionId, title, updatedAt}` を古い順。既存 `listClaudeSessions` と等価なシグネチャで差し替え
   （`/resume` 本体は変更不要、`agent` 別 select を追加）。
- フォールバック：`copilot` 起動不可時は空一覧。

### 5.4 `AgentKind` / `PermissionMode` / `UsageInfo` 拡張（`config.ts`/`agent.ts`）

- `AgentKind` に `'copilot'` 追加。`copilotBin`（既定 `copilot`）。既存 2 値の影響なし。
- `PermissionMode` なし。下の変換を `copilot.ts` 内に保持：

   | iris mode | copilot 起動オプション |
   |---|---|
   | `auto` | `--allow-all`（＝`--yolo` 同等） |
   | `acceptEdits` | `--allow-tool 'write(*)'`（shell は既定 / 次いで `--no-exec` は不可） |
   | `manual` | 既定 `defaultPermissionMode=manual`（ACP では対話を抑制され得＝semi-auto） |

- `UsageInfo` に後方互換の任意のフィールドを追加：`premiumRequests`, `apiDurationMs`, `sessionDurationMs`,
   `codeChanges`。`costUSD` は copilot 側で `0`/非表示。

## 6. デザイン判断

1. **ACP を採用**（`copilot -p` 1 呼びずつではない）：ストリーム＋`session/list`＋resume が ACP で完結。
2. **`PiProcess` を土台**に作る：per-turn のリクエスト／完了通知モデルが最も近い。
3. **パーサーは独立ファイル・純関数**（pi と同型）→ 単体テスト容易。
4. **権限は第 1 弾＝起動時ポリシー**（NG1）。対話的許可は第 2 弾。
5. **`/resume` は `session/list`**（DB スキーマ非公開を避ける、NG3）。
6. **破壊的変更を起動時に検出**（`protocolVersion` 不一致で起動拒否＋明示エラー）。

## 7. テスト戦略

- **単体**（最重要）：`copilot-protocol.ts` に対し、実測 JSONL（`agent_message_chunk`/`tool_call`/
   `tool_call_update`/`end_turn`/`usage_update`）を固定サンプルで投入し、`ParsedEvent[]` を照合。
- **`copilot-sessions.ts`**：`session/list` の response をモックし、`{sessionId,title,updatedAt}` 整形。
- **smoke**：`copilot --version` が 0 なら `copilot` backend を有効化（失敗時は `config` で非表示）。
- **e2e（手動）**：実 copilot 起動。認証＋課金前提のため、
   **CI/e2e では secret 非保持**（`n/a` の `claudeApiKey` 同型）で、
   ローカルのみ手動検証。テストに実トークンを埋め込まない（N4）。
- **リグレッション**：`claude` / `pi` の既存テストが全維持。

## 8. リスク

1. **copilot 更新で ACP 破壊的変更**：protocolVersion 不一致を検出し起動拒否（N2）。smoke で検出。
2. **対話的権限の欠如（NG1）**：`--allow-tool`/`--deny-tool` による宣言的ポリシーで代替。第 2 弾。
3. **孫プロセスの遺留**：`kill`/終了で `pkill -P <pid>` を実行。
4. **usage スキーマ非互換**：`UsageInfo` 可選拡張で対応。`/stats` 各 backend で整形。
5. **`session/set_mode`/`set_model`/`close` の shape 未検証**：実装時に実測（R4）。
   実装前に `copilot --acp` で再確認し、shape を `copilot-protocol.ts` に固定。
6. **`--resume` の挙動**：copilot の `--resume <sid>` は copilot 側で session-store.db から復元。
   第 1 弾で `--resume <sid>` だけで成立するか実測。不成立時は `session/new` + 履歴転載を検討。

## 9. 受け入れ条件

- [ ] `config.toml` で `agent="copilot"` を指定して起動でき、Slack で対話・ストリーム表示。
- [ ] `/resume` で一覧＋選択＋継続が動作（`copilot-sessions.ts` 経由）。
- [ ] `auto` / `acceptEdits` / `manual` で起動オプションが正しく付き、Slack 側に通知。
- [ ] `copilot-protocol.ts` 単体テストが全緑。`claude`/`pi` の既存テストが全維持。
- [ ] `copilot-sessions.ts` が `session/list` をモックで検証できている。
- [ ] `docs/backends/copilot-backend.md`（実測プロトコル）／本 SPEC／WBS が同期。**機密なし**。

## 10. 参照

- `docs/backends/copilot-backend.md` — 実測プロトコル＋権限設計。
- `docs/backends/copilot-wbs.md` — 実装タスク分解。
- `github.com/github/copilot-cli` v1.0.82（イニシャライザ/ドキュメントリポジトリ）／`--acp` 実測。
- 既存 backend 実装：`src/backends/pi.ts`（最良の土台）, `src/backends/claude.ts`,
  `src/backends/pi-protocol.ts`, `src/agent.ts`, `src/config.ts`, `src/index.ts`, `src/copilot-sessions.ts` 相当（`claude-sessions.ts`）。
