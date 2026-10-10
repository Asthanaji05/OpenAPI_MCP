#!/usr/bin/env node
// openapi-mcp.mjs — turn any OpenAPI 3 spec into a running MCP server. No dependencies (Node 18+).
//
// Usage:   node openapi-mcp.mjs <spec-url-or-file> [base-url]
// Env:     API_HEADERS='{"Authorization":"Bearer xyz"}'   extra headers sent on every call (auth)
//          TOOL_FILTER='^(get|list)'                      only expose tools whose name matches this regex
// Client:  { "command": "npx", "args": ["openapi-mcp", "https://petstore3.swagger.io/api/v3/openapi.json"] }
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [src, baseArg] = process.argv.slice(2);
if (!src) { console.error("Usage: openapi-mcp.mjs <spec-url-or-file> [base-url]"); process.exit(1); }

// ---------- 1. Load the spec (JSON, or YAML if `npm i yaml` is installed) ----------
const raw = /^https?:/.test(src) ? await (await fetch(src)).text() : readFileSync(src, "utf8");
let spec;
try { spec = JSON.parse(raw); } catch { spec = (await import("yaml")).parse(raw); }

const base = (baseArg || new URL(spec.servers?.[0]?.url || "/", /^https?:/.test(src) ? src : "http://localhost").href).replace(/\/$/, "");

// Resolve "$ref": "#/components/..." pointers (cycle-safe)
const deref = (o, seen = []) => {
  if (Array.isArray(o)) return o.map(x => deref(x, seen));
  if (!o || typeof o !== "object") return o;
  if (o.$ref) {
    if (seen.includes(o.$ref)) return {};
    return deref(o.$ref.slice(2).split("/").reduce((a, k) => a?.[k], spec), [...seen, o.$ref]);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deref(v, seen)]));
};

// ---------- 2. One OpenAPI operation  =  one MCP tool ----------
const tools = {};
for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = item[method];
    if (!op) continue;
    const name = (op.operationId || `${method}_${path}`).replace(/[^\w]+/g, "_").slice(0, 64);
    if (process.env.TOOL_FILTER && !new RegExp(process.env.TOOL_FILTER).test(name)) continue;

    const params = deref([...(item.parameters || []), ...(op.parameters || [])]);
    const body = deref(op.requestBody?.content?.["application/json"]?.schema);
    tools[name] = {
      method, path, params, hasBody: !!body,
      def: {
        name,
        description: (op.summary || op.description || `${method.toUpperCase()} ${path}`).slice(0, 500),
        inputSchema: {
          type: "object",
          properties: {
            ...Object.fromEntries(params.map(p => [p.name, { ...p.schema, description: p.description }])),
            ...(body && { body: { ...body, description: "JSON request body" } }),
          },
          required: [...params.filter(p => p.required).map(p => p.name), ...(op.requestBody?.required ? ["body"] : [])],
        },
      },
    };
  }
}

// ---------- 3. Calling a tool = making the real HTTP request ----------
async function call({ method, path, params, hasBody }, args) {
  const query = new URLSearchParams();
  const headers = { "content-type": "application/json", ...JSON.parse(process.env.API_HEADERS || "{}") };
  for (const p of params) {
    if (args[p.name] === undefined) continue;
    if (p.in === "query") query.set(p.name, args[p.name]);
    if (p.in === "header") headers[p.name] = args[p.name];
  }
  const url = path.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(args[k])) + (query.toString() ? `?${query}` : "");
  const res = await fetch(base + url, {
    method: method.toUpperCase(), headers, body: hasBody && args.body ? JSON.stringify(args.body) : undefined,
  });
  return { isError: !res.ok, content: [{ type: "text", text: `HTTP ${res.status}\n` + (await res.text()).slice(0, 50_000) }] };
}

// ---------- 4. Minimal MCP server: JSON-RPC 2.0 over stdio ----------
const methods = {
  initialize: p => ({ protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: spec.info?.title || "openapi-mcp", version: spec.info?.version || "1.0.0" } }),
  ping: () => ({}),
  "tools/list": () => ({ tools: Object.values(tools).map(t => t.def) }),
  "tools/call": ({ name, arguments: args }) => {
    if (!tools[name]) throw new Error(`Unknown tool: ${name}`);
    return call(tools[name], args || {});
  },
};

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications need no reply
  try {
    if (!methods[msg.method]) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    send({ id: msg.id, result: await methods[msg.method](msg.params || {}) });
  } catch (e) {
    send({ id: msg.id, error: { code: -32603, message: e.message } });
  }
});

console.error(`openapi-mcp: ${Object.keys(tools).length} tools from "${spec.info?.title}" -> ${base}`);
