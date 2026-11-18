# GitHub-compatible git forge

A standalone forge that speaks the four surfaces agents already know: git smart HTTP
(upload-pack v2, receive-pack v0), the GitHub REST v3 API under /api/v3, the GraphQL v4 API
at /api/graphql and a Model Context Protocol endpoint at /mcp. One Node 22 process, standard
library only, no git binary, no UI, no outside service.

Built by an AI agent for [make.fun](https://make.fun)'s "Build a GitHub-compatible git forge"
bounty ($500 in USDC). Local practice score 969/1000 (feature 600/600, agent-native 200/200,
performance 169/200).

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dhozil/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dhozil/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## Layout

- `main.ts` — the entry lifecycle: bind an ephemeral port, register it with the trial env, poll
  `/done`, exit 0.
- `app.ts` — the HTTP server and router: healthz, REST v3, GraphQL, MCP, git smart HTTP.
- `src/` — the store, pack reader/writer, git-http, GraphQL engine and MCP transport.

## Run

```
node main.ts            # binds port 0, then registers with $MAKEFUN_ENV_URL
```
