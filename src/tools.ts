import { Validator, type Schema as JsonSchema } from "@cfworker/json-schema";
import { GrammyError, InputFile, type Api } from "grammy";
import toolData from "./generated/tools.json" with { type: "json" };
import typeData from "./generated/types.json" with { type: "json" };
import { decodeDataUri, isDataUri } from "./files.js";

type Schema = Record<string, unknown>;

interface ToolData {
  method: string;
  description?: string;
  deprecated?: boolean;
  positional: string[];
  other: boolean;
  inputSchema: Schema;
  schema: Schema;
}

const TOOLS = toolData as ToolData[];
const TYPES = typeData as Record<string, Schema>;

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Schema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolOptions {
  /**
   * Globs over tool names never to expose or call, e.g. `["logOut", "close"]`.
   * Per-tool permissions are the client's job; this is for embedders that need a
   * guarantee no client configuration can undo.
   */
  deny?: string[];
  /**
   * Fetch http(s) URLs in file fields and upload the bytes, instead of letting
   * Telegram fetch them (which caps photos at 5 MB and other files at 20 MB).
   */
  fetchUrls?: boolean;
}

export interface Tools {
  definitions: ToolDefinition[];
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

/** The tool returning full schemas of the nested types other tools only name. */
export const DESCRIBE_TYPE = "describeType";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(name: string, globs: string[] | undefined): boolean {
  return (globs ?? []).some((glob) => globToRegExp(glob).test(name));
}

/** Hints from the method name; the Bot API itself carries none. */
function annotationsFor(method: string): ToolDefinition["annotations"] {
  // getUpdates with an offset confirms (deletes) updates, so it's no read.
  if (/^get/.test(method) && method !== "getUpdates") {
    return { readOnlyHint: true, openWorldHint: true };
  }
  const destructive =
    /^(delete|ban|kick|revoke|remove|decline|unpin|close|leave|logOut|restrict|promote|replace|transfer|convert|upgrade|refund|set|edit|stop)/
      .test(method);
  return { readOnlyHint: false, destructiveHint: destructive, openWorldHint: true };
}

/**
 * Replace data: URIs (and, with `fetchUrls`, http URLs) in file positions with
 * InputFiles, guided by the full schema.
 */
function convertFiles(value: unknown, schema: Schema | undefined, fetchUrls: boolean): unknown {
  if (!schema) return value;
  if (typeof schema.$ref === "string") {
    return convertFiles(value, TYPES[schema.$ref.slice("#/$defs/".length)], fetchUrls);
  }
  if (schema["x-input-file"]) {
    if (isDataUri(value)) {
      const { bytes, filename } = decodeDataUri(value);
      return new InputFile(bytes, filename);
    }
    if (fetchUrls && typeof value === "string" && /^https?:\/\//i.test(value)) {
      return new InputFile(new URL(value));
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) value = convertFiles(value, branch, fetchUrls);
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => convertFiles(item, schema.items as Schema, fetchUrls));
  }
  if (value && typeof value === "object" && !(value instanceof InputFile)) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    return Object.fromEntries(
      Object.entries(value).map((
        [key, v],
      ) => [key, convertFiles(v, properties[key], fetchUrls)]),
    );
  }
  return value;
}

function text(t: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: t }], isError: true }
    : { content: [{ type: "text", text: t }] };
}

function describeType(args: Record<string, unknown>): ToolResult {
  const name = String(args.name ?? "");
  const schema = TYPES[name];
  if (schema) return text(JSON.stringify(schema));
  const needle = name.toLowerCase();
  const similar = Object.keys(TYPES)
    .filter((t) => t.toLowerCase().includes(needle)).slice(0, 20);
  return text(
    `No type named "${name}".` +
      (similar.length ? ` Similar: ${similar.join(", ")}` : ""),
    true,
  );
}

/**
 * MCP tools for every method of grammY's `Api`, named exactly like the methods,
 * plus `describeType`. Nested types in tool schemas are collapsed to their name;
 * `describeType` expands them. Files can be passed as file_id, URL, or
 * `data:<mime>;name=<file>;base64,…`.
 */
export function createTools(api: Api, options: ToolOptions = {}): Tools {
  const byName = new Map<string, ToolData & { validator: Validator }>();
  const definitions: ToolDefinition[] = [];
  for (const tool of TOOLS) {
    const name = tool.method;
    if (matchesAny(name, options.deny)) continue;
    const description = tool.deprecated
      ? `Deprecated. ${tool.description ?? ""}`.trim()
      : tool.description;
    definitions.push({
      name,
      description,
      inputSchema: tool.inputSchema,
      annotations: annotationsFor(tool.method),
    });
    byName.set(name, {
      ...tool,
      validator: new Validator(tool.inputSchema as JsonSchema, "2020-12"),
    });
  }
  definitions.push({
    name: DESCRIBE_TYPE,
    description:
      "Full JSON Schema of a Telegram type that other tools only name in a `title`, e.g. InlineKeyboardMarkup. Nested types appear as $refs to look up the same way.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Type name, e.g. InlineKeyboardMarkup" } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  });

  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    if (name === DESCRIBE_TYPE) return describeType(args);
    const tool = byName.get(name);
    if (!tool) return text(`Unknown tool: ${name}`, true);

    const check = tool.validator.validate(args);
    if (!check.valid) {
      const errors = check.errors
        .filter((e) => e.keyword !== "properties" && e.keyword !== "anyOf")
        .map((e) => `${e.instanceLocation}: ${e.error}`);
      return text(`Invalid arguments for ${name}:\n${errors.join("\n")}`, true);
    }

    const converted = convertFiles(args, tool.schema, options.fetchUrls ?? false) as Record<
      string,
      unknown
    >;
    const positional = tool.positional.map((p) => converted[p]);
    const rest = Object.fromEntries(
      Object.entries(converted).filter(([k]) => !tool.positional.includes(k)),
    );
    const callArgs = tool.other ? [...positional, rest] : positional;
    const methods = api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    try {
      const result = await methods[tool.method].apply(api, callArgs);
      return text(JSON.stringify(result));
    } catch (error) {
      if (error instanceof GrammyError) {
        return text(`${tool.method}: ${error.description}`, true);
      }
      return text(`${tool.method} failed: ${(error as Error).message}`, true);
    }
  }

  return { definitions, call };
}
