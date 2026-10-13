import ts from 'typescript';

/** This module's exports that depend on something; `'*'` when module-level code (side effects) uses it. */
export type Dependents = '*' | readonly string[];

export interface ModuleImport {
  specifier: string;
  /** Imported name (`'default'` for default imports), or null for the whole module (namespace, side effect, require, import()). */
  imported: string | null;
  /** Exports of this module whose code uses the import. */
  dependents: Dependents;
}

/** Bindings a module passes on from another module without using them itself. */
export type ModuleReexport =
  /** `export * from 'x'` */
  | { specifier: string; kind: 'star' }
  /** `export { imported as exported } from 'x'`, or an imported binding exported again */
  | { specifier: string; kind: 'named'; imported: string; exported: string }
  /** `export * as exported from 'x'`, or a namespace import exported again */
  | { specifier: string; kind: 'namespace'; exported: string };

export interface DynamicImport {
  /** Leading constant part of a template/concatenated specifier, e.g. "./locales/" for `./locales/${lang}`. */
  staticPrefix: string | null;
}

export interface ModuleSyntax {
  /** Dependencies the module's own code uses: imports, require, literal import(), import types, triple-slash references. */
  imports: ModuleImport[];
  reexports: ModuleReexport[];
  /** Names the module itself defines and exports; null when they cannot be listed statically (CommonJS, `export =`). */
  localExports: string[] | null;
  /** import()/require() calls whose specifier is not a literal and therefore cannot be resolved. */
  dynamic: DynamicImport[];
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** What a local import binding refers to; `imported` is null for namespace and `import x = require()` bindings. */
interface Binding {
  specifier: string;
  imported: string | null;
}

/** Key of the anonymous `export default <expression>` declaration. */
const DEFAULT_KEY = '\0default';
/** Key prefix of an inline `require('x')` / `import('x')` / `import('x').T` dependency. */
const INLINE_PREFIX = '\0inline:';

/**
 * Extracts the module structure from source text without type-checking: which names it takes from
 * which specifier, which it passes on, which it defines, and which of its exports use which import.
 * Pure.
 *
 * Dependencies are tracked per top-level declaration: an export depends on the imports its
 * declaration references, directly or through other top-level declarations. Module-level code
 * (statements that are not declarations) makes its imports affect every export. References are
 * matched by name, so shadowing can only add dependencies, never hide one.
 */
export function parseModule(fileName: string, content: string): ModuleSyntax {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const bindings = new Map<string, Binding>();
  const wholeModule = new Set<string>();
  const reexports: ModuleReexport[] = [];
  const reexportedLocals = new Set<string>();
  /** Exported name -> key of the local declaration it exports. */
  const exportLocals = new Map<string, string>();
  /** Declaration key -> keys it references (other declarations, import bindings, inline imports). */
  const declarations = new Map<string, Set<string>>();
  const effects = new Set<string>();
  const inline = new Map<string, string>();
  const dynamic: DynamicImport[] = [];
  let hasModuleSyntax = false;
  let exportAssignment = false;

  const reexportBinding = (local: string, exported: string): boolean => {
    const binding = bindings.get(local);
    if (binding === undefined) return false;
    reexports.push(
      binding.imported === null
        ? { specifier: binding.specifier, kind: 'namespace', exported }
        : { specifier: binding.specifier, kind: 'named', imported: binding.imported, exported },
    );
    reexportedLocals.add(local);
    return true;
  };

  // Imports and top-level names first, so references can be told apart from unrelated identifiers.
  const topNames = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      hasModuleSyntax = true;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      let named = false;
      if (clause?.name) {
        bindings.set(clause.name.text, { specifier, imported: 'default' });
        named = true;
      }
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        bindings.set(namedBindings.name.text, { specifier, imported: null });
        named = true;
      } else if (namedBindings) {
        for (const element of namedBindings.elements) {
          bindings.set(element.name.text, { specifier, imported: (element.propertyName ?? element.name).text });
          named = true;
        }
      }
      // `import './x'` and `import {} from './x'` load the module for its side effects.
      if (!named) wholeModule.add(specifier);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)) {
        hasModuleSyntax = true;
        bindings.set(statement.name.text, { specifier: reference.expression.text, imported: null });
      } else {
        topNames.add(statement.name.text);
      }
    } else {
      for (const name of declaredNames(statement)) topNames.add(name);
    }
  }

  const referencesOf = (node: ts.Node): Set<string> => {
    const found = new Set<string>();
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child)) {
        if (bindings.has(child.text) || topNames.has(child.text)) found.add(child.text);
        return;
      }
      if (ts.isCallExpression(child) && isImportOrRequire(child)) {
        const arg = child.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) found.add(inlineKey(arg.text));
        else if (arg) dynamic.push({ staticPrefix: staticPrefixOf(arg) });
      } else if (ts.isImportTypeNode(child) && ts.isLiteralTypeNode(child.argument) && ts.isStringLiteral(child.argument.literal)) {
        found.add(inlineKey(child.argument.literal.text));
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const inlineKey = (specifier: string): string => {
    const key = `${INLINE_PREFIX}${specifier}`;
    inline.set(key, specifier);
    return key;
  };
  const declare = (key: string, references: ReadonlySet<string>): void => {
    const existing = declarations.get(key);
    if (existing === undefined) declarations.set(key, new Set(references));
    else for (const reference of references) existing.add(reference);
  };
  const addEffects = (references: ReadonlySet<string>): void => {
    for (const reference of references) effects.add(reference);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isImportEqualsDeclaration(statement)) {
      if (!ts.isExternalModuleReference(statement.moduleReference)) declare(statement.name.text, referencesOf(statement.moduleReference));
      if (hasExportModifier(statement)) exportLocals.set(statement.name.text, statement.name.text);
    } else if (ts.isExportDeclaration(statement)) {
      hasModuleSyntax = true;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (clause === undefined) reexports.push({ specifier, kind: 'star' });
        else if (ts.isNamespaceExport(clause)) reexports.push({ specifier, kind: 'namespace', exported: clause.name.text });
        else {
          for (const element of clause.elements) {
            reexports.push({ specifier, kind: 'named', imported: (element.propertyName ?? element.name).text, exported: element.name.text });
          }
        }
      } else if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const local = element.propertyName ?? element.name;
          if (!ts.isIdentifier(local) || !reexportBinding(local.text, element.name.text)) {
            exportLocals.set(element.name.text, local.text);
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      hasModuleSyntax = true;
      if (statement.isExportEquals === true) {
        exportAssignment = true;
        addEffects(referencesOf(statement.expression));
      } else if (!(ts.isIdentifier(statement.expression) && reexportBinding(statement.expression.text, 'default'))) {
        declare(DEFAULT_KEY, referencesOf(statement.expression));
        exportLocals.set('default', DEFAULT_KEY);
      }
    } else if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      if (exported) hasModuleSyntax = true;
      for (const declaration of statement.declarationList.declarations) {
        const references = referencesOf(declaration);
        for (const name of bindingNames(declaration.name)) {
          declare(name, references);
          if (exported) exportLocals.set(name, name);
        }
      }
    } else if (isNamedDeclaration(statement)) {
      const references = referencesOf(statement);
      const name = statement.name !== undefined && ts.isIdentifier(statement.name) ? statement.name.text : undefined;
      const key = name ?? DEFAULT_KEY;
      declare(key, references);
      if (hasExportModifier(statement)) {
        hasModuleSyntax = true;
        exportLocals.set(hasDefaultModifier(statement) ? 'default' : key, key);
      }
    } else {
      // Module-level code runs on import, so whatever it touches can affect every export.
      addEffects(referencesOf(statement));
    }
  }

  const closureMemo = new Map<string, ReadonlySet<string>>();
  const closure = (key: string): ReadonlySet<string> => {
    const memo = closureMemo.get(key);
    if (memo) return memo;
    const seen = new Set<string>([key]);
    const stack = [key];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const reference of declarations.get(current) ?? []) {
        if (seen.has(reference)) continue;
        seen.add(reference);
        stack.push(reference);
      }
    }
    closureMemo.set(key, seen);
    return seen;
  };
  const effectClosure = new Set([...effects].flatMap((key) => [...closure(key)]));
  const exportClosures = [...exportLocals].map(([exported, local]) => [exported, closure(local)] as const);
  const dependentsOf = (key: string): Dependents =>
    effectClosure.has(key) ? '*' : exportClosures.filter(([, keys]) => keys.has(key)).map(([exported]) => exported);
  const referenced = new Set([...effects, ...[...declarations.values()].flatMap((references) => [...references])]);

  const imports = new Map<string, ModuleImport>();
  const addImport = (specifier: string, imported: string | null, dependents: Dependents): void => {
    const key = `${specifier}\0${imported ?? ''}`;
    const existing = imports.get(key);
    if (existing === undefined) {
      imports.set(key, { specifier, imported, dependents });
      return;
    }
    const merged: Dependents =
      existing.dependents === '*' || dependents === '*' ? '*' : [...new Set([...existing.dependents, ...dependents])];
    imports.set(key, { specifier, imported, dependents: merged });
  };
  for (const specifier of wholeModule) addImport(specifier, null, '*');
  for (const [local, binding] of bindings) {
    // A binding referenced only by export clauses is passed on, not used. An unused import is
    // still listed (the module is loaded) but no export depends on it.
    if (reexportedLocals.has(local) && !referenced.has(local)) continue;
    addImport(binding.specifier, binding.imported, dependentsOf(local));
  }
  for (const [key, specifier] of inline) addImport(specifier, null, dependentsOf(key));
  for (const reference of source.referencedFiles) addImport(reference.fileName, null, '*');

  // Without import/export syntax the file may be CommonJS, whose exports cannot be listed statically.
  const listable = hasModuleSyntax && !exportAssignment;
  return { imports: [...imports.values()], reexports, localExports: listable ? [...exportLocals.keys()] : null, dynamic };
}

type NamedDeclaration =
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ModuleDeclaration;

function isNamedDeclaration(statement: ts.Statement): statement is NamedDeclaration {
  return (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name))
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false);
}

/** Names a top-level statement declares. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  }
  if (isNamedDeclaration(statement) && statement.name !== undefined && ts.isIdentifier(statement.name)) return [statement.name.text];
  return [];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
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
