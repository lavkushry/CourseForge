# P1 Step 5 — Practical lab catalog and safety

Eight curated labs are available through **Labs**. Five new tracks: SQL, PySpark, Dockerfile, Ansible, and backend request handlers. Older Python, shell and Kubernetes labs remain unchanged.

| Track | Grading | Execution |
|---|---|---|
| SQL | SQLite SELECT with read-only authorizer, hidden in-memory datasets, grouping/sort assertions | In restricted Docker |
| PySpark | Local Spark DataFrame filtering and aggregation over two fixtures | Separate Java + PySpark Docker image |
| Docker | Dockerfile source rules: pinned base, non-root user, exposed port, healthcheck, unsafe patterns | Static parsing inside Docker, no docker build |
| Ansible | YAML parse, declarative nginx package/service tasks and forbidden imperative modules | Static YAML checks inside Docker, no ansible-playbook execution |
| Backend | Python HTTP-style request handler and input-validation fixtures | Hidden tests inside restricted Docker |

## Local setup
```sh
docker build -f docker/lab.Dockerfile -t courseforge-lab:local .
docker build -f docker/lab-spark.Dockerfile -t courseforge-lab-spark:local .
python -m pytest -q
python scripts/lab_smoke.py
python scripts/lab_smoke.py --spark
```

Containers run without external networking, Docker socket, production kubeconfig, capabilities or privilege escalation, and with read-only source mounts. Spark allows up to 2 GiB and 2 CPUs with a 120-second outer timeout, while standard labs use the existing 256 MiB budget. These constraints reduce risk but are not a hardened multi-tenant security boundary. Use only on a trusted personal workstation; do not expose lab submission endpoints publicly.

Static rules are heuristic. They cannot establish Docker build success, actual Ansible idempotence, or network/service behavior. The separate PySpark image needs validation on your machine; regular CI does not build or execute it.
