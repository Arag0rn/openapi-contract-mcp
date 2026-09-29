# openapi-contract-mcp

An MCP server that lets a coding agent check requests against a live OpenAPI contract instead of guessing.

Five read-only tools: find an endpoint by docs anchor or path, read what it accepts and returns, and diff a
real request body against the schema. Tested with unit tests, protocol-level tests, and agent-level evals
that measure whether a model actually picks the right tool.

## Why

On a multi-tenant CRM I work on, a large share of "frontend bugs" turned out to be contract bugs, and the
arguments about them went in circles because both sides reasoned from memory. Two things kept wasting time:

- **The docs anchor is not the path.** A colleague links `#/accounts/change-email`, you search the code for
  `change-email` and find nothing, because the operationId is `change-email` and the path is `/auth/set_email/`.
- **Copying fields from a GET response into a PUT body.** `id` and `created_at` come back from the server but
  must not be sent; `firstName` vs `first_name` gets silently dropped by the backend.

The workflow started as a Claude Code skill I use on that project, with a small Python script. This server is
the same idea as a proper tool any MCP client can use, with the answers computed rather than eyeballed.

## Tools

| Tool | Use it when |
|---|---|
| `find_endpoint` | Someone names an endpoint by docs anchor, operationId, path fragment or tag. Matches operationId first. |
| `get_request_schema` | Writing a request: parameters (path, query, header) and body, `$ref`s resolved, `readOnly` fields removed, `requiredFields` listed. |
| `get_response_schema` | Reading a response, per status code. |
| `diff_payload` | A request fails with 400 or a field is "ignored". Lists missing required fields, unknown fields (with the closest valid name), wrong types, enum violations, `readOnly` fields sent, and `oneOf` mismatches. |
| `spec_info` | Checking which schema version is loaded; `refresh: true` after a deploy. |

Example, against the public Petstore schema:

```jsonc
// diff_payload { method: "POST", path: "/pet", payload: { "name": "Rex", "photoUrl": "x", "status": "sleeping" } }
{
  "operation": "POST /pet",
  "matchesContract": false,
  "issues": [
    { "path": "$.photoUrls", "kind": "missing", "message": "is required but missing" },
    { "path": "$.photoUrl",  "kind": "unknown", "message": "is not in the schema, did you mean \"photoUrls\"?" },
    { "path": "$.status",    "kind": "enum",    "message": "is \"sleeping\", allowed: \"available\", \"pending\", \"sold\"" }
  ]
}
```

A wrong path returns an error the model can recover from, not a dead end:

```
No operation DELETE /pets in the schema. Did you mean:
- DELETE /pet/{petId}
- ...
```

## Setup

Requires Node 20+. The schema must be OpenAPI 3.x as JSON, from a URL or a local file.

```sh
git clone https://github.com/Arag0rn/openapi-contract-mcp && cd openapi-contract-mcp
npm ci && npm run build
```

**Claude Code**

```sh
claude mcp add openapi-contract -- node /absolute/path/to/openapi-contract-mcp/dist/index.js https://petstore3.swagger.io/api/v3/openapi.json
```

**Cursor / any client with a JSON config**

```json
{
  "mcpServers": {
    "openapi-contract": {
      "command": "node",
      "args": ["/absolute/path/to/openapi-contract-mcp/dist/index.js", "https://your-api/schema/?format=json"]
    }
  }
}
```

| Setting | Default | |
|---|---|---|
| first CLI argument or `OPENAPI_SPEC` | | Schema URL or file path |
| `OPENAPI_CACHE_MINUTES` | `10` | How long a downloaded schema is reused |

## Design decisions

- **Read-only by construction.** The only network request the server makes is a GET for the schema itself,
  with a 15 s timeout. No tool calls the API the schema describes. Every tool carries
  `readOnlyHint: true, destructiveHint: false`, and the server sends `instructions` on connect that say so.
- **Short cache, explicit refresh.** A stale schema looks authoritative, which makes it worse than none.
  Concurrent tool calls share one download.
- **Errors the model can act on.** Misses return `isError: true` with suggestions: same path with other
  methods, then operations with the requested method, singular and plural path forms tried.
- **Context budget.** Output is capped at 20 000 characters with a hint on how to narrow the request.
  `diff_payload` returns only the problems, not the schema.
- **Logic separate from protocol.** `spec.ts`, `operations.ts` and `diff.ts` know nothing about MCP and are
  tested directly; `server.ts` only wires them to tools.
- **Not a full JSON Schema validator.** `diff_payload` covers what breaks requests in practice. `allOf` is
  merged, `oneOf`/`anyOf` pass if any variant matches (otherwise the closest variant is reported).
  Formats, `min`/`max`, patterns and remote `$ref`s are not checked. Swagger 2.0 and YAML are not supported.

## Tests

```sh
npm test          # 36 unit and protocol tests (vitest)
npm run smoke     # starts dist/index.js over stdio and calls every tool against a real schema
```

`test/server.test.ts` talks to the server through the MCP protocol in memory, so it checks what an agent
actually sees: tool list, annotations, argument validation, recoverable errors.

## Evals

Unit tests show the code is right. They do not show that a model picks the right tool, because that depends
on tool names, descriptions and server instructions. `evals/` measures exactly that.

- Nine scenarios in [`evals/cases.ts`](evals/cases.ts), each a question a developer would ask:
  resolving a docs anchor, debugging a 400, a `oneOf` payload, a wrong path, a required header, refreshing
  after a deploy, and a request to delete a user (guardrail).
- Each run starts Claude Code headless with **only** this server: built-in tools disabled, user settings,
  CLAUDE.md and other MCP servers ignored, no hints in the prompt.
- Each scenario is graded on the **trajectory** (the expected tools called in order, with the expected
  arguments) and the **answer** (required facts present, forbidden claims absent).

```sh
npm run eval -- --model haiku --repeat 3      # uses the logged-in Claude Code account, no API key
```

Results with Claude Haiku 4.5:

| | Passed | Trajectory | Answer |
|---|---|---|---|
| First run | 6/9 (67%) | 78% | 89% |
| After changing descriptions and adding server instructions, 3 runs per case | **26/27 (96%)** | 96% | 96% |

What the evals changed:

1. Asked to debug a 400 with a concrete payload, the agent read the schema and compared by hand instead of
   calling `diff_payload`. The answers were right on small bodies, but that does not scale. Fix: routing
   sentences in both descriptions ("if you already have a concrete payload, call `diff_payload`").
2. Asked to delete a user, the agent offered to "construct and send the DELETE", although the server cannot
   reach the API and the schema has no such operation. Fix: server `instructions` stating the tools are
   read-only and telling the agent to check whether an operation is documented at all.
3. The agent quoted `/users/{id}` for `/users/{id}/`. For Django-style backends that is a redirect or a 404.
   Fix: `get_request_schema` adds a note when a path ends with a slash. The eval stays strict on this.

The remaining failure is real: in one of three runs the agent refused the delete correctly but did not check
the schema and mentioned a `DELETE /users/{id}` that does not exist.

Two grader bugs were fixed along the way, both where the agent had behaved correctly and a regex did not
recognise the wording. Regex graders are brittle for meaning; an LLM judge would be the next step. The
rule I followed: a grader may only be loosened when the transcript shows the agent was right.

Raw transcripts of every run are in [`evals/results/`](evals/results).

## Project layout

```
src/
  spec.ts         loading, caching, $ref resolution
  operations.ts   endpoint search, request and response contracts, suggestions
  diff.ts         payload vs schema
  server.ts       MCP tools and server instructions
  index.ts        stdio entry point
test/             vitest, fixture schema with the tricky cases
evals/            agent-level scenarios and runner
scripts/smoke.ts  stdio smoke test
```

## License

MIT
