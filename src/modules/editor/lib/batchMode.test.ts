import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { batch } from "./batchMode";

type Tok = { text: string; tag: string | null };

/** Tokenize one line through the StringStream driver the editor uses. */
function tokenize(line: string, state = batch.startState!(2)): Tok[] {
  const stream = new StringStream(line, 2, 2, 0);
  const out: Tok[] = [];
  let guard = 0;
  while (!stream.eol()) {
    const start = stream.pos;
    const tag = batch.token(stream, state);
    // The driver throws after 10 non-advancing calls; assert we never rely
    // on that safety net.
    expect(stream.pos).toBeGreaterThan(start);
    out.push({ text: line.slice(start, stream.pos), tag });
    if (++guard > 1000) throw new Error("runaway tokenizer");
  }
  return out;
}

/** Tokens carrying a tag, as `tag:text` strings. */
function tagged(line: string, state = batch.startState!(2)): string[] {
  return tokenize(line, state)
    .filter((t) => t.tag)
    .map((t) => `${t.tag}:${t.text}`);
}

describe("batch stream mode", () => {
  it("treats REM and :: as comments", () => {
    expect(tagged("rem build everything")).toEqual(["comment:rem build everything"]);
    expect(tagged(":: pseudo comment")).toEqual(["comment::: pseudo comment"]);
  });

  it("does not treat rem as a comment mid-line", () => {
    // `echo rem is text` — only the verb is highlighted, the rest is plain.
    expect(tagged("echo rem later")).toEqual(["keyword:echo"]);
  });

  it("highlights command verbs only at a command position", () => {
    expect(tagged("echo hi")).toEqual(["keyword:echo"]);
    // `set` inside an argument is NOT a verb.
    expect(tagged("echo set the value")).toEqual(["keyword:echo"]);
    // ...but it is right after a chaining operator.
    expect(tagged("echo hi & set X=1")).toEqual([
      "keyword:echo",
      "operator:&",
      "keyword:set",
    ]);
  });

  it("recognizes indented commands", () => {
    // sol() is only true before indentation is eaten — a command inside a
    // parenthesised block keeps its verb highlight.
    expect(tagged("  echo nested")).toEqual(["keyword:echo"]);
  });

  it("highlights labels, including goto/call targets", () => {
    expect(tagged(":build")).toEqual(["label::build"]);
    expect(tagged("goto :build")).toEqual([
      "keyword:goto",
      "label::build",
    ]);
    expect(tagged("call :sub arg")).toEqual([
      "keyword:call",
      "label::sub",
    ]);
  });

  it("highlights labels only at a command position", () => {
    // An unquoted `:` argument (e.g. in a URL path) is not a label.
    expect(tagged("echo C:\\x")).toEqual(["keyword:echo"]);
  });

  it("highlights %VAR%, %1, %*, %%a and !VAR! variables", () => {
    expect(tagged("echo %USERNAME%")).toEqual([
      "keyword:echo",
      "variableName:%USERNAME%",
    ]);
    expect(tagged("echo %1 %*")).toEqual([
      "keyword:echo",
      "variableName:%1",
      "variableName:%*",
    ]);
    expect(tagged("for %%f in (*.c) do echo %%f")).toContain(
      "variableName:%%f",
    );
    expect(tagged("echo !ERRORLEVEL!")).toEqual([
      "keyword:echo",
      "variableName:!ERRORLEVEL!",
    ]);
  });

  it("does not swallow prose into a bogus variable", () => {
    // `100% done and %X%` must not become one `%...%` token.
    expect(tagged("echo 100% done and %X% set")).toEqual([
      "keyword:echo",
      "variableName:%X%",
    ]);
    // Stray bangs in prose stay plain.
    expect(tagged("echo wow! amazing!")).toEqual(["keyword:echo"]);
  });

  it("highlights redirects, pipes and chaining", () => {
    expect(tagged("echo hi > out.txt 2>&1")).toEqual([
      "keyword:echo",
      "operator:>",
      "operator:>&",
    ]);
    expect(tagged("cmd1 && cmd2 || cmd3")).toEqual([
      "operator:&&",
      "operator:||",
    ]);
  });

  it("highlights comparison operators and block parens", () => {
    expect(tagged("if %1==2 (echo yes) else (echo no)")).toEqual([
      "keyword:if",
      "variableName:%1",
      "operator:==",
      "operator:(",
      "keyword:echo",
      "operator:)",
      "keyword:else",
      "operator:(",
      "keyword:echo",
      "operator:)",
    ]);
  });

  it("keeps quoted arguments intact", () => {
    expect(tagged('copy "C:\\Program Files\\x.dll" dst')).toEqual([
      "keyword:copy",
      'string:"C:\\Program Files\\x.dll"',
    ]);
  });

  it("exposes :: as the line comment token", () => {
    expect(batch.languageData?.commentTokens).toEqual({ line: "::" });
  });

  it("always advances the stream", () => {
    // Every odd character mix must consume input — a non-advancing token
    // makes CodeMirror throw "Stream parser failed to advance stream".
    for (const line of [
      "%%%",
      "!!!",
      "^^^",
      "(((",
      "|||",
      "@@@",
      "",
      " ",
      "\t",
      "a",
    ]) {
      expect(() => tokenize(line)).not.toThrow();
    }
  });
});
