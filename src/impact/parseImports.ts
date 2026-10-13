import ts from 'typescript';

export type ImportKind = 'static' | 'reference';

export interface ImportSpecifier {
  text: string;
  kind: ImportKind;
}

export interface DynamicImport {
  /** Leading constant part of a template/concatenated specifier, e.g. "./locales/" for `./locales/${lang}`. */
  staticPrefix: string | null;
}

export interface ParsedImports {
  /** import / export-from / require / import() with literal specifiers, and triple-slash references. */
  specifiers: ImportSpecifier[];
  /** import()/require() calls whose specifier is not a literal and therefore cannot be resolved. */
  dynamic: DynamicImport[];
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

// Cheap pre-filter: a call to import()/require() whose first argument is not a plain quoted string.
const NON_LITERAL_CALL = /\b(?:import|require)\s*\(\s*(?!['"][^'"\n]*['"]\s*[,)])/;

/** Extracts module specifiers from source text without type-checking. Pure. */
export function parseImports(fileName: string, content: string): ParsedImports {
  const info = ts.preProcessFile(content, true, true);
  const specifiers: ImportSpecifier[] = [
    ...info.importedFiles.map((ref): ImportSpecifier => ({ text: ref.fileName, kind: 'static' })),
    ...info.referencedFiles.map((ref): ImportSpecifier => ({ text: ref.fileName, kind: 'reference' })),
  ];
  const dynamic = NON_LITERAL_CALL.test(content) ? findDynamicImports(fileName, content) : [];
  return { specifiers, dynamic };
}

function findDynamicImports(fileName: string, content: string): DynamicImport[] {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const found: DynamicImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isImportOrRequire(node)) {
      const arg = node.arguments[0];
      if (arg && !ts.isStringLiteralLike(arg)) found.push({ staticPrefix: staticPrefixOf(arg) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isImportOrRequire(call: ts.CallExpression): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  return ts.isIdentifier(call.expression) && call.expression.text === 'require';
}

function staticPrefixOf(node: ts.Expression): string | null {
  if (ts.isTemplateExpression(node)) return node.head.text || null;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return ts.isStringLiteralLike(node.left) ? node.left.text || null : staticPrefixOf(node.left);
  }
  return null;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}
