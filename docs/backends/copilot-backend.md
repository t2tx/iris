# Copilot CLI backend — 設計ノート（feasibility + design）

> 対象: `iris-oss` に新たな agent backend として **GitHub Copilot CLI** (`copilot`) を追加する
> 検証日: 2026-09-04 / 検証対象: `github.com/github/copilot-cli` **v1.0.82**（ご自身の `copilot` 実体、例: Homebrew の `/opt/homebrew/bin/copilot`; 検証は macOS arm64, Node SEA）
> 検証方法: `copilot --acp` を実際に起動し、JSON-RPC over stdio でハンドシェイク/プロンプト/
> 権限/`session/list` まで往復（`node` プロセスを spawn して手動かぶしプロトコル）

## 0. 結論（Verdict）

**可行。** 既存の `claude` / `pi` に完全に準拠した形で `copilot` backend が追加できる。
アーキテクチャ前提（`AgentProcess` 抽象 + `createProcess` 分岐 + パーサーを分離する）が
そのまま効く。**唯一の制約**は「per-action 対話的権限承認を ACP 経由で確実に取得できない」点。
既存の 3 つの permission モードは copilot が公開する *起動時* 権限系 フラグにきれいにマッピングでき、
iris の per-tool 許可/拒否ボタンは **宣言的ポリシー（`--allow-tool`/`--deny-tool`/`--excluded-tools`/`--available-tools`/
`--allowedUrls`）として起動時に渡す**方式に落ち着く。対話的ブロックボタンは「nice-to-have、第 2 弾」。

---

## 1. プロトコル（実測）

copilot は `--acp` で **Agent Client Protocol (ACP)** を stdio の JSON-RPC 2.0（1 行 1 メッセージ）で
提供する。`--log-level` / `--log-file` は ACP を汚さないため `--log-level error` で stderr ログを
無効化して使った（`--json` / `--output-format` は ACP と競合するため使わない）。

### 1.1 ハンドシェイク

```jsonc
// 1) initialize —— 最初に送る
=> {jsonrpc:'2.0', id:1, method:'initialize',
    params:{ protocolVersion: 1,            // ★ 数値。'1' だと -32600 "Invalid request"
            clientCapabilities:{},
            clientInfo:{ name:'iris', version:'0.1.0' } }}

// 2) session/new —— 対話開始 = Claude の init に相当
=> {id:2, method:'session/new',
    params:{ cwd:'<project>', mcpServers:[] }}
<= {id:2, result:{
     sessionId:'81d98227-...',             // ★ /resume のハンドル
     models:{...}, modes:{...},
     configOptions:{
       'agent-mode':{ current:'agent', options:['agent','plan','autopilot'] },
       'model':{ current:'claude-sonnet-5', options:[...] },
       'allow_all':{ current:'off', options:['on','off'] }
     }}}

// 3) session/prompt —— ユーザ入力。Claude の user.message に相当
=> {id:3, method:'session/prompt',
    params:{ sessionId:'<above>', prompt:[ { type:'text', text:'...ユーザー要求...' } ] }}
   // image: [{ type:'image', data:<base64>, mimeType:<mime> }]  // promptCapabilities.image=true
```

`agentCapabilities`（`initialize` の result）:
```json
{"loadSession":true,
 "mcpCapabilities":{"http":true,"sse":true},
 "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
 "sessionCapabilities":{"close":{},"list":{}}}
```

### 1.2 ストリーミング（agent → client）

`session/prompt` を投げると、`session/update` という **notification**（`id` なし）が連続で届く。
`update.sessionUpdate` フィールドで種類を区別する：

| copilot `sessionUpdate` | 用途 | iris `ParsedEvent` |
|---|---|---|
| `available_commands_update` | 利用可能な `/command` 一覧 | （無視） |
| `session_info_update` | セッション情報 | （無視 / 診断） |
| `config_option_update` | 現在の mode / model / allow_all | （無視 / 表示用） |
| `usage_update` | リクエスト数・所要時間 | `result`（usage 蓄積） |
| `agent_message_chunk` | **回答テキストのスレッド**（`{content:{type:'text', text}}`） | `text` |
| `tool_call` | **ツール呼び出し開始**（`{toolCallId, kind, title, rawInput, ...}`） | `tool_use` |
| `tool_call_update` | ツールの状態遷移 / 出力 | `tool_use`（status / text） |
| `end_turn` | ターン終了 | （`process close` 相当 → result 出力のトリガー） |

**`tool_call` の実例（`bash` ツール）**:
```json
{"sessionUpdate":"tool_call",
 "toolCallId":"call_e2936386d3ec4b1f816b0883",
 "kind":"execute",
 "title":"Bash",
 "rawInput":{"command":"curl -s https://1.1.1.1 2>&1 | tail -1"},
 "status":"pending"}
```
`tool_call_update` で `status` が `completed` になり `content`/出力が付く。
→ iris `parseEvent` の `tool_use` へ直接落とせる（`rawInput.command` → コマンド表示、`status` → 状態）。

### 1.3 権限プロンプト

> **実測: ACP（非対話ラン）では対話的権限要請は発火しなかった。**
> `allow_all=off` のまま `rm -rf <throwaway>` や `curl` を指示しても、server→client への
> 許可要請 JSON が出ず、copilot が **assisted-approval 判定で自律実行**（`dummy.txt` が消えた）。

copilot の権限モデル自体（`copilot help permissions` / `help config`）:
- `defaultPermissionMode`: `manual`（write/command 要請は確認、read は自動許可） /
  `assisted`（LLM 判定） / `allow-all`。
- **決定的制約**: "Any value is ignored on **resumed sessions, outside interactive runs**, and
  when `--allow-all`/`--yolo` already elevated the session." → **ACP のような非対話ランでは
  `manual`/`assisted` の確認は抑制され、自動実行になり得る**。

→ **iris への設計寄与**: 対話的ブロックボタン（Claude/Pi 同型）は copilot ACP では保証できない。
代わりに **起動時に渡す宣言的ポリシー**で制御する:

| copilot フラグ | 意味 |
|---|---|
| `--allow-all` / `--yolo` | 全許可（iris `auto`） |
| `--allow-tool kind(arg)` | 許可パターン（`shell(git:*)` / `write(path?)` / `<mcp>(tool?)` / `url(domain?)`） |
| `--deny-tool kind(arg)` | 拒否（allow より優先） |
| `--available-tools` / `--excluded-tools` | モデルに「見える」ツールのフィルタ |
| `--allowedUrls` | URL アクセスのホワイトリスト |
| `--no-exec` | ツール実行を無効化（read-only） |
| `--interactive` / `--interactive-mode` | 対話ランで確認を有効化 |

iris の `PermissionMode`（`manual`/`acceptEdits`/`auto`）→ 起動フラグへ：

| iris mode | copilot 起動オプション |
|---|---|
| `auto` | `--allow-all`（＝ `--yolo` 同等） |
| `acceptEdits` | `--allow-tool 'write(*)'` ＋ shell は既定（要確認/assisted） |
| `manual` | 既定 `defaultPermissionMode=manual`（ACP では対話を抑制され得る＝実質 semi-auto） |

### 1.4 セッション一覧（`/resume`）と close

- `session/list`（`sessionCapabilities.list` が `{}` を返す）→
  ```json
  {"sessions":[{"sessionId":"...","cwd":"<workdir>",
                "title":"...最初のプロンプト先頭...","updatedAt":"2026-09-04T03:50:46.730Z"}]}
  ```
  → **`/resume` を `copilot-sessions.ts` のファイルスキャンではなく、ACP の `session/list` で実装可能**
  （cwd でフィルタ → 番号付き一覧）。Claude/Pi と同じ `listClaudeSessions` 相当の API 名で差し替え。
- `session/close`（`sessionCapabilities.close`）→ /stop・kill 相当で明示的にセッションを閉じれる。

---

## 2. 実装計画（既存 backend と同型）

`ClaudeProcess` / `PiProcess` に倣い、**`src/backends/copilot.ts` ＋ `src/backends/copilot-protocol.ts`**
を追加。既存コードは最小差分。

```
src/
├─ agent.ts               # AgentProcess に copilot 側で足す必要はほぼなし（既存で足りる）
├─ backends/
│  ├─ copilot.ts          # CopilotProcess（spawn: copilot [--resume sid] --acp --log-level error）
│  └─ copilot-protocol.ts # parseEvent() —— session/update を ParsedEvent[] に変換（純関数）
└─ copilot-sessions.ts    # /resume —— session/list を叩いて一覧＋選択（ACP）
                          #  OR ~/.copilot/session-store.db を直接読む（SQLite, 次案）
```

`SessionConfig.createProcess`（`src/index.ts`）に 1 行追加：
```ts
if (p.agent === 'copilot') {
  const { CopilotProcess } = await import('./backends/copilot.ts');
  process = new CopilotProcess(p, onMessage);
}
```
`AgentKind` 連合型に `'copilot'` を追加（`src/config.ts`）。
`PermissionMode` は変更不要（上表のフラグ変換を `copilot.ts` 内に持たせる）。

### 2.1 プロンプト送付時の差異（重要）

- **claude**: 1 プロセス・継続 stdin 逐次 `write(userMessage)`。
- **pi**: 1 プロセス・`--mode rpc`・`prompt` リクエスト／`response` 完了通知。
- **copilot**: 継続プロセスだが、**プロンプトは `session/prompt` リクエスト 1 つ**で送る。
  つまり各 turn を 1 リクエスト 1 完了（id 付き response の `result`/`stopReason` で判定）で捌く。
  → `PiProcess` と最も近い。**`prompt` の解決を turn 完了（`end_turn`/`result`/`stopReason`）に紐づけ**、
  `onMessage('result', ...)` もそこで 1 回叩く。

### 2.2 resume

- `--resume <sid>` で対話継続。`/resume` は **ACP `session/list`** で一覧（1.4）。
- `session/new` の `sessionId` を `onMessage('result', sessionId, usage)` で保存（claude と同型）。
- 代替案: `~/.copilot/session-store.db`（SQLite, iris 内蔵 `better-sqlite3` で可）＋
  `~/.copilot/session-state/<sid>/`。ACP `session/list` が優先（DB スキーマ非公開を避ける）。

### 2.3 usage / `/stats`

copilot は **token 件数ではなく、`premiumRequests`/`totalApiDurationMs`/`sessionDurationMs`/
`codeChanges`/`requests` を使う**。iris の `UsageInfo`（`inputTokens`/`outputTokens`/`costUSD` ...）と非互換。
対応案:
- `ParsedEvent['result']` の `usage` を **copilot 値を保持する拡張形**にし、`/stats`/`/usage`/daily digest
  で backend ごとに整形。
- `UsageInfo` に `premiumRequests`/`apiDurationMs` 等の可選フィールドを足し、claude/pi 側は `undefined`。
  `costUSD` は copilot に相当が無いため 0/非表示。
- これは **唯一の型拡張ポイント**。`agent.ts` の `UsageInfo` を後方互換の可選フィールド追加で拡大。

### 2.4 kill / /stop / /mode / /model

- `/stop`: `proc.kill()`（SIGTERM/SIGKILL）＋ 必要なら `session/close`。
- `/mode`: `session/set_mode`（`modes` の agent/plan/autopilot）＋ `config_option_update` で反映。
- `/model`: `session/set_model`（`models`）。
- これらは claude/pi でも実装済みの `AgentProcess.on()` ハンドラで処理（既存ロジック流用）。copilot が
  ACP で `set_mode`/`set_model` をサポートする必要がある（未検証、下位リスク）。

---

## 3. リスク / 未検証項目

| # | 項目 | 状態 | 影響 |
|---|---|---|---|
| R1 | `--acp` のプロトコルは **非標準的な独自拡張**（`protocolVersion` は数値、`session/new` shape など）。copilot 更新で壊れうる | 実測で確定 | 破壊的変更監視。`copilot --version` でピン留め + smoke test |
| R2 | **対話的権限ブロックは ACP で発火しない**（1.3）。iris の per-tool 許可/拒否ボタンは宣言的ポリシーに縮退 | 実測 | 第 1 弾は「`--allow-tool`/`--deny-tool` 起動時ポリシー」で代替。対話的は第 2 弾 |
| R3 | usage スキーマ非互換（`UsageInfo` 拡張が必要） | 実測 | 型拡張＋`/stats` 別整形 |
| R4 | `session/set_mode`/`set_model`/`close` の shape 未検証 | 未検証 | `/mode` `/model` `/stop` に影響。実装時に実測 |
| R5 | 親プロセス kill 時に **孫プロセス（bash / MCP server）が残る**（detached な ACP） | 実測（probe 確認） | `kill -9 PID; pkill -P PID` を `copilot.ts` の `kill()`/終了処理で担保 |
| R6 | `~/.copilot/session-store.db` は SQLite（WAL）。直接読む案はスキーマ非公開リスク | 実測 | 優先は `session/list`（ACP）。DB 案は後回し |
| R7 | `protocolVersion` は **数値 `1`**。文字列 `"1"` だと初期化失敗 | 実測 | 固定で数値を送信 |

---

## 4. 実装の受け取り側差分（最小）

- `src/config.ts`: `AgentKind` に `'copilot'`、`copilotBin`（既定 `copilot`）追加。
- `src/index.ts`: `createProcess` に `copilot` 分岐（1 行）＋ `copilot-sessions.ts` 参照。
- `src/agent.ts`: `UsageInfo` に copilot 系可選フィールド追加（後方互換）。
- `src/backends/copilot.ts`, `src/backends/copilot-protocol.ts`, `src/copilot-sessions.ts` 新規。
- テスト: `copilot-protocol.ts` の単体（`session/update` 各種 → `ParsedEvent`）＋
  `session/list` の整形。e2e は手動（`copilot` 認証 + 課金プラン前提の非同期動作）。

---

## 5. 推奨 WBS（草案）

1. **`copilot` を `AgentKind` に追加**（`config.ts` 連合型＋`copilotBin`）／ビルド・lint 通す。
2. **`copilot-protocol.ts` パーサー**（`session/update` → `ParsedEvent[]`、`tool_call`/`end_turn`/`usage` 対応）＋単体テスト。
3. **`CopilotProcess`**（`copilot --resume? --acp --log-level error` spawn + `initialize`→`session/new`→`session/prompt`
   + 完了検出 + `kill()/on()` 実装、`agent.ts` `AgentProcess` 準拠、孫プロセス kill 対策）。
4. **`PermissionMode`→起動フラグ変換**（`auto`→`--allow-all`、`acceptEdits`→`--allow-tool write(*)` 等）。
5. **`UsageInfo` 拡張＋`/stats` `/usage` daily digest の backend 別整形**。
6. **`copilot-sessions.ts`（`/resume` via `session/list`）** ＋ `/resume` 配線。
7. **`session/set_mode`/`set_model`/`close`** の実測＋`/mode` `/model` `/stop` 配線（R4）。
8. **smoke test（`copilot --version`）＋ README/AGENTS 更新**（`pi` と同レベルの扱いにする）。

> SPEC と WBS（各 issue の粒度・acceptance）は別途起草。このノートは可行性＋プロトコル事実の根拠として残す。
