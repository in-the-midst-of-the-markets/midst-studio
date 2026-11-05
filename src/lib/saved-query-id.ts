/**
 * The ID a saved query is joined by.
 *
 * The display name can be "Monthly Active Users". The ID is the table Cross_DB_Joins lists,
 * so it has to be one unquoted identifier: a letter or underscore, then letters, numbers,
 * and underscores. Spaces, punctuation, and a leading digit are not a table name.
 */

/** Long enough for a descriptive id, short enough that it stays a name. */
export const SAVED_QUERY_TABLE_ID_MAX = 128;

const TABLE_ID = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{N}_]*$/u;

/** Why `value` cannot be a saved-query ID, or null when it can. */
export function savedQueryTableIdError(value: string): string | null {
  if (value === "") return "Enter an ID. Cross_DB_Joins lists it as a table.";
  if (value.length > SAVED_QUERY_TABLE_ID_MAX) {
    return `An ID can be at most ${SAVED_QUERY_TABLE_ID_MAX} characters.`;
  }
  if (!TABLE_ID.test(value)) {
    return "An ID can only use letters, numbers, and underscores, and it has to start with a letter or underscore.";
  }
  return null;
}
