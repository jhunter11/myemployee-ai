import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { SettlementVerificationRequestV1Schema } from '../../src/queue/verification-contracts';

const projectRoot = join(__dirname, '..', '..');
const sourceRoot = join(projectRoot, 'src');
const primaryReaderPath = join(sourceRoot, 'reliability', 'primary-evidence-reader.ts');
const observerCompositionRoot = join(
  sourceRoot,
  'reliability',
  'observer-verification-composition.ts'
);
const verificationFreezeRepositoryPath = join(
  sourceRoot,
  'db',
  'verification-freeze-repository.ts'
);

interface ModuleReference {
  moduleSpecifier: string;
  importedNames: ReadonlySet<string>;
  importsAll: boolean;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(path);
      return entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
    })
  );
  return files.flat();
}

function moduleReferences(filename: string, source: string): ModuleReference[] {
  const scriptKind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const references: ModuleReference[] = [];

  function record(
    moduleSpecifier: string,
    importedNames: Iterable<string> = [],
    importsAll = false
  ): void {
    references.push({
      moduleSpecifier,
      importedNames: new Set(importedNames),
      importsAll
    });
  }

  function visit(node: ts.Node): void {
    const [onlyArgument] = ts.isCallExpression(node) ? node.arguments : [];
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names: string[] = [];
      let importsAll = false;
      if (node.importClause?.name !== undefined) names.push('default');
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        importsAll = true;
      } else if (bindings !== undefined) {
        names.push(
          ...bindings.elements.map((element) =>
            element.propertyName === undefined ? element.name.text : element.propertyName.text
          )
        );
      }
      record(node.moduleSpecifier.text, names, importsAll);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        record(node.moduleSpecifier.text, [], true);
      } else {
        record(
          node.moduleSpecifier.text,
          node.exportClause.elements.map((element) =>
            element.propertyName === undefined ? element.name.text : element.propertyName.text
          )
        );
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression.text, [], true);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      onlyArgument !== undefined &&
      ts.isStringLiteralLike(onlyArgument) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      record(onlyArgument.text, [], true);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function resolveSourceReference(
  importer: string,
  moduleSpecifier: string,
  knownSourceFiles: ReadonlySet<string>
): string | undefined {
  if (!moduleSpecifier.startsWith('.')) return undefined;
  const unresolved = resolve(dirname(importer), moduleSpecifier);
  const extension = extname(unresolved);
  const withoutRuntimeExtension = ['.js', '.cjs', '.mjs'].includes(extension)
    ? unresolved.slice(0, -extension.length)
    : unresolved;
  const candidates = ['.ts', '.tsx'].includes(extname(withoutRuntimeExtension))
    ? [withoutRuntimeExtension]
    : [
        `${withoutRuntimeExtension}.ts`,
        `${withoutRuntimeExtension}.tsx`,
        join(withoutRuntimeExtension, 'index.ts'),
        join(withoutRuntimeExtension, 'index.tsx')
      ];
  return candidates.find((candidate) => knownSourceFiles.has(candidate));
}

function projectPath(path: string): string {
  return relative(projectRoot, path).split(sep).join('/');
}

function isWithin(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function isGuardedSettlementWriter(path: string): boolean {
  return /(?:guarded.*(?:writer|repository)|verification-settlement-(?:writer|repository)|settlement-guarded-(?:writer|repository))\.tsx?$/iu.test(
    basename(path)
  );
}

function pathToForbiddenModule(
  start: string,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  forbidden: ReadonlySet<string>
): string[] | undefined {
  const pending: Array<{ file: string; path: string[] }> = [{ file: start, path: [start] }];
  const visited = new Set([start]);

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    for (const dependency of graph.get(current.file) ?? []) {
      const dependencyPath = [...current.path, dependency];
      if (forbidden.has(dependency)) return dependencyPath;
      if (!visited.has(dependency)) {
        visited.add(dependency);
        pending.push({ file: dependency, path: dependencyPath });
      }
    }
  }
  return undefined;
}

describe('primary evidence authority boundaries', () => {
  let sourceFiles: string[] = [];
  let sourceFileSet: ReadonlySet<string> = new Set();
  let referencesByFile: ReadonlyMap<string, ModuleReference[]> = new Map();
  let importGraph: ReadonlyMap<string, ReadonlySet<string>> = new Map();

  beforeAll(async () => {
    sourceFiles = await listTypeScriptFiles(sourceRoot);
    sourceFileSet = new Set(sourceFiles);
    const references = await Promise.all(
      sourceFiles.map(
        async (file) => [file, moduleReferences(file, await readFile(file, 'utf8'))] as const
      )
    );
    referencesByFile = new Map(references);
    importGraph = new Map(
      references.map(([file, fileReferences]) => [
        file,
        new Set(
          fileReferences
            .map((reference) =>
              resolveSourceReference(file, reference.moduleSpecifier, sourceFileSet)
            )
            .filter((target): target is string => target !== undefined)
        )
      ])
    );
  });

  it('keeps the query-only primary reader independent from migration and writer modules', () => {
    const forbiddenImports = (referencesByFile.get(primaryReaderPath) ?? []).filter((reference) => {
      const target = resolveSourceReference(
        primaryReaderPath,
        reference.moduleSpecifier,
        sourceFileSet
      );
      return (
        reference.moduleSpecifier === 'kysely' ||
        reference.importedNames.has('Kysely') ||
        reference.importedNames.has('createDatabase') ||
        (target !== undefined && isWithin(target, join(sourceRoot, 'db')))
      );
    });

    expect(forbiddenImports.map((reference) => reference.moduleSpecifier)).toEqual([]);
  });

  it('reserves the primary reader opener for the named observer composition root', () => {
    const violations = sourceFiles.flatMap((file) => {
      if (file === primaryReaderPath || file === observerCompositionRoot) return [];
      return (referencesByFile.get(file) ?? [])
        .filter((reference) => {
          const target = resolveSourceReference(file, reference.moduleSpecifier, sourceFileSet);
          return (
            target === primaryReaderPath &&
            (reference.importsAll || reference.importedNames.has('openPrimaryEvidenceReader'))
          );
        })
        .map(() => projectPath(file));
    });

    expect(violations).toEqual([]);
  });

  it('keeps generic agent, gateway, dashboard, and queue paths away from settlement authority', () => {
    const restrictedRoots = ['agency', 'agents', 'dashboard', 'gateway', 'queue'].map((directory) =>
      join(sourceRoot, directory)
    );
    const restrictedFiles = sourceFiles.filter((file) =>
      restrictedRoots.some((root) => isWithin(file, root))
    );
    const forbiddenFiles = new Set(
      sourceFiles.filter(
        (file) =>
          file === primaryReaderPath ||
          file === verificationFreezeRepositoryPath ||
          isGuardedSettlementWriter(file)
      )
    );
    const violations = restrictedFiles.flatMap((file) => {
      const authorityPath = pathToForbiddenModule(file, importGraph, forbiddenFiles);
      return authorityPath === undefined
        ? []
        : [authorityPath.map((component) => projectPath(component)).join(' -> ')];
    });

    expect(violations).toEqual([]);
  });
});

describe('external settlement verification request boundary', () => {
  const holdId = 'f'.repeat(64);
  const validRequest = { schemaVersion: 1, holdId } as const;

  it('accepts exactly the protocol version and opaque hold selector', () => {
    const parsed = SettlementVerificationRequestV1Schema.parse(validRequest);

    expect(parsed).toEqual(validRequest);
    expect(Object.keys(parsed).sort()).toEqual(['holdId', 'schemaVersion']);
    expect(SettlementVerificationRequestV1Schema.safeParse({ holdId }).success).toBe(false);
    expect(SettlementVerificationRequestV1Schema.safeParse({ schemaVersion: 1 }).success).toBe(
      false
    );
  });

  it.each([
    ['database filename', 'filename', '/var/lib/jarvis/primary.sqlite'],
    ['database filename alias', 'databaseFilename', '/var/lib/jarvis/primary.sqlite'],
    ['tenant', 'tenantId', 'acme_corp'],
    ['verdict', 'verdict', 'passed'],
    ['generic digest', 'digest', 'a'.repeat(64)],
    ['result digest', 'resultSha256', 'a'.repeat(64)],
    ['evidence object', 'evidence', { verdict: 'passed' }],
    ['evidence body', 'evidenceBody', '{"verdict":"passed"}'],
    ['candidate result body', 'canonicalResultJson', '{"ok":true}']
  ])('rejects caller-supplied %s', (_label, field, value) => {
    expect(
      SettlementVerificationRequestV1Schema.safeParse({
        ...validRequest,
        [field]: value
      }).success
    ).toBe(false);
  });
});
