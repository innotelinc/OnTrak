/**
 * A small syntax highlighter for the preview pane.
 *
 * Not a general-purpose one, and not a library: this project has no runtime
 * dependencies on purpose, and the job here is narrower than highlighting code.
 * The pane shows a file *while it is being written*, so the input is usually not
 * valid code yet - a string with no closing quote, a comment running off the end,
 * an escape split in half. A highlighter that needs its input to parse would go
 * blank at exactly the moment it exists for, so every rule below is allowed to run
 * to the end of the text, and anything it does not recognise is left as plain
 * characters rather than guessed at.
 *
 * `highlightCode` returns HTML, or null when it has nothing to say about the
 * language - the caller then shows the text as-is. Only text it was given is ever
 * emitted, escaped, so a file full of `<script>` stays a file full of text.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const PYTHON_KEYWORDS =
  "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|" +
  "global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield";

const JS_KEYWORDS =
  "abstract|any|as|async|await|boolean|break|case|catch|class|const|continue|declare|default|delete|" +
  "do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|" +
  "interface|let|new|null|number|of|package|private|protected|public|readonly|return|static|string|" +
  "super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield";

const SHELL_KEYWORDS =
  "alias|case|cd|do|done|echo|elif|else|esac|export|fi|for|function|if|in|local|read|return|set|" +
  "source|then|while";

/**
 * One sticky regex per language, with a group per token kind and `classes` naming
 * them in the same order.
 *
 * Order matters twice over: the alternatives are tried left to right at each
 * position, so a JSON key (a string followed by a colon) has to come before the
 * plain string that would otherwise match it; and a terminated string has to come
 * before the unterminated one, or the greedy tail would swallow the rest of the
 * file.
 */
const RULES = {
  python: {
    classes: ["tok-comment", "tok-string", "tok-number", "tok-keyword"],
    pattern:
      /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|(\b(?:KEYWORDS)\b)/
        .source.replace("KEYWORDS", PYTHON_KEYWORDS),
  },
  javascript: {
    classes: ["tok-comment", "tok-string", "tok-number", "tok-keyword"],
    pattern:
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|\/\*[\s\S]*$)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b(?:KEYWORDS)\b)/
        .source.replace("KEYWORDS", JS_KEYWORDS),
  },
  json: {
    classes: ["tok-key", "tok-string", "tok-number", "tok-keyword"],
    pattern:
      /("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*"?)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b(?:true|false|null)\b)/
        .source,
  },
  shell: {
    classes: ["tok-comment", "tok-string", "tok-number", "tok-keyword"],
    pattern:
      /(#[^\n]*)|("(?:\\.|[^"\\\n])*"?|'(?:[^'\n])*'?)|(\b\d+\b)|(\b(?:KEYWORDS)\b)/
        .source.replace("KEYWORDS", SHELL_KEYWORDS),
  },
};

const BY_EXTENSION = {
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "javascript",
  tsx: "javascript",
  mts: "javascript",
  cts: "javascript",
  json: "json",
  jsonc: "json",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  env: "shell",
};

/** The rule set for a path, or "plain" when the file is not code we know. */
export function languageOf(filePath) {
  if (typeof filePath !== "string") return "plain";
  const name = filePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "plain";
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "plain";
}

/** Languages this module can colour, for the caller's own use. */
export function languages() {
  return Object.keys(RULES);
}

/**
 * Highlight `text` as `language`, or return null to leave it alone.
 *
 * Never throws: a rule set that produced no match at some position just means the
 * character there is plain. Whatever comes back contains exactly the input's
 * characters, only wrapped in spans, which is what lets the client use the body's
 * `textContent` as a cheap "has this changed?" test.
 */
export function highlightCode(text, language) {
  if (typeof text !== "string" || text === "") return null;
  const spec = RULES[language];
  if (spec === undefined) return null;

  const regex = new RegExp(spec.pattern, "y");
  let html = "";
  let plain = "";
  let index = 0;

  while (index < text.length) {
    regex.lastIndex = index;
    const match = regex.exec(text);

    if (match === null) {
      plain += text[index];
      index += 1;
      continue;
    }

    const kind = match.slice(1).findIndex((group) => group !== undefined);
    if (kind === -1 || match[0] === "") {
      plain += match[0];
      index = Math.max(regex.lastIndex, index + 1);
      continue;
    }

    if (plain !== "") {
      html += escapeHtml(plain);
      plain = "";
    }
    html += `<span class="${spec.classes[kind]}">${escapeHtml(match[0])}</span>`;
    index = regex.lastIndex;
  }

  if (plain !== "") html += escapeHtml(plain);
  return html;
}
