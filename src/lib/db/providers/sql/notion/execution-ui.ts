import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";
import type { ExecutionUiSpec } from "@/lib/db/execution-ui/types";

/** `notion`: the rolled-back notice names `COMMIT`, and the consent card has no deadline chip. */
export const NOTION_EXECUTION_UI: ExecutionUiSpec = {
  commitKeyword: SQL_COMMIT_KEYWORD,
  consentDeadline: null,
};
