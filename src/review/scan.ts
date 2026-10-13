import ts from 'typescript';

/** Lines (1-based) where each pattern occurs as real code, not inside strings, regexes or comments. */
export interface CodeSignals {
  debugger: number[];
  consoleLog: number[];
  anyType: number[];
  todo: number[];
}

const CONSOLE_METHODS = new Set(['log', 'debug', 'trace', 'dir']);
/** A comment whose text starts with a marker, e.g. `// TODO: ...` or ` * FIXME ...`. */
const TODO_COMMENT = /^(?:\/\/+|\/\*+|\*)?\s*(?:TODO|FIXME|XXX|HACK)\b/;

/**
 * Finds review-relevant constructs with the TypeScript parser, so that the same words inside a
 * string, a regular expression or a comment that merely mentions them are not reported. Pure.
 * Throws if the parser cannot handle the file (the caller records it as not scanned).
 */
export function scanCode(fileName: string, content: string): CodeSignals {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
  const signals: CodeSignals = { debugger: [], consoleLog: [], anyType: [], todo: [] };
  const comments = new Set<number>();

  const collectComments = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (comments.has(range.pos)) continue;
      comments.add(range.pos);
      const text = content.slice(range.pos, range.end);
      // Each line of a block comment can start a new item (` * TODO: ...`).
      text.split(/\r?\n/).forEach((line, offset) => {
        if (TODO_COMMENT.test(line.trim())) signals.todo.push(lineOf(range.pos) + offset);
      });
    }
  };

  const visit = (node: ts.Node): void => {
    collectComments(ts.getLeadingCommentRanges(content, node.pos));
    collectComments(ts.getTrailingCommentRanges(content, node.end));
    if (node.kind === ts.SyntaxKind.DebuggerStatement) signals.debugger.push(lineOf(node.getStart(source)));
    else if (node.kind === ts.SyntaxKind.AnyKeyword) signals.anyType.push(lineOf(node.getStart(source)));
    else if (ts.isCallExpression(node) && isConsoleCall(node.expression)) signals.consoleLog.push(lineOf(node.getStart(source)));
    ts.forEachChild(node, visit);
  };
  visit(source);
  collectComments(ts.getLeadingCommentRanges(content, source.endOfFileToken.pos));

  for (const lines of Object.values(signals) as number[][]) lines.sort((a, b) => a - b);
  return signals;
}

function isConsoleCall(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'console' &&
    CONSOLE_METHODS.has(callee.name.text)
  );
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}
