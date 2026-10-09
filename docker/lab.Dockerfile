FROM python:3.12.7-slim-bookworm
RUN pip install --no-cache-dir PyYAML==6.0.2
WORKDIR /workspace
# No shell entrypoint and no Docker CLI/socket are exposed inside the grader.
