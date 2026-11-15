# grammy-mcp

Every method of [grammY](https://grammy.dev)'s `Api` as an [MCP](https://modelcontextprotocol.io) tool, so an AI agent can act as your Telegram bot.

The tools are generated at build time from the installed grammY's own type declarations, so they match grammY exactly: the same methods (including convenience variants like `editMessageTextInline`), the same required arguments, and grammY's doc comments as descriptions. Calls go through grammY's `Api`, with [auto-retry](https://grammy.dev/plugins/auto-retry) installed by the server.

## Server

```bash
BOT_TOKEN=<token from @BotFather> npx -y grammy-mcp
```

Tools are named exactly like grammY's methods (`sendMessage`, `editMessageTextInline`). Which ones an agent may use is up to your MCP client's permissions.

`--fetch-urls`: download URLs in file fields and upload the bytes, instead of letting Telegram fetch them (which caps photos at 5 MB and other files at 20 MB).

Claude Code:

```bash
claude mcp add telegram -e BOT_TOKEN=<token> -- npx -y grammy-mcp
```

## Library

```ts
import { Api } from "grammy";
import { attachTools, createTools } from "grammy-mcp"; // npm i grammy-mcp grammy

// deny: tools never exposed or callable, whatever the client allows
const tools = createTools(new Api(token), { deny: ["logOut", "close"] });
tools.definitions; // MCP tool definitions
await tools.call("sendMessage", { chat_id: 1, text: "hi" });
attachTools(mcpServer, tools); // serve them from an MCP SDK Server
```

## How tools look

- One JSON object per call: positional parameters become required properties and the fields of `other` are merged in.
- Nested Telegram types (keyboards, entities, rich-message blocks) are collapsed to a loose object titled with the type's name, which keeps common tools around a thousand tokens instead of tens of thousands. The `describeType` tool returns a type's full JSON Schema on demand.
- Files: pass a `file_id`, an HTTP(S) URL (Telegram fetches it, unless `fetchUrls` is on), or `data:<mime>;name=<filename>;base64,<bytes>` to upload.
- Annotations are guessed from the method name: `get*` is read-only, deletes/bans/edits/sets are destructive.

## Development

```bash
npm test        # regenerates the tools, then runs the tests
npm run build
```

`src/generated/` is build output. Bumping `grammy` and rebuilding picks up new Bot API methods.
