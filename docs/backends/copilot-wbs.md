# WBS: Copilot CLI backend 追加

- **対応 SPEC**: [`../specs/copilot-backend.md`](../specs/copilot-backend.md)
- **詳細設計**: [`copilot-backend.md`](copilot-backend.md)
- **対象 repo**: `iris-oss`（public, 機密なし）
- **粒度**: 各 issue は 1 コミット単位で merge 可能。`P0` は他 task に依存しない基盤。

---

## 依存関係（要約）

```
WBS-1 (AgentKind) ─→ WBS-2 (CopilotProcess スケルトン) ─→ WBS-4 (パーサー完了)
        └→ WBS-3 (UsageInfo 拡張) ─→ WBS-6 (/stats 整形)
WBS-2 ─→ WBS-5 (権限フラグ変換)
WBS-2 ─→ WBS-7 (/resume: session/list)
WBS-2 ─→ WBS-8 (kill/on/孫プロセス)
WBS-9 (smoke + 文書) を最後に
```

---

## WBS-1：`AgentKind` に `copilot` を追加（基盤, P0）

- **対象ファイル**: `src/config.ts`
- **内容**: `AgentKind` 連合型に `'copilot'` 追加。`copilotBin`（既定 `copilot`、環境変数
   `COPILOT_BIN` で上書き可能）追加。既存 2 backend の挙動は不変。
- **テスト**: `config` の読込・既定値テストに `copilot` 系の期待を追加。
- **受け入れ**: `cargo`/`pnpm build` + `pnpm typecheck` + lint が緑。`claude`/`pi` 動作不変。
- **依存**: なし。

## WBS-2：`CopilotProcess` スケルトン（ACP ハンドシェイク＋per-turn prompt）

- **対象ファイル**: `src/backends/copilot.ts`（新規）, `src/index.ts`（分岐 1 行）
- **内容**:
   - `spawn('copilot', ['--acp','--log-level error', ...(resume ? ['--resume', sid] : []), ...権限フラグ], {cwd,stdio})`。
   - 起動時 1 回：`initialize{protocolVersion:1, clientCapabilities:{}, clientInfo:{name:'iris',version}}`
     → `session/new{cwd,mcpServers:[]}` → `result.sessionId` を保持し `onMessage('init',...)`。
   - `onMessage(userText)` → `session/prompt{sessionId, prompt:[{type:'text',text:userText}]}` を **1 つ**送信。
     turn 完了（`end_turn` or 完了通知 `stopReason`）で `onMessage('result', sid, usage)` を 1 回。
   - 各 `session/update` notification を WBS-4 のパースに入力。
- **テスト**: 起動ハンドシェイクは `copilot` 実体が必要のため**手動 e2e**。実体なしモックは `PiProcess`
   の e2e と同様スキップ、または `--help` 的な軽い検証に留める。
- **受け入れ**: `agent="copilot"` で起動して handshake まで到達し、`result` を 1 回 emit。
- **依存**: WBS-1。

## WBS-3：`UsageInfo` 拡張（copilot 系, 後方互換）

- **対象ファイル**: `src/agent.ts`（`UsageInfo`）, 呼び出し元必要最小限
- **内容**: `UsageInfo` に可選 `premiumRequests`, `apiDurationMs`, `sessionDurationMs`, `codeChanges`
  を追加。`costUSD` は copilot では `0`。既存 `inputTokens`/`outputTokens`/`costUSD` は不変。
- **テスト**: 既存 usage 整形のテストが任意のフィールド `undefined` で維持。
- **受け入れ**: `pnpm build` 緑、既存 `UsageInfo` 消費者が壊れない。
- **依存**: なし（WBS-1 と並行可能）。

## WBS-4：`copilot-protocol.ts` パーサー＋単体テスト

- **対象ファイル**: `src/backends/copilot-protocol.ts`（新規）, テスト
- **内容**:
   - `parseEvent(raw, state): ParsedEvent[]`（純関数）。`session/update` の `update.sessionUpdate`
     を分岐：`agent_message_chunk`→`text`、`tool_call`/`tool_call_update`→`tool_use`（状態保持）、
     `end_turn`→完了、`usage_update` → `result`（usage 蓄積）。
   - **固定サンプル**：実測 JSONL（`agent_message_chunk`, `tool_call`/`tool_call_update` の
     `rawInput.command`, `end_turn`, `usage_update`）をテスト用 fixture 化。**実機 fixture は機密なし**。
- **テスト**: 各 fixture ごとに `ParsedEvent[]` の期待値を照合（最重要）。
- **受け入れ**: 全 fixture 緑、既存 backend のパーサと干渉しない。
- **依存**: WBS-2（shape 確定のため並走可だがパース完了は WBS-4）。

## WBS-5：権限モード → 起動フラグ変換

- **対象ファイル**: `src/backends/copilot.ts`（`permissionFlags(mode)` 関数を導入）
- **内容**:

    | `PermissionMode` | 付与フラグ |
    |---|---|
    | `auto` | `--allow-all` |
    | `acceptEdits` | `--allow-tool 'write(*)'` |
    | `manual` | （既定、ACP では semi-auto） |

  `--deny-tool`/`--allow-tool` の allowlist は `config.toml` から任意で受け付ける（後方互換）。
- **テスト**: フラグ生成の純関数テスト。
- **受け入れ**: 3 mode で期待フラグが付く。`auto` で確実に自動実行。
- **依存**: WBS-2。

## WBS-6：`/stats`・`/usage`・daily digest の backend 別整形

- **対象ファイル**: `src/stats.ts`（usage 集計部分）, `src/daily.ts`, `src/messages.ts` 必要最低限
- **内容**: copilot の `premiumRequests`/`apiDurationMs`/`codeChanges` を整形。token 系は copilot では
  非表示/0。`claude`/`pi` は既存整形を維持。
- **テスト**: copilot usage 整形の追加テスト。
- **受け入れ**: `/stats` が copilot 時に件数/所要時間/変更数を表示。既存 backend の表示不変。
- **依存**: WBS-3。

## WBS-7：`copilot-sessions.ts`（`/resume` via `session/list`）

- **対象ファイル**: `src/copilot-sessions.ts`（新規）, `src/commands.ts`（`/resume` の select を
  `agent` 別に追加）
- **内容**: ACP を一時起動 → `initialize`→`session/list{cwd:<project>}` →
    `{sessionId,title,updatedAt}` を古い順。既存 `listClaudeSessions` と等価なシグネチャ。
   `agent="copilot"` の `/resume` で選択→`--resume <sid>` 継続。
- **テスト**: `session/list` response をモックし整形を検証。
- **受け入れ**: `agent="copilot"` で `/resume` が一覧＋継続。`claude`/`pi` の `/resume` 不変。
- **依存**: WBS-2。

## WBS-8：`kill()` / `on()` / 孫プロセス回収（`/stop`, `/model`, `/mode`）

- **対象ファイル**: `src/backends/copilot.ts`
- **内容**:
   - `kill()`：SIGTERM→(遅延)SIGKILL ＋ `pkill -P <pid>` で孫プロセス（bash/MCP server）を回収
     （設計ノート §R1、実測で孫プロセスの遺留を確認済み）。
   - `on('stop')` → `kill()`。`on('model')`/`on('mode')` → `session/set_model`/`session/set_mode`
     （**実測で shape 確定**、設計ノート §R4）。
   - `/stop` で明示 `session/close` を送信（実測で有効なら）。
- **テスト**: `kill` 後は孫プロセスが残っていないことを検証（`pkill -P` の確認は手動 or 軽い e2e）。
- **受け入れ**: `/stop` で copilot とその孫が全消。`--no-exec`/`manual`/`auto` で孫が溜まらない。
- **依存**: WBS-2。

## WBS-9：smoke、文書同期、CI ゲート

- **対象ファイル**: `scripts/`, `docs/backends/copilot-backend.md`, `docs/specs/copilot-backend.md`,
  `docs/backends/copilot-wbs.md`（本ファイル）, `README.md` 必要最小限
- **内容**:
   - `copilot --version` を smoke（失敗時は `config` の「有効 backend」から除外）。
   - SPEC／本 WBS／詳細設計ノートを同期。**public リポジトリのため機密スキャン**
      （機密トークン/secret/鍵文字列のスキャンが CI で 0 hit であることを確認）。
   - `pnpm build`、`pnpm typecheck`、lint、`cargo fmt --check`（無関係だが gate として）。
- **受け入れ**: 全ゲート緑。文書の同期。機密スキャンが 0 hit。
- **依存**: WBS-1〜8。

---

## 実装順（推奨）

1. **WBS-1**（基盤, P0）
2. **WBS-2**（`CopilotProcess` スケルトン、実測で `session/set_mode`/`set_model` の shape 確定）
3. **WBS-3**（`UsageInfo` 拡張、WBS-1 と並行可）
4. **WBS-4**（パーサー＋fixture 単体テスト、最重要）
5. **WBS-5**（権限フラグ）
6. **WBS-6**（stats 整形、WBS-3 後）
7. **WBS-7**（`session/list` の `/resume`）
8. **WBS-8**（kill/on/孫プロセス）
9. **WBS-9**（smoke + 文書 + 機密スキャン）

各タスクは **1 issue = 1 PR** の粒度で、`P0`→`P1` の順で進める。
各 issue 起票先：`iris-oss` の GitHub issues（`gh issue create`）or 本 WBS の各項目を issue に変換。
