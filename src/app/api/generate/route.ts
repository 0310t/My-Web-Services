import { NextRequest } from "next/server";
import { generateContent, type ProgressEvent } from "@/lib/managed-agent";
import { saveGeneration, listGenerations } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET() {
  const items = listGenerations(30);
  return Response.json({ items });
}

export async function POST(req: NextRequest) {
  const { input } = (await req.json()) as { input?: string };
  if (!input || typeof input !== "string" || !input.trim()) {
    return Response.json({ error: "input is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ProgressEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        let finalText = "";
        for await (const event of generateContent(input)) {
          if (event.kind === "done") finalText = event.finalText;
          send(event);
        }
        if (finalText.trim().length > 0) {
          const id = saveGeneration(input, finalText);
          send({ kind: "status", message: `保存しました (id=${id})` });
        }
      } catch (err) {
        send({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
