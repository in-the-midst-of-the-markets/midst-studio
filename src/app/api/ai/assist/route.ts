import { NextRequest, NextResponse } from "next/server";
import { fenceForPrompt } from "@/lib/ai/prompt-fence";
import { buildAssistMessages, parseAssistPlan, readAssistRequest } from "@/lib/ai/assist-plan";
import { completeChat, listOpenRouterModels, resolveAssistKey } from "@/lib/ai/assist-transport";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";

/**
 * AI Assist. POST asks the chosen OpenRouter or Fireworks model for queries and
 * charts. GET lists the public OpenRouter catalog. The model key is the browser's,
 * or OPENROUTER_API_KEY when the browser did not send one.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/ai/assist", bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

  try {
    const { apiKey, databaseType, history, model, question, schemaContext, source } = await req.json();
    const request = readAssistRequest({ apiKey, databaseType, history, model, question, schemaContext, source });
    if (!request.ok) return NextResponse.json({ error: request.error }, { status: 400 });

    const key = resolveAssistKey(request.value.source, request.value.apiKey);
    if (key === null) return NextResponse.json({ error: "Add an API key for this model." }, { status: 400 });

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
    return NextResponse.json({ models });
  } catch (error) {
    return createErrorResponse(error, { route: "api/ai/assist" });
  }
}
