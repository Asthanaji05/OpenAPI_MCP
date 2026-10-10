#!/usr/bin/env node
// openapi-mcp.mjs — turn any OpenAPI 3 spec into a running MCP server. No dependencies (Node 18+).
//
// Usage:   node openapi-mcp.mjs <spec-url-or-file> [base-url]
// Env:     API_TOKEN=xyz                                  your secret; the spec's securitySchemes decide where it goes:
//                                                         bearer -> Authorization header, apiKey -> header/query/cookie, basic -> "user:pass"
//          OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET          OAuth2 client-credentials (token fetched + refreshed automatically)
//          OAUTH_REFRESH_TOKEN                            OAuth2 refresh-token grant (you did the login once, elsewhere)
//          OAUTH_TOKEN_URL / OAUTH_SCOPE                  optional: override tokenUrl from the spec / request a scope
//          API_HEADERS='{"Authorization":"Bearer xyz"}'   extra headers sent on every call (auth)
//          TOOL_FILTER='^(get|list)'                      only expose tools whose name matches this regex
//          MCP_AUTH_TOKEN=secret                          (HTTP mode) require "Authorization: Bearer secret"
//
// Two modes:  default        local stdio server, launched by the MCP client
//             --http <port>  remote server, POST http://host:<port>/mcp   (put --http last)
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = args.indexOf("--http");
const port = flag >= 0 ? Number(args.splice(flag, 2)[1]) || process.env.PORT || 3000 : 0;
const [src, baseArg] = args;
if (!src) { console.error("Usage: openapi-mcp.mjs <spec-url-or-file> [base-url] [--http <port>]"); process.exit(1); }

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

// ---------- 3. Auth: put the secret where the spec's securityScheme says ----------
const schemes = spec.components?.securitySchemes || {};
const scheme = deref(schemes[Object.keys(spec.security?.[0] || schemes)[0]]); // first scheme the API requires
let refresh = process.env.OAUTH_REFRESH_TOKEN, tokenCache; // cache the *promise* so parallel tool calls share one token request

function oauthToken(s) {
  const e = process.env;
  if (!e.OAUTH_CLIENT_ID && !refresh) return e.API_TOKEN; // no OAuth setup: treat API_TOKEN as a ready access token
  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache.promise;
  const entry = (tokenCache = { expires: Infinity });
  entry.promise = (async () => {
    const url = e.OAUTH_TOKEN_URL || Object.values(s.flows || {}).map(f => f.tokenUrl).find(Boolean);
    if (!url) throw new Error("No OAuth token URL in the spec: set OAUTH_TOKEN_URL");
    const form = new URLSearchParams(refresh
      ? { grant_type: "refresh_token", refresh_token: refresh }
      : { grant_type: "client_credentials", ...(e.OAUTH_SCOPE && { scope: e.OAUTH_SCOPE }) });
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (e.OAUTH_CLIENT_ID) headers.authorization = "Basic " + Buffer.from(`${e.OAUTH_CLIENT_ID}:${e.OAUTH_CLIENT_SECRET || ""}`).toString("base64");
    const res = await fetch(url, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status}`);
    const j = await res.json();
    refresh = j.refresh_token || refresh; // some providers rotate refresh tokens
    entry.expires = Date.now() + ((j.expires_in || 3600) - 30) * 1000;
    return j.access_token;
  })().catch(err => { tokenCache = null; throw err; });
  return entry.promise;
}

async function authorize(headers, query) {
  if (!scheme) return;
  const token = /oauth2|openIdConnect/.test(scheme.type) ? await oauthToken(scheme) : process.env.API_TOKEN;
  if (!token) return;
  if (scheme.type === "apiKey") {
    if (scheme.in === "query") query.set(scheme.name, token);
    else if (scheme.in === "cookie") headers.cookie = `${scheme.name}=${token}`;
    else headers[scheme.name] = token;
  } else {
    headers.authorization = scheme.scheme?.toLowerCase() === "basic" ? "Basic " + Buffer.from(token).toString("base64") : `Bearer ${token}`;
  }
}

// ---------- 4. Calling a tool = making the real HTTP request ----------
async function call({ method, path, params, hasBody }, args) {
  const query = new URLSearchParams();
  const headers = { "content-type": "application/json", ...JSON.parse(process.env.API_HEADERS || "{}") };
  for (const p of params) {
    if (args[p.name] === undefined) continue;
    if (p.in === "query") query.set(p.name, args[p.name]);
    if (p.in === "header") headers[p.name] = args[p.name];
  }
  await authorize(headers, query);
  const url = path.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(args[k])) + (query.toString() ? `?${query}` : "");
  const res = await fetch(base + url, {
    method: method.toUpperCase(), headers, body: hasBody && args.body ? JSON.stringify(args.body) : undefined,
  });
  return { isError: !res.ok, content: [{ type: "text", text: `HTTP ${res.status}\n` + (await res.text()).slice(0, 50_000) }] };
}

// ---------- 5. Minimal MCP server: JSON-RPC 2.0 (transport-independent) ----------
const methods = {
  initialize: p => ({ protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: spec.info?.title || "openapi-mcp", version: spec.info?.version || "1.0.0" } }),
  ping: () => ({}),
  "tools/list": () => ({ tools: Object.values(tools).map(t => t.def) }),
  "tools/call": ({ name, arguments: args }) => {
    if (!tools[name]) throw new Error(`Unknown tool: ${name}`);
    return call(tools[name], args || {});
  },
};

// One JSON-RPC message in, one reply out (null for notifications, which need no reply)
async function handle(msg) {
  if (msg.id === undefined) return null;
  const reply = x => ({ jsonrpc: "2.0", id: msg.id, ...x });
  if (!methods[msg.method]) return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
  try { return reply({ result: await methods[msg.method](msg.params || {}) }); }
  catch (e) { return reply({ error: { code: -32603, message: e.message } }); }
}

// ---------- 6. Transports ----------
if (!port) {
  // Local: the MCP client launches this process and talks over stdin/stdout
  createInterface({ input: process.stdin }).on("line", async line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
} else {
  // Remote: same messages, sent as HTTP POST to /mcp
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) console.error("WARNING: MCP_AUTH_TOKEN is not set - anyone who can reach this server can call your API.");
  createServer(async (req, res) => {
    const end = (code, text = "") => res.writeHead(code).end(text);
    if (req.url !== "/mcp") return end(404, "Not found");
    if (req.method !== "POST") return end(405, "Use POST");
    if (token && req.headers.authorization !== `Bearer ${token}`) return end(401, "Unauthorized");
    let data = ""; for await (const chunk of req) data += chunk;
    let msg; try { msg = JSON.parse(data); } catch { return end(400, "Bad JSON"); }
    const out = await handle(msg);
    if (!out) return end(202);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  }).listen(port, () => console.error(`openapi-mcp: listening on http://localhost:${port}/mcp`));
}

console.error(`openapi-mcp: ${Object.keys(tools).length} tools from "${spec.info?.title}" -> ${base}`);
