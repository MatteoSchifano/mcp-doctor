# mcp-doctor

**Point it at an MCP endpoint. It tells you what's broken and how to fix it.** One command, clean exit codes, nothing to install.

```bash
npx mcp-doctor-cli https://mcp.example.com/mcp
```

> The npm package is **`mcp-doctor-cli`** — the plain `mcp-doctor` name belongs to an unrelated tool that diagnoses *client* configuration. The command it installs is `mcp-doctor`.

---

## The problem

Debugging an MCP server today goes like this: read the client logs, read the nginx logs, try some curl, guess. There are only a handful of ways it fails — but the user sees the same message every time, *"failed to connect"*, no matter what actually went wrong.

| What actually happened | What the user sees |
|---|---|
| The reverse proxy has no location block for the MCP path | failed to connect |
| OAuth flow started and never completed, or the token expired | failed to connect |
| Client and server speak different protocol revisions | failed to connect |
| The server logs to stdout and corrupts the JSON-RPC channel | failed to connect |
| Tools have invalid schemas or duplicate names | the model just never uses them |

Each of these is trivial to diagnose *if you know where to look*, and costs half an hour if you don't. `mcp-doctor` knows where to look.

## The two eras of the protocol

Revision **2026-07-28** is the largest change since the protocol launched. It removes the `initialize` handshake and protocol-level sessions: every request becomes self-contained, carrying the protocol version, client identity and capabilities in `_meta`. It adds the `Mcp-Method` and `Mcp-Name` headers for gateway-side routing, the `server/discover` method, and `ttlMs` / `cacheScope` on list results.

The previous finalized revision is **2025-11-25** — the one with the handshake and `Mcp-Session-Id`.

For the next few months the ecosystem lives in both eras at once, and a modern client talking to a legacy server fails in a way that is indistinguishable, from the outside, from a network problem. Detecting the era is not trivial: you try the modern request and, on a `400 Bad Request`, inspect the body before deciding whether to fall back — because modern servers also use `400` for legitimate errors like an unsupported version or a missing capability.

`mcp-doctor` encapsulates that logic. It's in [`src/probe/http-probe.ts`](src/probe/http-probe.ts), function `detectEra`.

## What the output looks like

```
  mcp-doctor  https://mcp.example.com/mcp

  TRANSPORT
  ✓ DNS + TLS              valid certificate, expires in 61 days
  ✓ endpoint reachable     200 in 84ms
  ✓ path routing           POST /mcp routed correctly

  PROTOCOL
  ✓ era detected           modern (stateless, no handshake)
  ✓ version                2026-07-28
  ⚠ routing headers        Mcp-Name missing from responses
    → Gateways use Mcp-Method and Mcp-Name to route without reading
      the body.
  ✓ server/discover        responds, 12 tools declared

  AUTH
  ✗ OAuth discovery        /.well-known/oauth-protected-resource → 404
    → Clients cannot discover the authorization server. Expose the
      metadata document, or the flow dies before the token request.
  ✓ 401 challenge          WWW-Authenticate present and well-formed

  TOOLS
  ✓ tools/list             12 tools, all with a valid inputSchema
  ⚠ descriptions           3 tools with no description
    → To write: search_docs, get_item, list_all
  ⚠ annotations            no tool declares readOnlyHint
  ✗ names                  duplicate names: "search" ×2

  2 errors, 3 warnings
```

Every failing line carries a **remediation**, not just a diagnosis. That's the difference between a linter that helps and one that only complains.

## Commands

```bash
mcp-doctor <url>                            # shorthand for "check"
mcp-doctor check <url>                      # remote server (Streamable HTTP)
mcp-doctor check --stdio -- node dist/server.js
mcp-doctor check <url> --json               # machine-readable, for CI
mcp-doctor check <url> --auth-token $TOK    # with a credential
mcp-doctor migrate <url>                    # 2026-07-28 readiness report
mcp-doctor watch <url>                      # poll while a deploy comes up
mcp-doctor list-checks                      # catalogue of checks
```

### `migrate`

Takes a server and produces the delta towards revision 2026-07-28:

```
  mcp-doctor migrate  https://mcp.example.com/mcp

  Current server: legacy (2025-11-25) era

  TO DO
  ✗ handshake        drop initialize/notifications-initialized; read
                     protocolVersion and capabilities from _meta on every
                     request
  ✗ sessions         Mcp-Session-Id no longer exists. 4 tools look like they
                     depend on session state → convert them into explicit
                     handles passed as arguments
  ✗ server/discover  not implemented
  ⚠ headers          accepts requests without Mcp-Method
  ⚠ cache            list results without ttlMs / cacheScope

  Compatible with modern clients: no
  Estimated effort: medium
```

The "tools that depend on session state" count is a heuristic over names and descriptions, and it says so: it's a hint about where to look, not a verdict.

## Exit codes

| Code | When |
|---|---|
| `0` | all clear, or `info` only |
| `1` | warnings present — **only** with `--strict` |
| `2` | at least one error |

## Options

| Option | Effect |
|---|---|
| `--json` | machine-readable output, with headers and credentials redacted |
| `--strict` | warnings become exit code 1 |
| `--auth-token <tok>` | bearer credential (or set `MCP_DOCTOR_TOKEN`) |
| `--no-auth` | skip the OAuth checks on a knowingly public server |
| `--disable <id,...>` | disable checks by id or category (`tools.*`) |
| `--timeout <ms>` | per-request timeout, default 10000 |
| `--interval <s>` | `watch` interval, default 10 |
| `--iterations <n>` | number of `watch` rounds, `0` = forever |
| `--verbose` | show skipped checks too |

## Checks

| Category | Check | Severity |
|---|---|---|
| Transport | DNS, TLS, certificate expiry | error / warn |
| Transport | Endpoint reachable, latency | error / warn |
| Transport | Path routing (the missing `location` block) | error |
| Transport | CORS for browser-originated requests | warn |
| Protocol | Era detection (modern vs legacy) | info |
| Protocol | Version negotiation, known revision | error |
| Protocol | `Mcp-Method` / `Mcp-Name` header conformance | warn |
| Protocol | `server/discover` present and consistent with `tools/list` | warn |
| Protocol | JSON-RPC validity of error responses | error |
| Protocol | `Mcp-Session-Id` residue on modern servers | warn |
| Auth | OAuth protected resource metadata | error |
| Auth | Authorization server metadata reachable | error |
| Auth | `WWW-Authenticate` on the 401 | error |
| Auth | Required vs declared scopes | warn |
| Auth | Anonymous access on a server that advertises OAuth | error |
| Tools | Valid `inputSchema` (well-formed JSON Schema) | error |
| Tools | Duplicate or non-conforming names | error |
| Tools | Missing or too-short descriptions | warn |
| Tools | Missing annotations (`readOnlyHint`, `destructiveHint`) | warn |
| Tools | `outputSchema` missing where there is structure | info |
| stdio | Non-JSON output on stdout (the silent killer) | error |
| stdio | Process exits non-zero at startup | error |
| Cache | `ttlMs` / `cacheScope` on list results | info |

`mcp-doctor list-checks` prints the live list, generated from the registry.

## Configuration

The quality checks ("description too short") are **opinion, not spec**. They are all warnings, never errors, and every one of them can be switched off from `.mcp-doctor.json` in your project root:

```json
{
  "disabled": ["tools.output-schema", "transport.cors"],
  "minDescriptionLength": 30,
  "certWarnDays": 21,
  "slowMs": 1500
}
```

## In CI

```yaml
- name: Validate the freshly deployed MCP server
  run: npx mcp-doctor-cli check ${{ env.MCP_URL }} --json --strict
  env:
    MCP_DOCTOR_TOKEN: ${{ secrets.MCP_TOKEN }}
```

A ready-to-copy workflow lives in [`.github/workflows/mcp-doctor.yml`](.github/workflows/mcp-doctor.yml).

## Security

- The tool takes tokens as input. **It never logs them**, not even in verbose mode.
- `--json` output goes through a final redaction pass over the entire serialized payload: a safety net for the case where a new check accidentally drops a credential fragment into its structured data.
- **No side effects on the server under test**: discovery, list, and deliberately invalid requests only. `mcp-doctor` never calls a tool. That's a security constraint, not a limitation to be lifted later.

## Positioning

MCP Inspector is the official tool, but it's an interactive GUI for exploring: it isn't scriptable, it has no exit code, and it doesn't tell you *why* something is broken — it shows you and stops there.

`mcp-doctor` fills the complementary space: non-interactive, scriptable, exit-code driven. It is not an interactive MCP client, it does not execute tools, and it is neither a proxy nor a gateway.

## Architecture

```
src/
  protocol.ts        every protocol constant, isolated in one module
  transport/         bare fetch, plus a minimal stdio client
  probe/             one network pass, producing the evidence
  checks/            pure (context) => Result[] functions, registered in index.ts
  report/            human and JSON rendering
  commands/          check, migrate, watch
```

Two choices worth explaining:

**Checks never touch the network.** All collection happens in the probe phase; each check is a pure function over the resulting evidence. That makes checks testable against synthetic evidence, makes the catalogue generatable from the registry, and means adding one never touches the core.

**No runtime dependencies.** The tool has to run in a minimal CI, and the low-level checks have to be done with bare `fetch`: an SDK abstracts away exactly the errors you need to diagnose here — the proxy's 404, the 400 with a meaningful body, the missing headers. The only dependencies are `typescript` and `@types/node`, both dev-only.

## Development

```bash
npm install
npm test          # tests against fixture servers that break on purpose
npm run typecheck
npm run build
```

The most valuable tests are the fixtures in [`test/fixtures/`](test/fixtures/): one server per failure mode — reverse proxy with no location block, a legacy server that demands the handshake, tools with duplicate names, OAuth advertised but not enforced, an stdio server that logs to stdout. Every newly diagnosed failure mode should land here before it lands in the code.

## Sources

- MCP blog, 2026-07-28 release candidate: <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>
- Specification, Streamable HTTP transport: <https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http>

## License

MIT
