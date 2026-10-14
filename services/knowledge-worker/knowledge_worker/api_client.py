"""HTTP client for Go knowledge worker endpoints."""

from __future__ import annotations

from typing import Any

import httpx


class KnowledgeAPI:
    def __init__(self, base_url: str, token: str, timeout: float = 60.0) -> None:
        self._base = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self._base,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    def close(self) -> None:
        self._client.close()

    def claim(self, worker_id: str, lease_seconds: int) -> dict[str, Any] | None:
        response = self._client.post(
            "/api/v1/knowledge/worker/claim",
            json={"worker_id": worker_id, "lease_seconds": lease_seconds},
        )
        if response.status_code == 503:
            return None
        response.raise_for_status()
        return response.json()

    def heartbeat(self, job_id: str, worker_id: str, fence: int, lease_seconds: int) -> None:
        response = self._client.post(
            f"/api/v1/knowledge/worker/jobs/{job_id}/heartbeat",
            json={"worker_id": worker_id, "fence": fence, "lease_seconds": lease_seconds},
        )
        response.raise_for_status()

    def store_ingest(self, job_id: str, worker_id: str, fence: int, ingest: dict[str, Any]) -> dict[str, Any]:
        response = self._client.put(
            f"/api/v1/knowledge/worker/jobs/{job_id}/ingest",
            json={"worker_id": worker_id, "fence": fence, "ingest": ingest},
        )
        response.raise_for_status()
        return response.json()

    def complete(self, job_id: str, worker_id: str, fence: int, result: dict[str, Any] | None = None) -> None:
        response = self._client.post(
            f"/api/v1/knowledge/worker/jobs/{job_id}/complete",
            json={"worker_id": worker_id, "fence": fence, "result": result or {}},
        )
        response.raise_for_status()

    def fail(self, job_id: str, worker_id: str, fence: int, error_code: str, retry: bool = True) -> None:
        response = self._client.post(
            f"/api/v1/knowledge/worker/jobs/{job_id}/fail",
            json={
                "worker_id": worker_id,
                "fence": fence,
                "error_code": error_code,
                "retry": retry,
            },
        )
        response.raise_for_status()
