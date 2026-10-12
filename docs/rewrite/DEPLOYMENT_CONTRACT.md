# Existing-server deployment and cutover

The user requests the existing server and Cloudflare deployment approach. Read-only
inspection on 2026-10-12 found a user-managed CourseForge service and a cloudflared
Quick Tunnel targeting `http://127.0.0.1:8000`. Public and local root pages returned
the same legacy HTML. Keep that service authoritative throughout staging work.
Observed host architecture is aarch64, with 4 reported CPU threads and roughly 23.4 GiB
host memory. These observations do not establish dedicated CPU, network bandwidth,
budget, provider geography or 10,000-learner capacity.

Cloudflare documents Quick Tunnels as temporary development/testing access, with
no uptime guarantee, a 200 in-flight request ceiling, no SSE, and a hostname change
when recreated. The ceiling counts requests, not enrolled users. Long media ranges
also occupy it. A 10k correctness/load result on a loopback simulator cannot prove
the complete deployment through this Quick Tunnel.
Source: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), checked 2026-10-12.

The current URL can continue serving previews while its existing tunnel stays
running. Production release should use a configured Cloudflare Tunnel and stable
hostname on the same server; cloudflared is ingress, not additional origin compute.
If the exact current Quick Tunnel must remain the release ingress, its documented
limitations remain failed production/10k gates. Do not silently replace the URL or
promise that Go removes ingress/provider/network limits.

The replacement topology is static TypeScript assets behind one same-origin reverse
proxy, Go application replicas, separate Go media gateways, PostgreSQL, bounded Go
job coordinators and isolated model/lab adapters. `/api/v1/playback/sessions/{id}/media`
routes to media; other `/api/` routes go to the application. Media credentials and
provider URLs never reach clients. Private API/media tokens stay out of proxy logs
and shared caches. Configure the HTTPS public origin and secure cookies together.

`compose.rewrite.yaml --profile app` describes the loopback development topology.
Web is port18096, API18090, PostgreSQL15439; media is internal to Compose. For the
current terminal-managed tests, Vite5173 proxies API18090; standalone media18094
and realistic simulator18092 are separate. Container media simulator configuration
must use an address reachable from its container, not host127.0.0.1. An empty
provider configuration does not certify playable Odysee lessons.

Prepare production configurations separately from these synthetic defaults. Budget
all replica pools together; the Compose development foundation starts with 24 API
connections plus 8 gateway connections, excluding workers/operations. These values
are experiments. Do not copy development registration settings, credentials or
simulator endpoints into public production configuration.

Before routing the existing tunnel to the new proxy, demonstrate full parity,
typed SQL/artifact/vector migration, preserved learner/provider ownership, Odysee
lesson opening and failure recovery, device checks, capacity and backup/post-write
recovery on the chosen topology. Freeze legacy writes and drain old workers, verify
the final snapshot/import, then switch the loopback origin during a rehearsed
maintenance window. Keep tunnel changes separate from application state migration.
Require sign-in after session invalidation. Rollback before new writes may restore
legacy routing; after new writes, use the proven replay/fix-forward recovery path.

No production service, tunnel, database or learner account has been replaced by
the additive rewrite stack. User authorization covers cutover once the agreed
readiness gates pass; current partial slices do not satisfy that condition.
