import { parse } from "yaml";

/** Parses YAML a repository supplied. Aliases are refused, so a small file cannot expand without bound. */
export function parseUntrustedYaml(text: string): unknown {
  return parse(text, { maxAliasCount: 0, uniqueKeys: true });
}
