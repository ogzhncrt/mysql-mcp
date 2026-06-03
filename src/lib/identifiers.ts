/**
 * Maximum length of a MySQL identifier (per MySQL docs §9.2.1).
 */
export const MYSQL_IDENT_MAX_LENGTH = 64;

/**
 * Permissive structural check for table/column identifiers. Rejects only:
 *   - empty string
 *   - identifiers longer than 64 characters
 *   - control characters (including NUL)
 *   - backticks (would close the quote even with escaping in legacy code)
 *
 * The actual SQL-injection protection comes from `escapeIdentifier`, which
 * wraps the name in backticks and doubles any internal backticks. This
 * regex is defense-in-depth.
 */
const IDENT_REGEX = new RegExp(
  `^[^\\x00-\\x1F\`]{1,${MYSQL_IDENT_MAX_LENGTH}}$`,
);

export function isValidIdentifier(name: string): boolean {
  return IDENT_REGEX.test(name);
}

export function assertValidIdentifier(name: string, field: string): void {
  if (!isValidIdentifier(name)) {
    throw new Error(
      `"${field}" must be a non-empty identifier (1–${MYSQL_IDENT_MAX_LENGTH} chars, ` +
        `no backticks or control characters), got "${name}"`,
    );
  }
}

/**
 * Wraps an identifier in backticks, doubling any existing backticks per
 * the MySQL identifier escape rule. Combined with `assertValidIdentifier`
 * (which already rejects backticks) this is belt-and-suspenders, but the
 * escape is the actual safety mechanism.
 */
export function escapeIdentifier(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}
