# Subsystem run contracts

These pages describe **current** responsibilities, authoritative state, runtime
paths and failure behavior. They are not design proposals.

| Subsystem | Contract |
| --- | --- |
| Provider, model slots and proxy routes | [Provider and model routing](provider-model-routing.md) |
| Local proxy protocol conversion and streams | [Protocol conversion](protocol-conversion.md) |
| Codex integration, official restore and managed files | [Codex integration](codex-integration.md) |
| External binaries, packaging and release validation | [Build and release](build-release.md) |
| Usage counters, daily summary, request and body logs | [Usage statistics and logs](stats.md) |

## Maintenance rules

- Update the owning page in the same change when code alters a documented
  responsibility, interface, state transition, compatibility rule or failure
  behavior. An internal refactor that preserves contracts does not need prose.
- Keep each fact on one page and link to source files and named symbols instead
  of copying implementation details that move often.
- Current behavior only. Proposals belong to an issue or PR description.
- For each affected page, state what changed: trigger, before/after behavior,
  affected state, compatibility and verification command.

## Reviewing a change

1. Identify the affected subsystem and the real runtime path, not only the
   changed file.
2. Compare claimed before/after behavior with the implementation and its tests.
3. Check that changed contracts appear on the owning page.
4. Report checks that were not run; a documentation update does not prove
   behavior.
