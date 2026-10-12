import asyncio
import time
import httpx
import statistics

CONCURRENCY = 50
TOTAL_REQUESTS = 1000
TARGET_URLS = [
    'http://127.0.0.1:18090/api/v1/public/courses',
    'http://127.0.0.1:18090/api/v1/streaming/home-feed',
    'http://127.0.0.1:18090/api/v1/streaming/trending',
]

async def worker(queue, client, latencies, errors):
    while not queue.empty():
        url = await queue.get()
        start = time.perf_counter()
        try:
            resp = await client.get(url, timeout=10.0)
            elapsed = (time.perf_counter() - start) * 1000.0
            if resp.status_code == 200:
                latencies.append(elapsed)
            else:
                errors.append(resp.status_code)
        except Exception as e:
            errors.append(str(e))
        finally:
            queue.task_done()

async def main():
    queue = asyncio.Queue()
    for i in range(TOTAL_REQUESTS):
        queue.put_nowait(TARGET_URLS[i % len(TARGET_URLS)])

    latencies = []
    errors = []

    limits = httpx.Limits(max_keepalive_connections=CONCURRENCY, max_connections=CONCURRENCY)
    async with httpx.AsyncClient(limits=limits) as client:
        start_time = time.perf_counter()
        tasks = [asyncio.create_task(worker(queue, client, latencies, errors)) for _ in range(CONCURRENCY)]
        await asyncio.gather(*tasks)
        total_time = time.perf_counter() - start_time

    latencies.sort()
    rps = len(latencies) / total_time
    p50 = statistics.median(latencies) if latencies else 0
    p90 = latencies[int(len(latencies) * 0.90)] if latencies else 0
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    p99 = latencies[int(len(latencies) * 0.99)] if latencies else 0

    print('=== HIGH-CONCURRENCY GO API BENCHMARK RESULTS ===')
    print(f'Total requests: {TOTAL_REQUESTS}')
    print(f'Concurrency: {CONCURRENCY}')
    print(f'Total duration: {total_time:.3f} s')
    print(f'Throughput: {rps:.2f} req/sec')
    print(f'Successful (200 OK): {len(latencies)}')
    print(f'Errors: {len(errors)}')
    print(f'p50 Latency: {p50:.2f} ms')
    print(f'p90 Latency: {p90:.2f} ms')
    print(f'p95 Latency: {p95:.2f} ms')
    print(f'p99 Latency: {p99:.2f} ms')
    print(f'Min Latency: {min(latencies):.2f} ms')
    print(f'Max Latency: {max(latencies):.2f} ms')

if __name__ == '__main__':
    asyncio.run(main())
