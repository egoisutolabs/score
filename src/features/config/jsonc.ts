/** JSONC → JSON: strips line and block comments plus trailing commas, string-aware. */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      // A comment cut off at EOF means the file is truncated; loading whatever
      // parsed before the cut would be fail-open, so refuse instead.
      if (close === -1) throw new Error("unclosed block comment (/* without matching */)");
      i = close + 2;
      out += " "; // separator, so a comment splitting a token can't fuse it into valid JSON
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      // Only a comma that follows an actual element is trailing; keep leading
      // commas ({,} / [,]) so JSON.parse rejects them.
      if ((text[j] === "}" || text[j] === "]") && /[^\s{[,]/.test(lastNonWhitespace(out))) {
        i += 1;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}

function lastNonWhitespace(text: string): string {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const char = text[i] ?? "";
    if (!/\s/.test(char)) return char;
  }
  return "";
}

/** Index just past the closing quote of the string starting at `start`. */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  return i;
}
