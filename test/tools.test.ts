import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Api, InputFile } from "grammy";
import { attachTools, createTools, type ToolOptions } from "../src/mod.js";

type Call = { method: string; payload: Record<string, unknown> };

/** An Api whose requests never leave the process: a transformer answers them. */
function fakeApi(respond: (call: Call) => unknown = () => true) {
  const api = new Api("123:test");
  const calls: Call[] = [];
  api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    return { ok: true, result: respond(call) } as never;
  });
  return { api, calls };
}

function setup(options?: ToolOptions, respond?: (call: Call) => unknown) {
  const { api, calls } = fakeApi(respond);
  return { tools: createTools(api, options), calls };
}

const JPEG = "data:image/jpeg;name=moose.jpg;base64,/9j/";

describe("definitions", () => {
  it("has one tool per Api method, named like it, plus describeType", () => {
    const { tools } = setup();
    const names = tools.definitions.map((t) => t.name);
    expect(names).toContain("sendMessage");
    expect(names).toContain("editMessageTextInline");
    expect(names).toContain("describeType");
    expect(names.length).toBeGreaterThan(190);
  });

  it("keeps grammY's required arguments, including the inline split", () => {
    const { tools } = setup();
    const schema = (name: string) =>
      tools.definitions.find((t) => t.name === name)!.inputSchema;
    expect(schema("sendMessage").required).toEqual(["chat_id", "text"]);
    expect(schema("editMessageText").required)
      .toEqual(["chat_id", "message_id", "text_or_rich_message"]);
    expect(schema("editMessageTextInline").required)
      .toEqual(["inline_message_id", "text_or_rich_message"]);
  });

  it("collapses nested types to their name", () => {
    const { tools } = setup();
    const send = tools.definitions.find((t) => t.name === "sendMessage")!;
    const markup = (send.inputSchema.properties as Record<string, { anyOf: { title: string }[] }>)
      .reply_markup;
    expect(markup.anyOf.map((b) => b.title)).toContain("InlineKeyboardMarkup");
    expect(JSON.stringify(send.inputSchema)).not.toContain("$ref");
    expect(JSON.stringify(send.inputSchema).length).toBeLessThan(10_000);
  });

  it("hides and refuses denied tools", async () => {
    const { tools, calls } = setup({ deny: ["logOut", "ban*"] });
    const names = tools.definitions.map((t) => t.name);
    expect(names).not.toContain("logOut");
    expect(names).not.toContain("banChatMember");
    expect(names).toContain("sendMessage");
    expect((await tools.call("logOut")).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("annotates read-only and destructive methods", () => {
    const { tools } = setup();
    const ann = (name: string) => tools.definitions.find((t) => t.name === name)!.annotations;
    expect(ann("getChat")?.readOnlyHint).toBe(true);
    expect(ann("getUpdates")?.readOnlyHint).toBe(false);
    expect(ann("reopenForumTopic")?.destructiveHint).toBe(false);
    expect(ann("banChatMember")?.destructiveHint).toBe(true);
    expect(ann("sendMessage")?.destructiveHint).toBe(false);
  });
});

describe("call", () => {
  it("calls the Api method with positional arguments plus `other`", async () => {
    const { tools, calls } = setup(undefined, () => ({ message_id: 7 }));
    const res = await tools.call("sendMessage", { chat_id: 1, text: "hi", parse_mode: "HTML" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('{"message_id":7}');
    expect(calls).toEqual([{ method: "sendMessage", payload: { chat_id: 1, text: "hi", parse_mode: "HTML" } }]);
  });

  it("goes through grammY's convenience methods (inline variant, string vs rich text)", async () => {
    const { tools, calls } = setup();
    await tools.call("editMessageTextInline", { inline_message_id: "abc", text_or_rich_message: "new" });
    expect(calls[0]).toEqual({ method: "editMessageText", payload: { inline_message_id: "abc", text: "new" } });
  });

  it("turns data: URIs into InputFiles, also inside media groups", async () => {
    const { tools, calls } = setup();
    await tools.call("sendPhoto", { chat_id: 1, photo: JPEG });
    const photo = calls[0].payload.photo as InputFile;
    expect(photo).toBeInstanceOf(InputFile);
    expect(photo.filename).toBe("moose.jpg");

    await tools.call("sendMediaGroup", {
      chat_id: 1,
      media: [{ type: "photo", media: JPEG }, { type: "photo", media: "AgACAg-file-id" }],
    });
    const media = calls[1].payload.media as { media: unknown }[];
    expect(media[0].media).toBeInstanceOf(InputFile);
    expect(media[1].media).toBe("AgACAg-file-id");
  });

  it("passes URLs to Telegram, or fetches them itself with fetchUrls", async () => {
    const url = "https://example.com/moose.jpg";
    const plain = setup();
    await plain.tools.call("sendPhoto", { chat_id: 1, photo: url });
    expect(plain.calls[0].payload.photo).toBe(url);

    const fetching = setup({ fetchUrls: true });
    await fetching.tools.call("sendPhoto", { chat_id: 1, photo: url, caption: url });
    expect(fetching.calls[0].payload.photo).toBeInstanceOf(InputFile);
    expect(fetching.calls[0].payload.caption).toBe(url);
  });

  it("leaves data:-looking text alone outside file fields", async () => {
    const { tools, calls } = setup();
    await tools.call("sendMessage", { chat_id: 1, text: "data:,hello" });
    expect(calls[0].payload.text).toBe("data:,hello");
  });

  it("rejects invalid arguments before calling Telegram", async () => {
    const { tools, calls } = setup();
    const missing = await tools.call("sendMessage", { chat_id: 1 });
    const unknown = await tools.call("sendMessage", { chat_id: 1, text: "x", parse_mod: "HTML" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/text/);
    expect(unknown.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("reports Telegram errors", async () => {
    const { api } = fakeApi();
    api.config.use(async () =>
      ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }) as never
    );
    const res = await createTools(api).call("getChat", { chat_id: 1 });
    expect(res).toEqual({
      content: [{ type: "text", text: "getChat: Bad Request: chat not found" }],
      isError: true,
    });
  });

  it("describes types, and suggests close names", async () => {
    const { tools } = setup();
    const found = await tools.call("describeType", { name: "InlineKeyboardMarkup" });
    expect(JSON.parse(found.content[0].text).properties.inline_keyboard).toBeDefined();
    const missing = await tools.call("describeType", { name: "keyboardmarkup" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/InlineKeyboardMarkup/);
  });
});

describe("attachTools", () => {
  it("serves the tools over MCP", async () => {
    const { tools, calls } = setup(undefined, () => ({ message_id: 1 }));
    const server = new Server({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    attachTools(server, tools);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);

    const listed = await client.listTools();
    expect(listed.tools.length).toBe(tools.definitions.length);
    const res = await client.callTool({ name: "sendMessage", arguments: { chat_id: 5, text: "yo" } });
    expect(res.isError).toBeFalsy();
    expect(calls[0].payload).toEqual({ chat_id: 5, text: "yo" });
  });
});
