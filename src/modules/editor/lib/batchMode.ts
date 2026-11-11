import type { StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Windows Batch (.bat / .cmd) syntax mode.
 *
 * `@codemirror/legacy-modes` has no batch mode (it stops at shell/toml/yaml
 * for this family), so this is a hand-rolled StreamParser. Batch is
 * line-oriented, which maps well onto a stream parser:
 *
 *  - `REM ...` / `:: ...` comments, only at a command position (a `::` in
 *    the middle of an argument is not a comment, per cmd.exe).
 *  - `:label` GOTO/CALL targets.
 *  - `@` echo suppression (`@echo off`).
 *  - `%VAR%`, `%1`/`%*`, `%%a` loop vars, `!VAR!` delayed expansion.
 *  - `==`, `EQU`..`GEQ`, redirection (`>`, `>>`, `<`), pipes and `&`/`&&`/`||`
 *    chaining, caret escapes, and quoted arguments.
 *
 * Command verbs are only recognized at a command position (start of line or
 * right after a chaining operator), so a word like `set` appearing inside an
 * argument string stays plain text.
 */
type BatchState = {
  /** True while the next word is a command verb (line start / after `&`). */
  cmdStart: boolean;
};

/** Control-flow words that may appear mid-line (`for %%a in (…) do …`). */
const CONTROL_WORDS = new Set([
  "if",
  "else",
  "for",
  "in",
  "do",
  "goto",
  "call",
  "not",
  "exist",
  "defined",
  "equ",
  "neq",
  "lss",
  "leq",
  "gtr",
  "geq",
]);

/** Internal and common external command verbs. */
const COMMANDS = new Set([
  "assoc",
  "attrib",
  "cacls",
  "cd",
  "chdir",
  "choice",
  "cls",
  "color",
  "copy",
  "curl",
  "del",
  "dir",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "expand",
  "fc",
  "find",
  "findstr",
  "forfiles",
  "ftype",
  "icacls",
  "ipconfig",
  "label",
  "md",
  "mklink",
  "mkdir",
  "more",
  "move",
  "net",
  "netstat",
  "path",
  "pause",
  "ping",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "reg",
  "regsvr32",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "robocopy",
  "runas",
  "sc",
  "schtasks",
  "set",
  "setlocal",
  "setx",
  "shift",
  "shutdown",
  "sort",
  "start",
  "systeminfo",
  "takeown",
  "tar",
  "taskkill",
  "tasklist",
  "timeout",
  "title",
  "tree",
  "type",
  "ver",
  "verify",
  "vol",
  "where",
  "whoami",
  "xcopy",
]);

const COMPARISON_OPS = /^(==|equ|neq|lss|leq|gtr|geq)\b/i;

export const batch: StreamParser<BatchState> = {
  name: "batch",
  startState: (): BatchState => ({ cmdStart: true }),

  token(stream, state) {
    // Line start resets the command position BEFORE eating indentation —
    // after eatSpace, sol() is false and `  echo hi` would lose its verb.
    if (stream.sol()) state.cmdStart = true;
    if (stream.eatSpace()) return null;

    // Command chaining: the token after these starts a fresh command.
    if (stream.match(/^&&/) || stream.match(/^\|\|/) || stream.match(/^&/)) {
      state.cmdStart = true;
      return "operator";
    }

    // Quoted argument (variables inside stay unstyled, same as cmd.exe).
    if (stream.match(/^"[^"]*"/)) {
      state.cmdStart = false;
      return "string";
    }

    // Caret escape: the next character is literal, so `^echo` is not a verb.
    if (stream.match(/^\^./)) {
      state.cmdStart = false;
      return "operator";
    }

    if (state.cmdStart) {
      // Echo-suppression prefix: `@echo off`.
      if (stream.match(/^@/)) return "meta";

      // `::` pseudo-comment and REM comments run to end of line.
      if (stream.match(/^::/)) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/^rem\b/i)) {
        stream.skipToEnd();
        return "comment";
      }

      // `:label` (GOTO/CALL target). A leading `::` was handled above.
      if (stream.match(/^:[\w.-]+/)) {
        state.cmdStart = false;
        return "label";
      }
    }

    // Variables: %VAR%, %1, %*, %%a, and delayed-expansion !VAR!.
    // The name charset is restricted to what cmd.exe actually accepts —
    // a permissive `%[^%]+%` swallows prose like `100% done %X%` into one
    // bogus token.
    if (stream.match(/^%[\w.#@()-]+%/) || stream.match(/^%[\d*]/)) {
      return "variableName";
    }
    if (stream.match(/^%%\w/) || stream.match(/^![\w.#@]+!/)) {
      return "variableName";
    }

    // Redirection / pipes. `>&` and `>>&` come first: they duplicate a file
    // descriptor (`2>&1`), and matching just `>` would leave the `&` to be
    // read as command chaining — swallowing the rest of the line as a new
    // command.
    if (stream.match(/^(>>&|>&|>>|>|<|\|)/)) {
      state.cmdStart = false;
      return "operator";
    }

    // Comparison operators, anywhere.
    if (stream.match(COMPARISON_OPS)) return "operator";

    // Block-syntax parentheses: `(` opens a parenthesised block whose first
    // word is a command (`if x (echo y)`); `)` closes it.
    if (stream.match(/^\(/)) {
      state.cmdStart = true;
      return "operator";
    }
    if (stream.match(/^\)/)) {
      state.cmdStart = false;
      return "operator";
    }

    const before = stream.pos;
    const word = stream.match(/^\w+/);
    if (word) {
      // `match` types as `true | RegExpMatchArray`; the array form is what a
      // capturing-capable regex returns, so read the text defensively.
      const w = (Array.isArray(word) ? word[0] : "").toLowerCase();
      if (CONTROL_WORDS.has(w) || (state.cmdStart && COMMANDS.has(w))) {
        // `do` / `else` are followed by a fresh command; `goto` / `call` are
        // followed by a label, which the `:name` rule only matches at a
        // command position (`goto :build`, `call :sub arg`).
        state.cmdStart =
          w === "do" || w === "else" || w === "goto" || w === "call";
        return "keyword";
      }
      state.cmdStart = false;
      return null;
    }

    // Any other character: consume one so the stream always advances
    // (readToken throws after 10 non-advancing calls).
    if (stream.pos === before) stream.next();
    state.cmdStart = false;
    return null;
  },

  languageData: {
    commentTokens: { line: "::" },
  },

  tokenTable: {
    label: t.labelName,
  },
};
