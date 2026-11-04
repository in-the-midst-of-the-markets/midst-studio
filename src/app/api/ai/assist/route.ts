import { NextRequest, NextResponse } from "next/server";
import { fenceForPrompt } from "@/lib/ai/prompt-fence";
import { buildAssistMessages, parseAssistPlan, readAssistRequest, type AssistSource } from "@/lib/ai/assist-plan";
import { buildEditorMessages, readEditorSql } from "@/lib/ai/editor-prompt";
import { buildAssistReadingMessages, formatAssistResults, readAssistReading } from "@/lib/ai/assist-reading";
import {
  assistServerKeyConfigured,
  completeChat,
  listGatewayModels,
  listOpenRouterModels,
  resolveAssistKey,
  type AssistModelOption,
} from "@/lib/ai/assist-transport";
import { refreshOpenRouterRankings } from "@/lib/ai/openrouter-rankings";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";

/**
 * AI Assist. POST plans queries, then reads the rows and may add more charted
 * queries on as many as three follow-ups, then writes the final analysis. GET lists the public catalogs and the
 * saved OpenRouter domain rankings. The model key is the browser's, or OPENROUTER_API_KEY when the browser did not
 * send one for OpenRouter. The rankings are the public domain chart, copied once a day.
 */
export const dynamic = "force-dynamic";

function missingKeyMessage(source: AssistSource): string {
  if (source === "openrouter") {
    return "No OpenRouter key is available. Set OPENROUTER_API_KEY on the running app, or paste a key under Connectors.";
  }
  if (source === "fireworks") return "Add a Fireworks API key under Connectors.";
  return "Add a Vercel AI Gateway API key under Connectors.";
}

async function answerWith(
  source: AssistSource,
  apiKey: string,
  model: string,
  messages: { role: "system" | "user"; content: string }[],
  databaseType: string,
  schemaContext: string,
): Promise<NextResponse> {
  const key = resolveAssistKey(source, apiKey);
  if (key === null) return NextResponse.json({ error: missingKeyMessage(source) }, { status: 400 });
  const answer = await completeChat({ source, apiKey: key, model, messages });
  return NextResponse.json(parseAssistPlan(answer, databaseType, schemaContext));
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/ai/assist", bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body: unknown = await req.json();
    const record = body !== null && typeof body === "object" ? body : {};
    const posted = {
      apiKey: "apiKey" in record ? record.apiKey : undefined,
      databaseType: "databaseType" in record ? record.databaseType : undefined,
      history: "history" in record ? record.history : undefined,
      model: "model" in record ? record.model : undefined,
      question: "question" in record ? record.question : undefined,
      schemaContext: "schemaContext" in record ? record.schemaContext : undefined,
      source: "source" in record ? record.source : undefined,
      results: "results" in record ? record.results : undefined,
      pass: "pass" in record ? record.pass : undefined,
    };

    // A reading already has rows. They are fenced on their own, as the question is,
    // so a cell cannot be read as this route's instruction.
    if (body !== null && typeof body === "object" && "results" in body) {
      const reading = readAssistReading(posted);
      if (!reading.ok) return NextResponse.json({ error: reading.error }, { status: 400 });
      return await answerWith(
        reading.value.source,
        reading.value.apiKey,
        reading.value.model,
        buildAssistReadingMessages({
          pass: reading.value.pass,
          databaseType: reading.value.databaseType,
          questionBlock: fenceForPrompt(reading.value.question, "assist"),
          schemaBlock: fenceForPrompt(reading.value.schemaContext, "assist"),
          historyBlock: fenceForPrompt(JSON.stringify(reading.value.history), "assist"),
          resultsBlock: fenceForPrompt(formatAssistResults(reading.value.results), "assist"),
        }),
        reading.value.databaseType,
        reading.value.schemaContext,
      );
    }

    if ("editorSql" in record) {
      const editorSql = readEditorSql(record.editorSql);
      if (!editorSql.ok) return NextResponse.json({ error: editorSql.error }, { status: 400 });
      const editorRequest = readAssistRequest(posted);
      if (!editorRequest.ok) return NextResponse.json({ error: editorRequest.error }, { status: 400 });
      return await answerWith(
        editorRequest.value.source,
        editorRequest.value.apiKey,
        editorRequest.value.model,
        buildEditorMessages({
          databaseType: editorRequest.value.databaseType,
          questionBlock: fenceForPrompt(editorRequest.value.question, "assist"),
          schemaBlock: fenceForPrompt(editorRequest.value.schemaContext, "assist"),
          historyBlock: fenceForPrompt(JSON.stringify(editorRequest.value.history), "assist"),
          editorBlock: fenceForPrompt(editorSql.value, "assist"),
        }),
        editorRequest.value.databaseType,
        editorRequest.value.schemaContext,
      );
    }

    const request = readAssistRequest(posted);
    if (!request.ok) return NextResponse.json({ error: request.error }, { status: 400 });
    return await answerWith(
      request.value.source,
      request.value.apiKey,
      request.value.model,
      buildAssistMessages({
        databaseType: request.value.databaseType,
        questionBlock: fenceForPrompt(request.value.question, "assist"),
        schemaBlock: fenceForPrompt(request.value.schemaContext, "assist"),
        historyBlock: fenceForPrompt(JSON.stringify(request.value.history), "assist"),
      }),
      request.value.databaseType,
      request.value.schemaContext,
    );
  } catch (error) {
    return createErrorResponse(error, { route: "api/ai/assist" });
  }
}

export async function GET(req: NextRequest) {
  const guard = await guardRoute({ route: "GET /api/ai/assist", bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

  const rankingsPromise = refreshOpenRouterRankings();
  try {
    const models = await listOpenRouterModels();
    let gatewayModels: AssistModelOption[] = [];
    let gatewayCatalog = true;
    try {
      gatewayModels = await listGatewayModels();
    } catch {
      gatewayCatalog = false;
    }
    return NextResponse.json({
      models,
      gatewayModels,
      gatewayCatalog,
      serverKey: assistServerKeyConfigured(),
      rankings: await rankingsPromise,
    });
  } catch (error) {
    await rankingsPromise;
    return createErrorResponse(error, { route: "api/ai/assist" });
  }
}
