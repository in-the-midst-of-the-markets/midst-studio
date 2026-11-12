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
  featureInstructions,
  renderAnalysisGuide,
} from "@/lib/analysis/features";
import { CHART_CLICK_INSTRUCTIONS } from "@/lib/dashboards/chart-click";
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
    expect(ANALYSIS_FEATURE_GUIDE).toContain("Each limit says where it runs.");
  });

  test("every prompt includes the chart click and the analysis catalog", () => {
    expect(assistAnalysisGuide("duckdb")).toBe(ANALYSIS_FEATURE_GUIDE);
    expect(assistAnalysisGuide("postgres")).toBe("");
    expect(assistAnalysisGuide("")).toBe("");
    expect(assistAnalysisGuide("not-an-engine")).toBe("");
    const told = `rule\n\n${featureInstructions()}`;
    expect(withAnalysisGuide("postgres", "rule")).toBe(told);
    expect(withAnalysisGuide("duckdb", "rule")).toBe(told);
    expect(withAnalysisGuide("", "rule")).toBe(told);
    expect(featureInstructions()).toContain(CHART_CLICK_INSTRUCTIONS);
    expect(featureInstructions()).toContain(ANALYSIS_FEATURE_GUIDE);
  });

  test("the editor, assist, and dashboard prompts include both instruction sets", () => {
    const editor = buildEditorMessages({ ...EMPTY, editorBlock: "", databaseType: "duckdb" });
    const assist = buildAssistMessages({ ...EMPTY, databaseType: "duckdb" });
    const dashboard = buildDashboardMessages({ ...EMPTY, boardBlock: "", databaseType: "duckdb" });
    const postgres = buildEditorMessages({ ...EMPTY, editorBlock: "", databaseType: "postgres" });
    for (const messages of [editor, assist, dashboard, postgres]) {
      expect(messages[0]?.content).toContain(CHART_CLICK_INSTRUCTIONS);
      expect(messages[0]?.content).toContain(ANALYSIS_FEATURE_GUIDE);
    }
    expect(dashboard[0]?.content).toContain("A line that starts with click is the filter that chart publishes.");
  });

  test("the written document carries every feature the prompt does", () => {
    expect(DOC).toContain(ANALYSIS_FEATURES_TITLE);
    expect(DOC).toContain("analysisFeaturesDocument()");
    expect(DOC).toContain("MCP does not serve this catalog.");
    expect(DOC).toContain(CHART_CLICK_INSTRUCTIONS);
    expect(DOC).toContain("featureInstructions()");
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
