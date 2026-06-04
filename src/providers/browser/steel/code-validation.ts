// Code validation — reject dangerous patterns before browser execution

type CodeToken =
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string };

const BLOCKED_GLOBAL_IDENTIFIERS = new Set([
  "eval",
  "Function",
  "importScripts",
]);

const BLOCKED_MEMBER_PROPERTIES = new Map([
  ["navigator", new Set(["sendBeacon"])],
  ["document", new Set(["cookie"])],
  ["window", new Set(["eval", "Function", "importScripts"])],
  ["globalThis", new Set(["eval", "Function", "importScripts"])],
]);

function tokenizeCode(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;

  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];

    if (/\s/u.test(ch)) {
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(code.length, i + 2);
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      let value = "";
      i++;
      while (i < code.length) {
        const current = code[i]!;
        if (current === "\\") {
          i += 2;
          continue;
        }
        if (current === quote) {
          i++;
          break;
        }
        value += current;
        i++;
      }
      tokens.push({ kind: "string", value });
      continue;
    }

    if (/[A-Za-z_$]/u.test(ch)) {
      let value = ch;
      i++;
      while (i < code.length && /[A-Za-z0-9_$]/u.test(code[i]!)) {
        value += code[i]!;
        i++;
      }
      tokens.push({ kind: "identifier", value });
      continue;
    }

    tokens.push({ kind: "punct", value: ch });
    i++;
  }

  return tokens;
}

function staticStringExpression(tokens: CodeToken[], start: number, end: number): string | undefined {
  let value = "";
  let expectString = true;

  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (expectString) {
      if (token.kind !== "string") {
        return undefined;
      }
      value += token.value;
      expectString = false;
      continue;
    }

    if (token.kind !== "punct" || token.value !== "+") {
      return undefined;
    }
    expectString = true;
  }

  return expectString ? undefined : value;
}

function isCallLike(tokens: CodeToken[], index: number): boolean {
  const next = tokens[index + 1];
  if (next?.kind === "punct" && next.value === "(") {
    return true;
  }

  const previous = tokens[index - 1];
  return previous?.kind === "identifier" && previous.value === "new";
}

function memberAccessStart(tokens: CodeToken[], index: number): number | undefined {
  const next = tokens[index + 1];
  if (next?.kind === "punct" && next.value === ".") {
    return index + 2;
  }
  if (next?.kind === "punct" && next.value === "[") {
    return index + 1;
  }
  if (next?.kind === "punct" && next.value === "?" && tokens[index + 2]?.kind === "punct") {
    const afterQuestion = tokens[index + 2]!;
    if (afterQuestion.value === ".") {
      return index + 3;
    }
    if (afterQuestion.value === "[") {
      return index + 2;
    }
  }
  return undefined;
}

export function validateBrowserCode(code: string): void {
  const found: string[] = [];
  const tokens = tokenizeCode(code);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier") {
      continue;
    }

    const previous = tokens[i - 1];
    const isProperty = previous?.kind === "punct" && previous.value === ".";
    if (!isProperty && BLOCKED_GLOBAL_IDENTIFIERS.has(token.value) && isCallLike(tokens, i)) {
      found.push(token.value);
      continue;
    }

    const blockedProperties = BLOCKED_MEMBER_PROPERTIES.get(token.value);
    if (!blockedProperties) {
      continue;
    }

    const accessStart = memberAccessStart(tokens, i);
    if (accessStart === undefined) {
      continue;
    }

    const property = tokens[accessStart];
    if (property?.kind === "identifier" && blockedProperties.has(property.value)) {
      found.push(`${token.value}.${property.value}`);
      continue;
    }

    const open = tokens[accessStart];
    if (open?.kind !== "punct" || open.value !== "[") {
      continue;
    }
    let closeIndex = accessStart + 1;
    while (closeIndex < tokens.length) {
      const close = tokens[closeIndex]!;
      if (close.kind === "punct" && close.value === "]") {
        break;
      }
      closeIndex++;
    }
    if (closeIndex >= tokens.length) {
      continue;
    }
    const computed = staticStringExpression(tokens, accessStart + 1, closeIndex);
    if (computed && blockedProperties.has(computed)) {
      found.push(`${token.value}[${computed}]`);
    }
  }

  if (found.length > 0) {
    throw new Error(`Browser code contains blocked patterns: ${found.join(", ")}`);
  }
}
