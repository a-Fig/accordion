<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/logo-lockup-white.png">
  <img alt="Accordion" src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/logo-lockup-black.png" width="440">
</picture>

### /compact is the naive solution. Accordion is the intelligent one.

**See everything your AI agent holds in context — and fold it like an accordion instead.**

<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/accordion-hero.gif" alt="Accordion — the context map demo: blocks folding and unfolding while the protected tail stays intact" width="820">

</div>

---

Accordion is a [pi](https://github.com/earendil-works/pi) extension that shows you your
agent's entire context window at a glance and lets you manage it — manually or with
intelligence through a **conductor**.

This package ships the **pi extension** (the live link that streams context and applies
your fold plan) plus a **browser-served UI**, so you can run Accordion with `pi install`
alone — no Rust, no desktop app required.

## Install

```bash
pi install npm:@a-fig/accordion
```

That adds the package to `~/.pi/agent/settings.json`. Restart pi, then in any project:

```bash
/accordion
```

The extension HTTP-serves the Accordion UI on a local ephemeral port and prints the URL
(also opens it). The page auto-connects to the running session. Folding is **off by
default** — flip the **Folding** toggle in the header to start steering what the agent
sees.

> **Single session, browser only.** This package serves the UI in your browser for the
> current pi session. For multi-session discovery, conductors that need local model
> resources, and the native window, build the
> [desktop app](https://github.com/a-Fig/Accordion) from source.

## How it works

The **context Map** is the whole window at a glance: one square per block, sized by token
weight (a dice face, 1–6), colored by kind — **user** messages, **assistant** responses,
**thinking**, **tool calls**, and **tool results** each get their own hue. Bright = live;
recessed and hatched = folded.

Three hands share the controls:

- **You** — fold, unfold, pin, and peek by hand. Your overrides always win.
- **The agent** — reaches back to unfold or pin context it needs mid-task, or **recall**
  a folded block as a tool result (like `read_file`) without changing what's standing in
  context.
- **The Conductor** — an automatic strategy that, between turns, folds what's gone cold
  and unfolds what's becoming relevant. Collaborative by default; an *exclusive*
  conductor you approve can take over specific controls, and **detach** is always your
  kill switch.

Every block is **Full**, **Folded** (shown as a short tagged summary), or **Pinned**
(locked open). Folds are **content substitution, never removal** — provider-safe and
fully reversible. The most recent ~20k tokens are a **protected working tail** the agent
reasons over at full fidelity.

<div align="center">
<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/attention-conductor.png" alt="Attention conductor view — each block tinted by how much the working tail still attends back to it" width="600">
</div>

## Skills included

This package registers two pi skills the agent uses to interact with folded context:

- **accordion-context-folding** — the `unfold` tool: restore a folded block into standing
  context (sticky, attributed to the agent).
- **accordion-context-recall** — the `recall` tool: read a folded block's full content as
  a tool result *without* mutating the view, like `read_file`. Never lockable.

## What works today

- ✅ Browser-served UI — no desktop app required
- ✅ Live link to a running pi session
- ✅ Opt-in live steering — apply your fold plan to what the agent is shown
- ✅ Reversible, provider-safe folding with deterministic `{#code FOLDED}` digests
- ✅ Agent-driven unfold + `recall`, involvement locks
- ✅ The Conductor — automatic fold/unfold between turns
- ✅ LLM-generated summaries, computed once and cached

## Links

- **Source & full docs:** [github.com/a-Fig/Accordion](https://github.com/a-Fig/Accordion)
- **Vision:** [VISION.md](https://github.com/a-Fig/Accordion/blob/main/VISION.md)
- **pi (the harness):** [github.com/earendil-works/pi](https://github.com/earendil-works/pi)

---

<div align="center">

🏆 &nbsp;Built at the **AI Hackathon 2026 @ UC Berkeley** — a winning project.

🪗

</div>
