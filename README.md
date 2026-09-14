<h1 align="center">ChatGPT Web + Codex</h1>

<p align="center">
  <strong>Two quotas, one workflow.</strong><br>
  ChatGPT Web (Sol / High) plans and reviews. Codex (Luna) writes the code.
</p>

<p align="center">
  <a href="TROUBLESHOOTING.md">Troubleshooting</a> · <a href="SECURITY.md">Security</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="#resumo-em-português">Português</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
</p>

> [!IMPORTANT]
> Unofficial, independent software. Not affiliated with or endorsed by OpenAI. "ChatGPT" and
> "Codex" are OpenAI trademarks and are used here only to describe compatibility.

## The idea

A ChatGPT subscription and Codex each come with their own usage allowance. Running a high-effort
model for everything burns through one of them fast. This project splits the work so each quota
does what it is best at:

| Role | Model | Runs through | Spends |
| --- | --- | --- | --- |
| **Architect and reviewer** | Sol / High | ChatGPT Web, driven by a local bridge | ChatGPT subscription |
| **Implementer** | Luna / Max | a native Codex subagent | Codex quota |

```text
You ──▶ Codex ──▶ bridge ──browser──▶ ChatGPT Web (Sol / High)
                                          │  plans, writes the spec, reviews the diff
                                          │
                                          └──spawn_agent──▶ Codex subagent (Luna / Max)
                                                                 writes the code
```

Sol does not implement by default. It writes a complete specification, hands it to Luna, reviews
the actual diff, and sends Luna back to fix what it finds. Sol takes over only when Luna reports the
work as too complex or still fails verification after a corrected attempt.

**One measured run** (a "back to top" button added to a three.js landing page, with a prompt that
never mentioned delegation):

| Session | File writes | Output tokens |
| --- | --- | --- |
| Sol (ChatGPT Web) | 0 | 3,000 |
| Luna, implementation | 2 | 13,037 |
| Luna, fix requested by Sol's review | 1 | 3,935 |

Luna produced about 85% of the generated tokens, and most of its input came from prompt cache. On
an earlier run, a complete landing page moved the Codex 5-hour allowance by 1%. Treat these as
single observations, not benchmarks.

## What this adds

This project is built on the MIT-licensed `codex-chatgpt-web` bridge (see [License](#license)) and
adds three capabilities on top of it:

- **Context over MCP.** Instead of pasting the task context into ChatGPT across several staged
  messages, the bridge stages it once and ChatGPT pulls it with the `codex_context_fetch` tool.
  One short message replaces the typed multi-part transfer.
- **Durable per-thread memory.** Every turn is indexed into a local SQLite FTS5 store. When Codex
  compaction drops history from the live window, ChatGPT can still recover it with
  `codex_memory_search` and `codex_memory_get`. Memory is scoped per thread.
- **Automatic delegation.** The routing rule lives in the bridge's top-level transport contract, so
  Sol delegates implementation to Luna on every file-changing request without being asked.

## Requirements

- A ChatGPT account that exposes **Sol / High** (Plus or higher).
- Codex with available quota for the Luna subagent.
- The [Sol Advisor](https://github.com/DannyMac180/sol-advisor) plugin, which installs the
  `sol_advisor_luna_implementer` agent role (`gpt-5.6-luna`, effort `max`).
- Full harness mode (OpenAI tunnel + ChatGPT connector), described below.

## Quick start

> [!NOTE]
> The first release of this repository has not been published yet. Until it is, run from source.
> The one-line installers below will work once a release exists.

**Run from source** (requires Bun 1.4.0):

```bash
git clone https://github.com/oapache/chatgpt-web-codex.git && \
cd chatgpt-web-codex && \
bun run app
```

**Installers** (after the first release):

```bash
curl -fsSL https://github.com/oapache/chatgpt-web-codex/releases/latest/download/install-launcher.sh | sh
```

```powershell
irm https://github.com/oapache/chatgpt-web-codex/releases/latest/download/install-launcher.ps1 | iex
```

Then, in the launcher:

1. Sign in inside the launcher's embedded ChatGPT browser.
2. Run the browser smoke test.
3. Press **Install models**, restart Codex once, and select **ChatGPT + Codex High**.

## Full harness setup

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound only.

1. Open **MCP** in the launcher, create the Tunnel and a regular API key, then press
   **Connect harness**.
2. In ChatGPT, enable **Developer Mode** and create a new Tunnel connector named exactly
   **Codex Native3**, with **Authentication: None**.
3. Set the connector's permissions to **Allow all actions**. The lower-risk setting blocks command
   and patch calls before they reach Codex.
4. Run **Verify runtime**.

ChatGPT caches a connector's tool list by its identity. Do not rename or refresh an older
`Codex Native` or `Codex Native2` connector; create `Codex Native3` as a new one so the context,
memory, and delegation tools are visible.

## Enabling the two-quota workflow

Set both environment variables for your user account, then restart the launcher:

```powershell
setx CODEX_CHATGPT_WEB_CONTEXT_VIA_MCP 1
setx CODEX_CHATGPT_WEB_DELEGATE_IMPLEMENTATION 1
```

```bash
export CODEX_CHATGPT_WEB_CONTEXT_VIA_MCP=1
export CODEX_CHATGPT_WEB_DELEGATE_IMPLEMENTATION=1
```

In Codex, use `chatgpt-web/high` as the model and `gpt-5.6-luna` as the subagent model:

```toml
model = "chatgpt-web/high"
model_reasoning_effort = "high"

[agents]
default_subagent_model = "gpt-5.6-luna"
max_depth = 2

[features]
multi_agent = true
```

If you keep global Codex instructions in `~/.codex/AGENTS.md`, remember that subagents load them
too. Any "always delegate" rule placed there must tell subagents to implement directly, or Luna will
try to delegate to another Luna.

## How delegation works

For a request that changes files, Sol:

1. writes a worker specification (objective, files and ownership, interfaces, constraints,
   verification);
2. loads the subagent tools with `tool_search`, as a call of its own;
3. calls `multi_agent_v1__spawn_agent` with `agent_type: sol_advisor_luna_implementer`;
4. polls `multi_agent_v1__wait_agent` every 30 seconds until Luna finishes;
5. inspects the diff and reruns verification, then asks Luna for fixes if needed.

Known constraints the bridge already handles:

- `spawn_agent` is a deferred tool: it becomes callable only after the `tool_search` result returns.
- ChatGPT's tool filter can block tool arguments containing absolute Windows paths, so the
  specification uses workspace-relative paths.
- On Windows the Codex sandbox cannot read `~/.codex`, so Sol Advisor's installer preflight always
  fails there. The spawn result's role, model, and effort are used as the check instead.
- Each MCP tool call has a 90-second deadline, below the tunnel's own limit. Long commands should run
  as a background session and be polled.

## Modes

| Mode | Local Codex tools | Extra setup |
| --- | --- | --- |
| **Browser-only** | No; Codex shows a warning | None |
| **Full harness** | Yes, for every effort the account exposes | OpenAI tunnel + `Codex Native3` connector |
| **Zero Risk** | Yes; you paste and send each prompt yourself | Separate tunnel + `Codex Zero Risk` connector |

Context via MCP, durable memory, and automatic delegation require **Full harness** in automatic
mode. Zero Risk never reads or changes the ChatGPT page, so none of them apply there.

## Limitations and security

- This is browser automation of ChatGPT Web, not an OpenAI API. ChatGPT UI changes can break it;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Use a trusted workstation and never share the launcher profile.
- The memory database stores conversation text and tool output locally in
  `~/.codex-chatgpt-web/memory/`. Treat it as sensitive.
- Temporary Chat is a ChatGPT privacy mode, not local-only inference: prompts are still processed by
  OpenAI under your account's settings. You are responsible for complying with OpenAI's
  [Terms of Use](https://openai.com/policies/terms-of-use/) and your workspace policies.
- Builds are not platform-signed yet, so Gatekeeper or SmartScreen may warn.

Read the [architecture](docs/architecture.md) and [security model](docs/security-model.md) before
enabling full mode. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Development

```bash
bun run app
bun run dev:launcher
bun run verify
bun run app:package
```

`dev:launcher` runs a second, isolated launcher profile under `~/.codex-chatgpt-web-dev` with its own
browser login, configuration, broker, and tunnel, using the connector name `Codex Native3 DEV`.

When running the test suite on a machine where the two environment variables are set, unset them
first; they change the compiled prompt and would make contract tests fail:

```bash
env -u CODEX_CHATGPT_WEB_CONTEXT_VIA_MCP -u CODEX_CHATGPT_WEB_DELEGATE_IMPLEMENTATION bun test ./tests
```

- [Architecture](docs/architecture.md)
- [DEV chat harness](docs/dev-chat.md)
- [Security model](docs/security-model.md)
- [Troubleshooting](TROUBLESHOOTING.md)

## Resumo em português

**ChatGPT Web + Codex** usa as duas cotas ao mesmo tempo. O **Sol / High** roda pelo ChatGPT Web,
consumindo a assinatura do ChatGPT, e fica com o trabalho de arquiteto: entende o pedido, escreve a
especificação e revisa o diff. A **Luna / Max** roda como subagente nativo do Codex, consumindo a
cota do Codex, e escreve o código. O Sol só implementa quando a Luna devolve a tarefa como complexa
demais ou ainda falha depois de uma correção.

Além disso, o contexto da tarefa vai para o ChatGPT por uma tool MCP (em vez de ser colado em várias
mensagens), e cada turno fica salvo numa memória local por conversa, que sobrevive à compactação do
Codex. Para ativar, veja [Full harness setup](#full-harness-setup) e
[Enabling the two-quota workflow](#enabling-the-two-quota-workflow).

## License

MIT. This project is derived from `codex-chatgpt-web`, and its original copyright notice is kept in
[LICENSE](LICENSE) as the MIT license requires. Third-party notices for bundled components are in
[LICENSES](LICENSES).
