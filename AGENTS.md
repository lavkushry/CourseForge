# CourseForge working guidance

For the Go backend, TypeScript player, Odysee integration, concurrency or rewrite
migration, read `docs/GO_TYPESCRIPT_REWRITE_PLAN.md` first. Read
`docs/GO_TYPESCRIPT_CAPACITY.md` before setting performance defaults, running load
tests or claiming learner capacity. Read `docs/GO_TYPESCRIPT_AGENTS.md` when assigning
parallel implementation work or choosing project skills.

Preserve existing uncommitted work. Use synthetic fixtures or isolated snapshots for
tests; do not create load-test accounts in production. Keep Odysee credentials out of
browser responses and logs. Preserve learner isolation and playback ownership.

The 10,000-concurrent-learner figure is a target until scoped measurements prove it.
Report API capacity, media delivery and AI job throughput separately.
