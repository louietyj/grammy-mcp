/**
 * Generates `src/generated/{tools,types}.json` from the installed grammY's type
 * declarations: one tool per method of grammY's `Api` class, with a JSON Schema
 * of its arguments and the doc comments as descriptions, plus every named type.
 *
 * Positional parameters become required properties (unless optional), and the
 * fields of the trailing `other` object are merged in, so a tool takes one JSON
 * object. `positional` records the order to call the method with. Parameters
 * that accept grammY's `InputFile` are marked `{ "x-input-file": true }`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const ENTRY = `${ROOT}__schema_entry.ts`;
const OUT_DIR = `${ROOT}src/generated`;

type Schema = Record<string, unknown>;

const entrySource = `
import type { Api } from "grammy";
export type __Api = Api;
`;

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};
const host = ts.createCompilerHost(options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (f, lang) =>
  f === ENTRY
    ? ts.createSourceFile(f, entrySource, lang, true)
    : getSourceFile(f, lang);

const program = ts.createProgram([ENTRY], options, host);
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length > 0) {
  console.error(ts.formatDiagnostics(errors, host));
  process.exit(1);
}
const checker = program.getTypeChecker();

const apiAlias = program.getSourceFile(ENTRY)!.statements
  .find(ts.isTypeAliasDeclaration)!;
const apiType = checker.getTypeAtLocation(apiAlias.name);

/** Declared by grammY or its Bot API types, as opposed to TS's own libs. */
function isGrammyFile(fileName: string): boolean {
  return /\/node_modules\/(grammy|@grammyjs\/types)\//.test(fileName);
}

const defs: Record<string, Schema> = {};
const inProgress = new Set<string>();

function docOf(symbol: ts.Symbol | undefined): string | undefined {
  if (!symbol) return undefined;
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker))
    .trim();
  return text === "" ? undefined : text;
}

/** Adds the symbol's doc comment, and `deprecated` for `@deprecated` symbols. */
function annotate(schema: Schema, symbol: ts.Symbol | undefined): Schema {
  const result = { ...schema };
  const description = docOf(symbol);
  if (description !== undefined) result.description = description;
  const deprecated = symbol?.getJsDocTags(checker)
    .find((tag) => tag.name === "deprecated");
  if (deprecated) {
    result.deprecated = true;
    const note = ts.displayPartsToString(deprecated.text).trim();
    if (note !== "" && description === undefined) result.description = note;
  }
  return result;
}

/** The name a type gets in $defs, if it is a named interface or alias. */
function defName(type: ts.Type): string | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return undefined;
  if (symbol.getName().startsWith("__")) return undefined; // anonymous
  const decl = symbol.declarations?.[0];
  if (!decl) return undefined;
  if (!isGrammyFile(decl.getSourceFile().fileName)) return undefined;
  if (!type.aliasSymbol && !ts.isInterfaceDeclaration(decl)) return undefined;
  // Qualify namespace members (InlineKeyboardButton.CommonButton) so that
  // equally named types in different namespaces don't collide.
  return checker.getFullyQualifiedName(symbol).replace(/^"[^"]*"\./, "");
}

function isInputFile(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return symbol?.getName() === "InputFile" &&
    isGrammyFile(symbol.declarations?.[0]?.getSourceFile().fileName ?? "");
}

function convert(type: ts.Type): Schema {
  if (isInputFile(type)) return { "x-input-file": true };

  const name = defName(type);
  if (name !== undefined) {
    if (!(name in defs) && !inProgress.has(name)) {
      inProgress.add(name);
      defs[name] = annotate(
        convertStructure(type),
        type.aliasSymbol ?? type.getSymbol(),
      );
      inProgress.delete(name);
    }
    return { $ref: `#/$defs/${name}` };
  }
  return convertStructure(type);
}

function convertStructure(type: ts.Type): Schema {
  const f = type.flags;
  if (f & ts.TypeFlags.Any || f & ts.TypeFlags.Unknown) return {};
  if (f & ts.TypeFlags.String) return { type: "string" };
  if (f & ts.TypeFlags.Number) return { type: "number" };
  if (f & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (f & ts.TypeFlags.Null) return { type: "null" };
  if (type.isStringLiteral()) return { type: "string", const: type.value };
  if (type.isNumberLiteral()) return { type: "number", const: type.value };
  if (f & ts.TypeFlags.BooleanLiteral) {
    return { type: "boolean", const: checker.typeToString(type) === "true" };
  }

  if (type.isUnion()) {
    const members = type.types.filter((t) =>
      !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))
    );
    // `boolean` is `true | false` internally.
    const bools = members.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
    const rest = members.filter((t) =>
      !(t.flags & ts.TypeFlags.BooleanLiteral)
    );
    const parts = rest.map(convert);
    if (bools.length === 2) parts.push({ type: "boolean" });
    else parts.push(...bools.map(convert));
    if (parts.length === 1) return parts[0];
    // A union of string literals reads better as an enum.
    if (parts.every((p) => p.type === "string" && "const" in p)) {
      return { type: "string", enum: parts.map((p) => p.const) };
    }
    return { anyOf: parts };
  }

  if (type.isIntersection()) {
    // `string & {}` keeps literal autocompletion open; the `{}` adds nothing.
    const parts = type.types.filter((t) =>
      !(t.flags & ts.TypeFlags.Object &&
        checker.getPropertiesOfType(t).length === 0)
    );
    return parts.length === 1
      ? convert(parts[0])
      : { allOf: parts.map(convert) };
  }

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    return { type: "array", items: element ? convert(element) : {} };
  }

  if (f & ts.TypeFlags.Object) return convertObject(type);

  throw new Error(`Unsupported type: ${checker.typeToString(type)}`);
}

function convertObject(type: ts.Type): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    properties[prop.getName()] = annotate(convert(propType), prop);
    if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(prop.getName());
  }
  const schema: Schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  schema.additionalProperties = index ? convert(index.type) : false;
  return schema;
}

function paramDoc(decl: ts.ParameterDeclaration): string | undefined {
  const comment = ts.getJSDocParameterTags(decl)[0]?.comment;
  const text = typeof comment === "string"
    ? comment
    : ts.getTextOfJSDocComment(comment);
  return text?.trim() || undefined;
}

const INLINE_LIMIT = 600;

function hasRef(schema: unknown): boolean {
  return JSON.stringify(schema).includes('"$ref"');
}

/**
 * A tool's schema without the nested type definitions, which would make common
 * tools cost thousands of tokens: each named type becomes a loose object titled
 * with its name, for `describe_type` to expand on demand. Small leaf types stay
 * inline.
 */
function collapse(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(collapse);
  if (!schema || typeof schema !== "object") return schema;
  const { $ref, ...rest } = schema as Schema;
  if (typeof $ref === "string") {
    const name = $ref.slice("#/$defs/".length);
    const def = defs[name];
    if (!hasRef(def) && JSON.stringify(def).length <= INLINE_LIMIT) {
      return { ...def, ...collapse(rest) as Schema };
    }
    const stub: Schema = { title: name };
    if (def.type === "object" || def.anyOf) stub.type = "object";
    if (def.description) stub.description = def.description;
    return { ...stub, ...collapse(rest) as Schema };
  }
  return Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, collapse(value)]),
  );
}

const tools = [];
for (const method of checker.getPropertiesOfType(apiType)) {
  const decl = method.valueDeclaration;
  if (!decl || !ts.isMethodDeclaration(decl)) continue;
  const signature = checker.getTypeOfSymbolAtLocation(method, decl)
    .getCallSignatures()[0];

  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  const positional: string[] = [];
  let other = false;
  for (const param of signature.getParameters()) {
    const paramDecl = param.valueDeclaration as ts.ParameterDeclaration;
    const name = param.getName();
    if (name === "signal") continue;
    const type = checker.getNonNullableType(
      checker.getTypeOfSymbolAtLocation(param, paramDecl),
    );
    if (name === "other") {
      // The remaining optional parameters, as an object.
      const merged = convertObject(type);
      Object.assign(properties, merged.properties);
      required.push(...((merged.required as string[] | undefined) ?? []));
      other = true;
      continue;
    }
    const schema = convert(type);
    const description = paramDoc(paramDecl);
    properties[name] = description ? { ...schema, description } : schema;
    if (!paramDecl.questionToken) required.push(name);
    positional.push(name);
  }

  const schema: Schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = false;

  tools.push({
    method: method.getName(),
    ...annotate({}, method),
    positional,
    other,
    inputSchema: collapse(schema),
    // Full schema, with $refs into types.json: used to find file fields.
    schema,
  });
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/tools.json`, JSON.stringify(tools) + "\n");
const sortedDefs = Object.fromEntries(
  Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(`${OUT_DIR}/types.json`, JSON.stringify(sortedDefs) + "\n");
console.log(
  `generated: ${tools.length} tools, ${Object.keys(defs).length} types`,
);
