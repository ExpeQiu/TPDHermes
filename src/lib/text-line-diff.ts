export type DiffLineType = "equal" | "remove" | "add";

export type DiffLine = {
  type: DiffLineType;
  text: string;
};

/** 基于 LCS 的行级 diff，用于预览 AI 改写 */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", text: a[i] });
      i += 1;
    } else {
      result.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < m) {
    result.push({ type: "remove", text: a[i] });
    i += 1;
  }
  while (j < n) {
    result.push({ type: "add", text: b[j] });
    j += 1;
  }
  return result;
}

export function hasDiffChanges(lines: DiffLine[]): boolean {
  return lines.some((line) => line.type !== "equal");
}
