"""Opt-in real Docker smoke check of reviewed graders; not run by CI."""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path
from app import labs
SOLUTIONS={
 'sql-customer-revenue':"SELECT c.name AS customer_name, SUM(o.amount) AS total_revenue FROM customers c JOIN orders o ON o.customer_id=c.id WHERE o.status='paid' GROUP BY c.id,c.name ORDER BY total_revenue DESC;",
 'pyspark-order-analytics':"from pyspark.sql import functions as F\ndef summarize_paid_orders(df):\n    return df.filter(F.col('status')=='paid').groupBy('customer_id').agg(F.sum('amount').alias('total_revenue')).orderBy('customer_id')\n",
 'docker-hardened-service':"FROM nginx:1.27-alpine\nEXPOSE 8080\nUSER 101\nHEALTHCHECK CMD true\n",
 'ansible-idempotent-web':"- hosts: web\n  become: true\n  tasks:\n  - ansible.builtin.package:\n      name: nginx\n      state: present\n  - ansible.builtin.service:\n      name: nginx\n      state: started\n      enabled: true\n",
 'backend-request-handler':"def handle_request(method,path,payload):\n    if method=='GET' and path=='/health': return 200, {'status':'ok'}\n    if method=='POST' and path=='/tasks':\n        title=payload.get('title') if isinstance(payload,dict) else None\n        if not isinstance(title,str) or not title.strip(): return 400, {'error':'invalid title'}\n        return 201, {'title':title.strip()}\n    return 404, {'error':'not found'}\n"
}
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--spark',action='store_true')
    args=parser.parse_args()
    failures=[]
    with tempfile.TemporaryDirectory() as tmp:
        for slug,content in SOLUTIONS.items():
            if slug=='pyspark-order-analytics' and not args.spark: continue
            path=Path(tmp)/slug
            path.mkdir()
            (path/labs.LABS[slug]['filename']).write_text(content)
            try:
                p=subprocess.run(labs.docker_command(path,slug),capture_output=True,text=True,timeout=120 if slug=='pyspark-order-analytics' else 40)
                result=json.loads(p.stdout) if p.returncode==0 else {'passed':False}
                if not result.get('passed'): raise RuntimeError(p.stderr[-300:] or str(result))
                print('PASS',slug)
            except Exception as exc:
                print('FAIL',slug,exc)
                failures.append(slug)
    if failures: raise SystemExit(1)
if __name__=='__main__': main()
