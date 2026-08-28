# CLAUDE.md

Iris リポジトリで Claude Code を使うときのガイド。

## 1. 規約の参照

- プロジェクト概要・設計・通信プロトコル・安全方針・品質ゲート: **`AGENTS.md`**（リポジトリ根）

> **まず `AGENTS.md` を読み込み、`AGENTS.md` の指示に従うこと。**
> 本ファイルには Claude Code 固有の注意事項のみを記す。

## 2. 品質基準

| 項目 | 基準 |
|---|---|
| Biome check | lint + format 統合 (`pnpm check`) |
| Vitest | `src/**/*.test.ts`、純粋関数中心 |
| lefthook | pre-commit: format + lint / pre-push: verify |

コマンド一覧・詳細は **`AGENTS.md`** の「ビルド・テスト・lint」を参照。
実装後のチェック順序: `pnpm verify`

## 3. 既知の流儀・ハマり所

- `@slack/bolt` v4 は CommonJS で named export → `import * as bolt` で取る。
- `KnownBlock` 型は `import type {types} from '@slack/bolt'` の `types.KnownBlock` から取る（`@slack/types` は推移的依存なので直接 import しない）。
- Bolt のリスナーは戻り値が `Promise<void>` 必須 → ハンドラは `async` を維持する。Biome には `require-await` 相当のルールはないため、非同期ハンドラに `await` が無くても無視してよい（元 ESLint 設定の `require-await: off` を継承）。
- `claude.ts` を spawn する際は `--output-format stream-json --input-format stream-json --permission-prompt-tool stdio` を必ず付ける。

## 4. 注意事項

- **commit / push はしない**: orchestrator が担当
- **config ファイルの無断変更は禁物**: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`
- **パッケージマネージャ**: `pnpm`（npm / yarn 禁止）
