import { describe, expect, test } from "bun:test";
import { isReadOnlySql } from "@/lib/ai/assist-readonly";

describe("isReadOnlySql", () => {
  test.each([
    ["SELECT 1", true],
    ["  select 1;  ", true],
    ["SELECT 1; -- done", true],
    ["SELECT ';' ", true],
    ["SELECT 1 /* ; */", true],
    ["SELECT 1 -- ;\n", true],
    ["-- note\nSELECT 1", true],
    ["SELECT 'for update'", true],
    ['SELECT "into" FROM t', true],
    ["SELECT information FROM t", true],
    ["TABLE orders", true],
    ["VALUES (1)", true],
    ["SHOW TABLES", true],
    ["DESCRIBE orders", true],
    ["DESC orders", true],
    ["PRAGMA table_info(t)", true],
    ["EXPLAIN SELECT 1", true],
    ["WITH cte AS (SELECT 1) SELECT * FROM cte", true],
    ["WITH RECURSIVE cte AS (SELECT 1) SELECT * FROM cte", true],
    ["WITH cte (n) AS (SELECT 1) SELECT n FROM cte", true],
    ['WITH "cte" AS (SELECT 1) SELECT 1', true],
    ["WITH [cte] AS (SELECT 1) SELECT 1", true],
    ["WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a", true],
    ["WITH -- name\ncte AS (SELECT 1) SELECT 1", true],
    ["WITH /* name */ cte AS (SELECT 1) SELECT 1", true],
    ["SELECT 'it''s fine'", true],
    ["WITH cte AS (SELECT 'it''s') SELECT 1", true],
    ["WITH cte AS (SELECT 'a') SELECT 1", true],
    ["WITH cte AS (SELECT 1 -- inside\n) SELECT 1", true],
    ["WITH cte AS (SELECT 1 /* inside */) SELECT 1", true],
    ["WITH cte AS (SELECT 1 SELECT 1", false],
    ["", false],
    ["   ", false],
    ["-- only a comment", false],
    ["SELECT 1; SELECT 2", false],
    ["SELECT 1;;", false],
    ["SELECT 1 /*", false],
    ["SELECT 'unterminated", false],
    ["INSERT INTO t VALUES (1)", false],
    ["UPDATE t SET a = 1", false],
    ["DELETE FROM t", false],
    ["SELECT 1 FOR UPDATE", false],
    ["SELECT 1 INTO t", false],
    ["EXPLAIN DELETE FROM t", false],
    ["EXPLAIN ANALYZE SELECT 1", false],
    ["WITH cte AS (INSERT INTO t VALUES (1)) SELECT 1", false],
    ["WITH cte AS (SELECT 1) DELETE FROM cte", false],
    ["WITH cte (SELECT 1) SELECT 1", false],
    ["WITH cte AS SELECT 1 SELECT 1", false],
    ['WITH "cte AS (SELECT 1) SELECT 1', false],
    ["WITH [cte AS (SELECT 1) SELECT 1", false],
    ["WITH 1 AS (SELECT 1) SELECT 1", false],
    ["WITH /*", false],
    ["WITH cte AS (SELECT 1), /*", false],
    [`${"EXPLAIN ".repeat(6)}SELECT 1`, true],
    [`${"EXPLAIN ".repeat(7)}SELECT 1`, false],
  ])("%s → %s", (sql, allowed) => {
    expect(isReadOnlySql(sql)).toBe(allowed);
  });

  test("a WITH with more than 32 parts is refused", () => {
    const parts = Array.from({ length: 33 }, (_, index) => `c${index} AS (SELECT 1)`);
    expect(isReadOnlySql(`WITH ${parts.join(", ")} SELECT 1`)).toBe(false);
  });
});
