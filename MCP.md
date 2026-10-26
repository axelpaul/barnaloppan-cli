# Local MCP setup

Requires Bun and a checkout of this repository. Run from the repository root:

```sh
bash scripts/setup-mcp.sh
```

The script installs dependencies and builds the executable, then prints a JSON
`mcpServers` configuration with its absolute path. Merge that entry into your
MCP client's configuration; do not replace other servers. Restart/reconnect the
client. It should complete initialization and list tools without signing in.

Authentication remains the CLI login flow described in README.md. Authenticate
on the same machine, as the same OS user that runs the MCP client. Never put
passwords, tokens or personal account data in the MCP configuration. Public
lookups need no account where the service supports them. Private reads require
a valid local session; successful initialization does not prove account access.

Writes are disabled by default. The tool list is the authoritative list of MCP
capabilities: some CLI actions are not exposed as MCP tools. Existing opt-in
write tools require their documented startup flag/environment and confirmation.
Do not enable writes merely to test connectivity.

This is a source-build setup, not a claim of published cross-platform release
binaries. Verified platforms and live account results are reported separately.

## Verify the built server

```sh
bun run verify:mcp
```

This checks the compiled executable (`--version` and `serve`), MCP initialization,
discovery and tool metadata in both default and explicit write-opt-in modes, using
an isolated temporary configuration directory. It makes no account API calls
and invokes no write tools. A live account read should then
be tested in your client; expired sessions are not protocol failures.
