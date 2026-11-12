/**
 * The analysis catalog the IDE chat receives, and the document that restates it.
 *
 * MCP does not serve this list. The document and the prompt both have to carry every
 * feature, so a later resource can return the same object without a second copy of the
 * sentences.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ANALYSIS_FEATURE_GUIDE,
  ANALYSIS_FEATURES,
  ANALYSIS_FEATURES_TITLE,
  analysisFeaturesDocument,
  renderAnalysisGuide,
} from "@/lib/analysis/features";
import { assistAnalysisGuide, withAnalysisGuide } from "@/lib/ai/assist-dialect";
import { buildAssistMessages } from "@/lib/ai/assist-plan";
import { buildDashboardMessages } from "@/lib/ai/dashboard-prompt";
import { buildEditorMessages } from "@/lib/ai/editor-prompt";

const DOC = readFileSync(path.join(import.meta.dir, "../../../docs/ANALYSIS.md"), "utf8");

const EMPTY = {
  questionBlock: "",
  schemaBlock: "",
  historyBlock: "",
};

describe("analysis features", () => {
  test("the document returns the catalog and an empty guide is blank", () => {
    const document = analysisFeaturesDocument();
    expect(document.title).toBe(ANALYSIS_FEATURES_TITLE);
    expect(document.features).toBe(ANALYSIS_FEATURES);
    expect(new Set(ANALYSIS_FEATURES.map((feature) => feature.id)).size).toBe(ANALYSIS_FEATURES.length);
    expect(renderAnalysisGuide([])).toBe("");
    expect(ANALYSIS_FEATURE_GUIDE).toContain("Analysis features you can use on this engine.");
  });

  test("DuckDB receives the catalog and other engines do not", () => {
    expect(assistAnalysisGuide("duckdb")).toBe(ANALYSIS_FEATURE_GUIDE);
    expect(assistAnalysisGuide("postgres")).toBe("");
    expect(assistAnalysisGuide("")).toBe("");
    expect(assistAnalysisGuide("not-an-engine")).toBe("");
    expect(withAnalysisGuide("postgres", "rule")).toBe("rule");
    expect(withAnalysisGuide("duckdb", "rule")).toBe(`rule\n\n${ANALYSIS_FEATURE_GUIDE}`);
  });

  test("the editor, assist, and dashboard prompts include the catalog for DuckDB only", () => {
    const editor = buildEditorMessages({ ...EMPTY, editorBlock: "", databaseType: "duckdb" });
    const assist = buildAssistMessages({ ...EMPTY, databaseType: "duckdb" });
    const dashboard = buildDashboardMessages({ ...EMPTY, boardBlock: "", databaseType: "duckdb" });
    for (const messages of [editor, assist, dashboard]) {
      expect(messages[0]?.content).toContain(ANALYSIS_FEATURE_GUIDE);
    }
    const postgres = buildEditorMessages({ ...EMPTY, editorBlock: "", databaseType: "postgres" });
    expect(postgres[0]?.content).not.toContain("vector-rank");
  });

  test("the written document carries every feature the prompt does", () => {
    expect(DOC).toContain(ANALYSIS_FEATURES_TITLE);
    expect(DOC).toContain("analysisFeaturesDocument()");
    expect(DOC).toContain("MCP does not serve this catalog.");
    for (const feature of ANALYSIS_FEATURES) {
      expect(DOC).toContain(`## ${feature.id}`);
      expect(DOC).toContain(feature.title);
      expect(DOC).toContain(feature.useWhen);
      expect(DOC).toContain(feature.statement);
      expect(DOC).toContain(feature.limit);
      expect(ANALYSIS_FEATURE_GUIDE).toContain(feature.id);
      expect(ANALYSIS_FEATURE_GUIDE).toContain(feature.statement);
    }
  });
});
