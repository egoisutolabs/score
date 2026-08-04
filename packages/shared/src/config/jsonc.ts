import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/**
 * Parses JSONC (comments + trailing commas) fail-closed: jsonc-parser's parse
 * is fault-tolerant and returns a best-effort partial value on syntax errors
 * (e.g. a truncated file), so any collected error must throw instead.
 */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first) {
    throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
}
