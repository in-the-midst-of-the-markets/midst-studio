import { NextRequest, NextResponse } from "next/server";
import { fenceForPrompt } from "@/lib/ai/prompt-fence";
import { buildAssistMessages, parseAssistPlan, readAssistRequest, type AssistSource } from "@/lib/ai/assist-plan";
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
 * AI Assist. POST asks the chosen OpenRouter, Fireworks, or Vercel AI Gateway
 * model for queries and charts. GET lists the public catalogs. The model key is
 * the browser's, or OPENROUTER_API_KEY when the browser did not send one for OpenRouter.
 */
export const dynamic = "force-dynamic";

function missingKeyMessage(source: AssistSource): string {
  if (source === "openrouter") {
    return "No OpenRouter key is available. Set OPENROUTER_API_KEY on the running app, or paste a key under Model.";
  }
  if (source === "fireworks") return "Add a Fireworks API key under Model.";
  return "Add a Vercel AI Gateway API key under Model.";
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/ai/assist", bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

  try {
    const { apiKey, databaseType, history, model, question, schemaContext, source } = await req.json();
    const request = readAssistRequest({ apiKey, databaseType, history, model, question, schemaContext, source });
    if (!request.ok) return NextResponse.json({ error: request.error }, { status: 400 });

    const key = resolveAssistKey(request.value.source, request.value.apiKey);
    if (key === null) {
      return NextResponse.json({ error: missingKeyMessage(request.value.source) }, { status: 400 });
    }

    // The question, the schema and the earlier turns are data. Each is fenced on its
    // own so a table name or a previous answer cannot be read as this route's instruction.
    const messages = buildAssistMessages({
      databaseType: request.value.databaseType,
      questionBlock: fenceForPrompt(request.value.question, "assist"),
      schemaBlock: fenceForPrompt(request.value.schemaContext, "assist"),
      historyBlock: fenceForPrompt(JSON.stringify(request.value.history), "assist"),
    });
    const answer = await completeChat({
      source: request.value.source,
      apiKey: key,
      model: request.value.model,
      messages,
    });
    return NextResponse.json(parseAssistPlan(answer));
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
