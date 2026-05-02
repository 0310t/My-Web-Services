# AI Knowledge Explorer

Claude Managed Agents を使い、`data/knowledge/` 配下の Markdown 群を自律的に探索・統合して回答を生成する Web サービス。

## アーキテクチャ

- **フレームワーク**: Next.js (App Router)
- **AI 実行**: Claude Managed Agents (`@anthropic-ai/sdk` の beta API)
- **エージェントツール**: `agent_toolset_20260401`(`bash` / `read` / `write` / `edit` / `glob` / `grep`)
- **データ保存**: SQLite (`better-sqlite3`、`data/history.db` に格納)
- **配信**: SSE (Server-Sent Events) でブラウザに進捗をストリーム

```
project/
├── src/
│   ├── app/
│   │   ├── page.tsx                # 入力フォーム + 進捗表示 + 履歴
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── api/generate/route.ts   # POST: SSE で生成 / GET: 履歴一覧
│   └── lib/
│       ├── managed-agent.ts        # Agent / Environment / Session 管理
│       └── db.ts                   # SQLite で履歴を保存
├── data/
│   ├── knowledge/                  # ナレッジ Markdown(エージェントが探索)
│   ├── mappings/                   # トピック対応表(任意)
│   └── history.db                  # 自動生成
└── package.json
```

## バックエンドの仕組み (`src/lib/managed-agent.ts`)

リクエスト処理は次の3ステップで行われる:

1. **Agent**(初回のみ作成) — system prompt と `agent_toolset_20260401` を持つ Sonnet 4.6 のエージェントを作成し、`agent.id` を `AGENT_ID` 環境変数に保存して以降は再利用。
2. **Environment**(初回のみ作成) — `cloud` + `unrestricted` 構成のサンドボックスを作成し、`environment.id` を `ENVIRONMENT_ID` 環境変数に保存して再利用。
3. **Session**(リクエストごと) — `data/knowledge/` と `data/mappings/` の各ファイルを Files API でアップロードし、`/workspace/...` にマウントしたセッションを開始。`user.message` で質問を送り、`agent.message` を SSE で逐次配信、`session.status_idle` 到達で完了。

> ナレッジファイルのアップロードはプロセス内でキャッシュしており、同一プロセス内の2回目以降のリクエストでは再アップロードしない。
> 知識ベースを更新したら、サーバを再起動すること(あるいは `cachedResources` のキャッシュを無効化する仕組みを追加すること)。

## API

### `POST /api/generate`
- リクエスト: `{ "input": "質問文" }`
- レスポンス: `text/event-stream`(SSE)。`data:` 行に JSON で進捗イベントを配信。
- 完了時に SQLite に `(input, output, created_at)` を保存。

イベント種別:
| `kind` | 用途 |
|-------|-----|
| `status` | 「ファイルを検索中...」などのテキスト進捗 |
| `tool` | エージェントが使ったツール名 + 引数のサマリ |
| `text` | 最終回答のチャンク(逐次表示) |
| `done` | 完了通知(`finalText` 同梱) |
| `error` | エラー |

### `GET /api/generate`
直近30件の生成履歴を JSON で返す。

## セットアップ

```bash
npm install
cp .env.example .env
# .env に ANTHROPIC_API_KEY を設定
npm run dev
```

初回リクエスト時にコンソールに `Created agent agent_...` / `Created environment env_...` が表示されるので、その値を `.env` に追記して以降は再利用すると速い。

```env
ANTHROPIC_API_KEY=sk-ant-...
AGENT_ID=agent_xxxxxxxx
ENVIRONMENT_ID=env_xxxxxxxx
```

## Vercel デプロイ

```bash
vercel
```

Vercel ダッシュボードで `ANTHROPIC_API_KEY` / `AGENT_ID` / `ENVIRONMENT_ID` を環境変数に設定する。

注意点:
- SQLite ファイル(`data/history.db`)は Vercel のサーバレス環境では永続化されない。本番では Vercel Postgres / Turso / Neon 等の外部 DB に切り替えること(`src/lib/db.ts` を差し替え)。
- `data/knowledge/` 配下のファイルは `next.config.ts` の `outputFileTracingIncludes` でビルドに含めるよう指定済み。
- `maxDuration = 300` を指定済み(Hobby プランの上限は60秒なので、長めの探索を行う場合は Pro 以上にアップグレードが必要)。

## カスタマイズ

サービス目的を変更する場合は `src/lib/managed-agent.ts` の `SYSTEM_PROMPT` を書き換えて Agent を再作成(`AGENT_ID` を `.env` から削除して起動)する。例えば次の用途に切り替え可能:

- 自社専門知識をもとにしたアドバイザリーBot
- 規程・議事録・マニュアルを横断調査する Deep Research Bot
- キャラクター設定 × ナレッジで生成するコンテンツジェネレータ
