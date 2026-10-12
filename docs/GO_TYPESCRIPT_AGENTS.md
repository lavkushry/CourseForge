# Go/TypeScript implementation workflow and skills

Updated 2026-10-11. See the [rewrite plan](GO_TYPESCRIPT_REWRITE_PLAN.md) for scope
and [capacity contract](GO_TYPESCRIPT_CAPACITY.md) for performance acceptance.

## Installed skills

Installed with the skill-installer helper into `/home/ubuntu/.codex/skills/`.
The skills are available for automatic discovery on the next user turn. Installation
adds agent instructions and resources; it does not install Go, browsers, k6 or runtime
dependencies, and it does not itself increase application capacity.

| Skill | Source | Intended use |
| --- | --- | --- |
| golang-concurrency | [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang/tree/8e899e20ff0cd4dc524af3993e4c62d8ee8c5717/skills/golang-concurrency) | Goroutine lifecycle, cancellation, bounded work and concurrency review |
| golang-benchmark | [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang/tree/8e899e20ff0cd4dc524af3993e4c62d8ee8c5717/skills/golang-benchmark) | Controlled Go benchmarks, profiling and comparative evidence |
| golang-performance | [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang/tree/8e899e20ff0cd4dc524af3993e4c62d8ee8c5717/skills/golang-performance) | Optimizing a measured bottleneck and remeasuring |
| playwright | [openai/skills](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/playwright) | Interactive browser verification and recorded playback evidence |

Pinned upstream revisions:

- Go skills: `8e899e20ff0cd4dc524af3993e4c62d8ee8c5717`.
- Playwright: `49f948faa9258a0c61caceaf225e179651397431`.

Selection considered source, content fit and adoption rather than installing an
entire catalog. At inspection, the Go repository had 3,445 stars; directory listings
showed about 38.6k concurrency, 36.5k benchmark and 38.7k performance installs.
The official OpenAI skills repository had 27,999 stars. These are dated discovery
signals, not correctness guarantees. Sources: [concurrency listing](https://www.skills.sh/samber/cc-skills-golang/golang-concurrency),
[benchmark listing](https://www.skills.sh/samber/cc-skills-golang/golang-benchmark),
[performance listing](https://www.skills.sh/samber/cc-skills-golang/golang-performance).

Use the existing codebase-design, diagnosing-bugs, behavior-validator and code-review
skills when their tasks apply. Verify version-specific claims and examples against
the pinned project toolchain and official documentation. Community numeric rules of
thumb are not CourseForge defaults or capacity evidence. Do not auto-install every
cross-referenced skill or tool.

## Agent roles

Use the available agent system; a second agent runtime is unnecessary. Two read-only
agents audited backend capacity and player migration for this plan. The following
roles are implementation assignments, not claims of installed persistent agents.
At most the coordinator plus three agents run concurrently in this environment.

| Role | Owns | Deliverable |
| --- | --- | --- |
| Coordinator | Contracts, migration order, shared schema decisions, integration | One coherent milestone with evidence and explicit remaining gaps |
| Backend agent | Assigned Go modules, SQL migrations/queries and integration tests | Working vertical slice, race/correctness results, query/pool observations |
| Player agent | Assigned TypeScript modules and browser behavior | Contract-compatible player, lifecycle/accessibility/media evidence |
| Verification agent | Independent behavior, authorization and capacity checks | Reproducible findings and scoped pass/fail report |

For migration-heavy milestones, rotate the player role into a data-migration role
after the player contract stabilizes. Run resource-intensive benchmarks serially.
Implementation can be parallel; measurements sharing hardware cannot.

## Working protocol

1. Read current git status, the milestone contract, and relevant existing tests.
   Preserve unrelated dirty files; use a task branch/worktree when edits would overlap.
2. Coordinator fixes shared request/response contracts and assigns disjoint file
   ownership. Only one agent owns a migration or shared generated contract at a time.
3. Each agent reports behavior changed, files touched, commands/results, assumptions
   and unresolved risks. No production restarts or external-provider stress tests
   are implied by an implementation assignment.
4. Verification crosses public module interfaces and actual browser flows. Include
   negative authorization cases, failure recovery and duplicate/concurrent writes.
   Compare against the prewritten contract, not source-string implementation details.
5. Coordinator resolves findings, integrates, and runs the milestone's appropriate
   checks. A performance claim must link workload, hardware and measured results.

M1's first handoff is auth/access/catalog/progress with a typed player contract;
this allows the player agent to work against deterministic fixtures while backend
and data work proceeds. Do not create 10,000 application agents to simulate learners;
use the dedicated load harness described in the capacity contract.
