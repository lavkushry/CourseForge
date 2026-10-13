#!/usr/bin/env python3
"""CourseForge AI Vector Indexer: Indexes transcript chunks into pgvector via hosted Ollama."""
import json
import os
import subprocess
import time
import urllib.request
import urllib.error

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")
PG_CONTAINER = "courseforge-rewrite-postgres-1"
DB = "courseforge_rewrite"
USER = "courseforge"


def get_embedding(text: str) -> list[float] | None:
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/embeddings",
        data=json.dumps({"model": MODEL, "prompt": text[:1000]}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("embedding")
    except Exception as e:
        print(f"Embedding error: {e}")
        return None


def run_psql(sql: str) -> str:
    cmd = ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", USER, "-d", DB, "-t", "-A", "-c", sql]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def run_psql_exec(sql: str) -> None:
    cmd = ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", USER, "-d", DB]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = proc.communicate(input=sql)
    if proc.returncode != 0:
        raise RuntimeError(f"psql error: {err}")


def index_batch(limit: int = 100) -> int:
    # Find chunks without embeddings
    query = f"""
    SELECT t.id, t.lesson_id, replace(replace(substring(t.text from 1 for 500), E'\\n', ' '), E'|', ' ')
    FROM transcript_chunks t
    LEFT JOIN lesson_embeddings e ON e.chunk_id = t.id
    WHERE e.id IS NULL
    LIMIT {limit};
    """
    out = run_psql(query)
    if not out:
        return 0

    lines = [line.strip() for line in out.splitlines() if line.strip()]
    inserted = 0

    for line in lines:
        parts = line.split("|", 2)
        if len(parts) < 3:
            continue
        chunk_id, lesson_id, text = parts[0].strip(), parts[1].strip(), parts[2].strip()
        emb = get_embedding(text)
        if not emb or len(emb) != 1024:
            continue

        vec_str = "[" + ",".join(str(x) for x in emb) + "]"
        embed_id = f"emb_{chunk_id}"
        insert_sql = f"""
        INSERT INTO lesson_embeddings (id, chunk_id, lesson_id, embedding)
        VALUES ('{embed_id}', '{chunk_id}', '{lesson_id}', '{vec_str}'::vector)
        ON CONFLICT (id) DO NOTHING;
        """
        run_psql_exec(insert_sql)
        inserted += 1

    return inserted


def main():
    print("CourseForge Vector Indexer starting...")
    total = 0
    # Process up to 5 batches initially
    for i in range(5):
        cnt = index_batch(20)
        total += cnt
        print(f"Indexed batch {i+1}: {cnt} chunks. Total: {total}")
        if cnt == 0:
            break
        time.sleep(0.5)
    print(f"Vector indexing run finished. Total indexed: {total}")


if __name__ == "__main__":
    main()
