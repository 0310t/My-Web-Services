"use client";

import { useEffect, useRef, useState } from "react";

interface HistoryItem {
  id: number;
  input: string;
  output: string;
  created_at: number;
}

interface ProgressLine {
  id: string;
  text: string;
}

const TOOL_LABELS: Record<string, string> = {
  glob: "ファイルを検索中",
  grep: "本文を grep 中",
  read: "ファイルを読み込み中",
  bash: "コマンドを実行中",
  write: "ファイルを書き込み中",
  edit: "ファイルを編集中",
};

export default function Page() {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [output, setOutput] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshHistory();
  }, []);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [output]);

  async function refreshHistory() {
    try {
      const res = await fetch("/api/generate");
      const data = (await res.json()) as { items: HistoryItem[] };
      setHistory(data.items);
    } catch {
      // ignore
    }
  }

  function pushProgress(text: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setProgress((prev) => [...prev, { id, text }]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || running) return;

    setRunning(true);
    setProgress([]);
    setOutput("");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        pushProgress(`エラー: ${text || res.statusText}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(6));
            handleEvent(event);
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      pushProgress(`通信エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      void refreshHistory();
    }
  }

  function handleEvent(event: {
    kind: string;
    message?: string;
    text?: string;
    tool?: string;
    detail?: string;
    finalText?: string;
  }) {
    switch (event.kind) {
      case "status":
        if (event.message) pushProgress(`▸ ${event.message}`);
        break;
      case "tool": {
        const label = (event.tool && TOOL_LABELS[event.tool]) || `ツール ${event.tool} を実行中`;
        const detail = event.detail ? ` (${event.detail})` : "";
        pushProgress(`🔧 ${label}${detail}`);
        break;
      }
      case "thinking":
        pushProgress("💭 推論中...");
        break;
      case "text":
        if (event.text) setOutput((prev) => prev + event.text);
        break;
      case "done":
        pushProgress("✅ 完了");
        break;
      case "error":
        pushProgress(`❌ ${event.message ?? "error"}`);
        break;
    }
  }

  return (
    <main
      style={{
        maxWidth: 980,
        margin: "0 auto",
        padding: "32px 24px",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        AI Knowledge Explorer
      </h1>
      <p style={{ color: "#52525b", marginTop: 0, marginBottom: 24 }}>
        ナレッジベース（<code>data/knowledge/</code>）を横断調査して回答を生成します。
      </p>

      <form onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="質問・トピックを入力（例: 価格改定のポリシーを教えて）"
          rows={3}
          disabled={running}
          style={{
            width: "100%",
            padding: 12,
            fontSize: 15,
            borderRadius: 8,
            border: "1px solid #d4d4d8",
            background: "#fff",
            resize: "vertical",
          }}
        />
        <button
          type="submit"
          disabled={running || !input.trim()}
          style={{
            marginTop: 12,
            padding: "10px 20px",
            fontSize: 15,
            fontWeight: 600,
            color: "#fff",
            background: running ? "#a1a1aa" : "#4f46e5",
            border: "none",
            borderRadius: 8,
            cursor: running ? "not-allowed" : "pointer",
          }}
        >
          {running ? "生成中..." : "生成する"}
        </button>
      </form>

      {(progress.length > 0 || output) && (
        <section style={{ marginBottom: 32 }}>
          {progress.length > 0 && (
            <div
              style={{
                background: "#18181b",
                color: "#e4e4e7",
                padding: 16,
                borderRadius: 8,
                fontSize: 13,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                marginBottom: 16,
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {progress.map((p) => (
                <div key={p.id}>{p.text}</div>
              ))}
            </div>
          )}
          {output && (
            <div
              ref={outputRef}
              style={{
                background: "#fff",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                padding: 20,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 600,
                overflowY: "auto",
              }}
            >
              {output}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>履歴</h2>
        {history.length === 0 ? (
          <p style={{ color: "#71717a" }}>まだ履歴はありません。</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {history.map((h) => (
              <li
                key={h.id}
                style={{
                  background: "#fff",
                  border: "1px solid #e4e4e7",
                  borderRadius: 8,
                  padding: 16,
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 12, color: "#71717a", marginBottom: 6 }}>
                  #{h.id} · {new Date(h.created_at).toLocaleString("ja-JP")}
                </div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{h.input}</div>
                <details>
                  <summary style={{ cursor: "pointer", color: "#4f46e5" }}>
                    回答を表示
                  </summary>
                  <div
                    style={{
                      marginTop: 8,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontSize: 14,
                    }}
                  >
                    {h.output}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
