# Superagent

This branch runs an independent Node HTTP service and the existing React dashboard. Paseo manages the main, worker and child conversations through Agent Profiles. Each Superagent instance monitors its own repository. [Deployment](docs/006-deployment.md)

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

Superagent is a proactive coding agent for one GitHub or GitLab repository. It listens to GitHub, GitLab, Feishu, DingTalk and selected local Paseo conversations. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

### Answering a Paseo ticket

Questions and usable results return to the Paseo conversation that started the ticket. Answer a question in that same conversation with `回复工单 <first 8 characters of the ticket ID>：<your answer>`. The answer continues that ticket; ordinary conversation still follows the existing admission policy. Wrong, ambiguous or closed ticket references are refused rather than creating another ticket. Outstanding questions in this installation remain in its durable outbox. A new standalone state does not import the former application history.

Execution uses the same-machine Paseo endpoint configured in the standalone JSON file, normally `127.0.0.1:6767`. The optional Paseo Source defaults to that endpoint too. Supply any Paseo password through `PASEO_PASSWORD` or `PASEO_PASSWORD_FILE`; the panel password uses `SUPERAGENT_PASSWORD` or `SUPERAGENT_PASSWORD_FILE`. Notification delivery uses a stable Paseo message ID; failures remain in the outbox for retry. The receiving Paseo agent is asked to display the notification without executing or answering it, and notification messages are excluded from human intake.

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, tests and both builds. `pnpm start --config /absolute/path/superagent.json` starts the service; `scripts/superagent start --config /absolute/path/superagent.json` supervises a local background instance. Do not point it at an old DSH state.

Select the assessor and executor Agent Profiles in the panel. Superagent saves the choices in the instance SQLite database. Each managed conversation can use the application tools through `superagent-tool`.

## License

[MIT](LICENSE)
