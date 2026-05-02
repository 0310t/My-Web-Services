import Anthropic, { toFile } from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const SYSTEM_PROMPT = `あなたは社内ナレッジを横断調査して回答するアドバイザリーアシスタントです。

【回答の手順】
1. まず /workspace/knowledge/ フォルダ内から、ユーザーの質問に関連するファイルを glob と grep で検索する
2. 関連ファイル(複数)を read で読み込み、必要な情報を収集する
3. /workspace/mappings/ に対応表があれば参照する(任意)
4. 複数の情報源を統合して、構造化された回答を作成する

【出力ガイドライン】
- 専門的だが平易な日本語で
- 800〜1500文字程度を目安に
- 必ず以下の Markdown 形式で出力する:

# <短い見出し>

## 結論
<2〜3文の要約>

## 詳細
<根拠と説明。箇条書き可>

## 参照したナレッジ
- <ファイル名>: <そこから得た要点>

知識ベースに該当情報がない場合は、その旨を正直に明記してから一般論を述べてください。`;

const KNOWLEDGE_DIR = path.join(process.cwd(), "data");
const MOUNT_PREFIX = "/workspace";

let cachedAgentId: string | undefined;
let cachedEnvironmentId: string | undefined;
let cachedResources: Array<{ type: "file"; file_id: string; mount_path: string }> | null = null;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

async function getOrCreateAgent(client: Anthropic): Promise<string> {
  if (cachedAgentId) return cachedAgentId;
  if (process.env.AGENT_ID) {
    cachedAgentId = process.env.AGENT_ID;
    return cachedAgentId;
  }
  const agent = await client.beta.agents.create({
    name: "Knowledge Explorer",
    model: "claude-sonnet-4-6",
    system: SYSTEM_PROMPT,
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true },
        configs: [
          { name: "web_search", enabled: false },
          { name: "web_fetch", enabled: false },
        ],
      },
    ],
  });
  cachedAgentId = agent.id;
  console.log(`[managed-agent] Created agent ${agent.id} — set AGENT_ID=${agent.id} in .env to reuse`);
  return cachedAgentId;
}

async function getOrCreateEnvironment(client: Anthropic): Promise<string> {
  if (cachedEnvironmentId) return cachedEnvironmentId;
  if (process.env.ENVIRONMENT_ID) {
    cachedEnvironmentId = process.env.ENVIRONMENT_ID;
    return cachedEnvironmentId;
  }
  const env = await client.beta.environments.create({
    name: "knowledge-explorer-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  cachedEnvironmentId = env.id;
  console.log(`[managed-agent] Created environment ${env.id} — set ENVIRONMENT_ID=${env.id} in .env to reuse`);
  return cachedEnvironmentId;
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile() && /\.(md|txt|json|csv|ya?ml)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function guessMime(filename: string): string {
  if (/\.md$/i.test(filename)) return "text/markdown";
  if (/\.txt$/i.test(filename)) return "text/plain";
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.csv$/i.test(filename)) return "text/csv";
  if (/\.ya?ml$/i.test(filename)) return "text/yaml";
  return "application/octet-stream";
}

async function getOrUploadKnowledgeResources(client: Anthropic) {
  if (cachedResources) return cachedResources;
  const files = listFilesRecursive(KNOWLEDGE_DIR);
  const resources: Array<{ type: "file"; file_id: string; mount_path: string }> = [];
  for (const filePath of files) {
    const relative = path.relative(KNOWLEDGE_DIR, filePath);
    const filename = path.basename(filePath);
    const file = await toFile(fs.createReadStream(filePath), filename, {
      type: guessMime(filename),
    });
    const uploaded = await client.beta.files.upload(
      { file },
      { headers: { "anthropic-beta": "files-api-2025-04-14" } },
    );
    resources.push({
      type: "file",
      file_id: uploaded.id,
      mount_path: `${MOUNT_PREFIX}/${relative.split(path.sep).join("/")}`,
    });
  }
  cachedResources = resources;
  return resources;
}

export type ProgressEvent =
  | { kind: "status"; message: string }
  | { kind: "tool"; tool: string; detail?: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "done"; finalText: string }
  | { kind: "error"; message: string };

export async function* generateContent(userInput: string): AsyncGenerator<ProgressEvent> {
  const client = getClient();

  yield { kind: "status", message: "ナレッジファイルをアップロード中..." };
  const resources = await getOrUploadKnowledgeResources(client);

  yield { kind: "status", message: "Agent / Environment を準備中..." };
  const [agentId, environmentId] = await Promise.all([
    getOrCreateAgent(client),
    getOrCreateEnvironment(client),
  ]);

  yield { kind: "status", message: "セッションを作成中..." };
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    title: userInput.slice(0, 80),
    resources,
  });

  yield { kind: "status", message: "セッション開始 — エージェントが探索を始めます" };

  const stream = await client.beta.sessions.stream(session.id);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: userInput }],
      },
    ],
  });

  let finalText = "";
  try {
    for await (const event of stream) {
      switch (event.type) {
        case "agent.message": {
          for (const block of event.content) {
            if (block.type === "text" && block.text) {
              finalText += block.text;
              yield { kind: "text", text: block.text };
            }
          }
          break;
        }
        case "agent.thinking": {
          // 4.6 may include summarized thinking; surface a hint only
          yield { kind: "thinking", text: "推論中..." };
          break;
        }
        case "agent.tool_use": {
          const toolName = (event as { tool_name?: string }).tool_name ?? "tool";
          let detail: string | undefined;
          const input = (event as { input?: unknown }).input;
          if (input && typeof input === "object") {
            const i = input as Record<string, unknown>;
            detail = (i.pattern as string) || (i.path as string) || (i.file_path as string);
          }
          yield { kind: "tool", tool: toolName, detail };
          break;
        }
        case "session.status_idle": {
          const stopReason = (event as { stop_reason?: { type?: string } }).stop_reason;
          if (stopReason?.type !== "requires_action") {
            yield { kind: "done", finalText };
            return;
          }
          break;
        }
        case "session.status_terminated": {
          yield { kind: "done", finalText };
          return;
        }
        case "session.error": {
          const message = (event as { error?: { message?: string } }).error?.message ?? "session error";
          yield { kind: "error", message };
          return;
        }
      }
    }
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  yield { kind: "done", finalText };
}
