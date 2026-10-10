# OpenAPI MCP

Turn any OpenAPI 3 spec into a working [MCP](https://modelcontextprotocol.io) server. One file, about 130 lines, no dependencies.

```
node openapi-mcp.mjs https://your-api.com/openapi.json
```

Every API endpoint becomes a tool that an AI client (Claude, Cursor, etc.) can call. There is no code generation and no per-endpoint files. The spec is read at startup, and the tools are built in memory.

## Quick start

Requires Node 18 or newer.

```bash
git clone <this-repo>
cd openapi-mcp
node openapi-mcp.mjs examples/animechan.openapi.json
```

It prints `openapi-mcp: 4 tools from "Animechan" -> ...` and then waits silently for an MCP client. That is normal: it talks JSON-RPC over stdin/stdout and is not meant to be read by humans.

## Use it with an AI client

### Claude Desktop (local mode)

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "animechan": {
      "command": "node",
      "args": ["/full/path/openapi-mcp.mjs", "/full/path/animechan.openapi.json"]
    }
  }
}
```

If the client can't find `node`, use the full path from `which node`.

### Claude Code (remote mode)

Start the server, then register it:

```bash
MCP_AUTH_TOKEN=secret node openapi-mcp.mjs examples/animechan.openapi.json --http 8787

claude mcp add --transport http animechan http://localhost:8787/mcp \
  --header "Authorization: Bearer secret"
```

Then ask in plain English: "give me a random quote from Naruto".

## Two modes

| Mode | Command | Use when |
|---|---|---|
| Local (stdio) | `node openapi-mcp.mjs <spec>` | The client launches the server on your machine |
| Remote (HTTP) | `node openapi-mcp.mjs <spec> --http <port>` | The client connects to a URL, or you want to self-host |

In HTTP mode, clients send JSON-RPC messages as `POST http://host:<port>/mcp`. Put `--http <port>` last.

Test it by hand:

```bash
curl -X POST localhost:8787/mcp -H 'Authorization: Bearer secret' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Options

```
node openapi-mcp.mjs <spec-url-or-file> [base-url] [--http <port>]
```

| Argument / env var | What it does |
|---|---|
| `<spec-url-or-file>` | OpenAPI 3 spec, as a URL or a local file (JSON; YAML needs `npm i yaml`) |
| `[base-url]` | Overrides the API address. Defaults to `servers[0].url` in the spec |
| `API_HEADERS` | Headers sent on every API call, for auth. Example: `'{"Authorization":"Bearer xyz"}'` |
| `TOOL_FILTER` | Regex. Only tools whose name matches are exposed. Example: `'^(get\|list)'` for read-only |
| `MCP_AUTH_TOKEN` | HTTP mode only. Requires `Authorization: Bearer <token>` on every request |

Big APIs can have hundreds of endpoints. Too many tools makes the model choose worse, so use `TOOL_FILTER` to keep the useful ones.

## How it works

1. **Load** the spec and resolve `$ref` pointers.
2. **Build tools:** each operation becomes one MCP tool. `operationId` is the name, `summary` the description, and parameters plus request body the input schema.
3. **Call:** a tool call makes the real HTTP request and returns `HTTP <status>` followed by the response body (cut at 50,000 characters).
4. **Serve** the tools over JSON-RPC 2.0, via stdio or HTTP.

## APIs without an OpenAPI spec

Many small public APIs only have HTML docs. For those, write a small spec by hand (see `examples/animechan.openapi.json`, 4 tools in about 35 lines), then run it the same way.

## Limitations

- OpenAPI 3 only. Convert Swagger 2.0 specs first.
- JSON request bodies only. No file uploads.
- Auth is static headers or keys. OAuth flows are not handled.
- HTTP mode speaks plain HTTP (put HTTPS in front when deploying) and has no streaming, batch requests, or OAuth. Some remote clients may require these.
- If you deploy remotely, every user shares your server's IP, so upstream rate limits apply to all of them. Set `MCP_AUTH_TOKEN`, or anyone who finds the URL can use your API key.

## Contributing

Issues and pull requests are welcome. The goal is to stay small and readable, so please keep new features to a few lines each.
