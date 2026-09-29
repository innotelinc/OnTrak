/**
 * A small line-oriented diff, so the browser can show what a write actually
 * changed instead of only a one-line summary.
 *
 * The agent's own tool results stay terse (that is what the model reads), while
 * the UI renders the structured hunks returned alongside them.
 */

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
  /** 1-based line number in the old file, or null for an inserted line. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null for a removed line. */
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  created: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** True when the change was too large to render line by line. */
  truncated: boolean;
}

/** Lines kept either side of a change when grouping hunks. */
const CONTEXT = 3;

/**
 * Cost ceiling for the O(n*m) LCS table. Past this we fall back to a coarse
 * "everything removed, everything added" diff, which is still correct.
 */
const MAX_MATRIX = 4_000_000;

/** Past this many changed lines the hunks are dropped and only counts survive. */
const MAX_DIFF_LINES = 2_000;

/**
 * Split into lines without the phantom empty entry a trailing newline produces,
 * so a file that ends in "\n" does not look like it gained a blank line.
 */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Walk the two arrays and record insertions, deletions and context. */
function buildOps(before: string[], after: string[]): DiffLine[] {
  const ops: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;

  const push = (type: DiffLine["type"], text: string): void => {
    if (type === "add") {
      ops.push({ type, text, oldLine: null, newLine: newNo });
      newNo += 1;
    } else if (type === "del") {
      ops.push({ type, text, oldLine: oldNo, newLine: null });
      oldNo += 1;
    } else {
      ops.push({ type, text, oldLine: oldNo, newLine: newNo });
      oldNo += 1;
      newNo += 1;
    }
  };

  // Identical leading and trailing runs are trivially context; skipping them
  // keeps the LCS table small, which matters for large files.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (
    tailBefore > head &&
    tailAfter > head &&
    before[tailBefore - 1] === after[tailAfter - 1]
  ) {
    tailBefore -= 1;
    tailAfter -= 1;
  }

  for (let index = 0; index < head; index += 1) push("ctx", before[index] ?? "");

  const a = before.slice(head, tailBefore);
  const b = after.slice(head, tailAfter);

  if (a.length * b.length > MAX_MATRIX) {
    // Too large to align: report the whole middle as a replacement.
    for (const line of a) push("del", line);
    for (const line of b) push("add", line);
  } else {
    const width = b.length + 1;
    // dp[i][j] = length of the longest common subsequence of a[i..] and b[j..].
    const dp = new Int32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        const here = i * width + j;
        dp[here] =
          a[i] === b[j]
            ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
      }
    }

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        push("ctx", a[i] ?? "");
        i += 1;
        j += 1;
      } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
        push("del", a[i] ?? "");
        i += 1;
      } else {
        push("add", b[j] ?? "");
        j += 1;
      }
    }
    for (; i < a.length; i += 1) push("del", a[i] ?? "");
    for (; j < b.length; j += 1) push("add", b[j] ?? "");
  }

  for (let index = tailBefore; index < before.length; index += 1) push("ctx", before[index] ?? "");

  return ops;
}

/** Group changed lines into hunks, each padded with a little context. */
function buildHunks(ops: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let index = 0;

  while (index < ops.length) {
    if (ops[index]?.type === "ctx") {
      index += 1;
      continue;
    }

    const start = Math.max(0, index - CONTEXT);
    let end = index;
    // Extend while changes stay near each other; a gap wider than the context
    // on both sides starts a new hunk.
    while (end < ops.length) {
      if (ops[end]?.type === "ctx") {
        let run = 0;
        while (end + run < ops.length && ops[end + run]?.type === "ctx") run += 1;
        if (end + run >= ops.length || run > CONTEXT * 2) break;
        end += run;
        continue;
      }
      end += 1;
    }

    const last = Math.min(ops.length - 1, end + CONTEXT);
    const lines = ops.slice(start, last + 1);
    if (lines.length === 0) break;

    hunks.push({
      oldStart: lines[0]?.oldLine ?? 1,
      newStart: lines[0]?.newLine ?? 1,
      lines,
    });
    index = last + 1;
  }

  return hunks;
}

/** A structured description of how `before` became `after`. */
export function buildFileDiff(
  path: string,
  before: string,
  after: string,
  options: { created?: boolean } = {},
): FileDiff {
  const oldLines = toLines(before);
  const newLines = toLines(after);
  const ops = buildOps(oldLines, newLines);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added += 1;
    else if (op.type === "del") removed += 1;
  }

  const tooLarge = ops.length > MAX_DIFF_LINES;
  return {
    path,
    created: options.created ?? false,
    added,
    removed,
    hunks: tooLarge ? [] : buildHunks(ops),
    truncated: tooLarge,
  };
}
