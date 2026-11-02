import { NextRequest, NextResponse } from "next/server";
import { fenceForPrompt } from "@/lib/ai/prompt-fence";
import { buildAssistMessages, parseAssistPlan, readAssistRequest, type AssistSource } from "@/lib/ai/assist-plan";
import { buildAssistReadingMessages, formatAssistResults, readAssistReading } from "@/lib/ai/assist-reading";
import {
  assistServerKeyConfigured,
  completeChat,
  listGatewayModels,
  listOpenRouterModels,
  resolveAssistKey,
  type AssistModelOption,
} from "@/lib/ai/assist-transport";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";

/**
 * AI Assist. POST plans queries, then reads the rows and may add one charted
 * query, then writes the final analysis. GET lists the public catalogs. The model key is the browser's,
 * or OPENROUTER_API_KEY when the browser did not send one for OpenRouter.
 */
export const dynamic = "force-dynamic";

function missingKeyMessage(source: AssistSource): string {
  if (source === "openrouter") {
    return "No OpenRouter key is available. Set OPENROUTER_API_KEY on the running app, or paste a key under Model.";
  }
  if (source === "fireworks") return "Add a Fireworks API key under Model.";
  return "Add a Vercel AI Gateway API key under Model.";
}

async function answerWith(
  source: AssistSource,
  apiKey: string,
  model: string,
  messages: { role: "system" | "user"; content: string }[],
): Promise<NextResponse> {
  const key = resolveAssistKey(source, apiKey);
  if (key === null) return NextResponse.json({ error: missingKeyMessage(source) }, { status: 400 });
  const answer = await completeChat({ source, apiKey: key, model, messages });
  return NextResponse.json(parseAssistPlan(answer));
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
    );
  } catch (error) {
    return createErrorResponse(error, { route: "api/ai/assist" });
  }
}

export async function GET(req: NextRequest) {
  const guard = await guardRoute({ route: "GET /api/ai/assist", bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

  try {
    const models = await listOpenRouterModels();
    let gatewayModels: AssistModelOption[] = [];
    let gatewayCatalog = true;
    try {
      gatewayModels = await listGatewayModels();
    } catch {
      gatewayCatalog = false;
    }
    return NextResponse.json({ models, gatewayModels, gatewayCatalog, serverKey: assistServerKeyConfigured() });
  } catch (error) {
    return createErrorResponse(error, { route: "api/ai/assist" });
  }
}
