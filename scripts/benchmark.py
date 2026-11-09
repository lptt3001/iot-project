"""Small repeatable local API smoke load test; no simulated benchmark numbers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import statistics
import time

import httpx

ROOT=Path(__file__).resolve().parents[1]


def main():
    with httpx.Client(base_url='http://127.0.0.1:8000',headers={'X-Garden-Request':'1'},timeout=30) as client:
        client.post('/api/session').raise_for_status()
        paths=['/api/dashboard','/api/history?hours=24','/api/alerts','/api/images?limit=12']
        def request(i):
            start=time.perf_counter()
            response=client.get(paths[i%len(paths)])
            return {'status':response.status_code,'latency_ms':(time.perf_counter()-start)*1000}
        start=time.perf_counter()
        with ThreadPoolExecutor(max_workers=8) as pool:
            samples=list(pool.map(request,range(80)))
        elapsed=time.perf_counter()-start
        durations=sorted(s['latency_ms'] for s in samples)
        report={'executed_at_utc':datetime.now(timezone.utc).isoformat(),'concurrency':8,'requests':len(samples),
            'errors':sum(s['status']!=200 for s in samples),'p50_ms':round(statistics.median(durations),2),
            'p95_ms':round(durations[int(len(durations)*.95)-1],2),'elapsed_seconds':round(elapsed,2),
            'requests_per_second':round(len(samples)/elapsed,2)}
        target=ROOT/'output/verification/benchmark.json'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report,indent=2))
        if report['errors']:
            raise SystemExit(1)


if __name__=='__main__':
    main()
