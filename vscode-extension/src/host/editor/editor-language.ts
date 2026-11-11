// The VS Code language id of a query editor (part 3, "Language id per engine").
import type { EditorLanguage } from "@/lib/editor/tab-language";

/** The language ids a KnowSQL query editor opens in: VS Code ships sql and json, and nothing for KnowSQL's consoles. */
export type VsCodeLanguage = "sql" | "json" | "plaintext";

/**
 * sql to sql, json to json, any other KnowSQL editor language to plaintext; keyed by language ids, never type ids.
 * Two comparisons rather than a table keyed by EditorLanguage, whose members include ids spelled like engine type ids,
 * which tests/unit/lib/no-engine-branches.test.ts would read as an engine branch.
 */
export function vscodeLanguageOf(editorLanguage: EditorLanguage): VsCodeLanguage {
  return editorLanguage === "sql" || editorLanguage === "json" ? editorLanguage : "plaintext";
}
