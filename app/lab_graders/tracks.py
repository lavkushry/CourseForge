"""Extra curated graders. Imported by trusted grade.py inside restricted Docker."""
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

BASE = Path('/workspace')
def check(name, ok, details=''):
    return {'name':name,'passed':bool(ok),'details':str(details)[:250]}

def sql_lab():
    query=(BASE/'solution.sql').read_text(encoding='utf-8').strip()
    raw=re.sub(r'(?m)^\s*--[^\n]*$', '', query).lstrip()
    if not re.match(r'^(SELECT|WITH)\b',raw,re.I):
        return [check('Read-only SELECT or WITH',False)]
    fixtures=[
      ([(1,'Ada'),(2,'Ben'),(3,'Cora')],[(1,1,19,'paid'),(2,2,17,'paid'),(3,1,6,'draft'),(4,1,21,'paid'),(5,3,5,'paid')],[('Ada',40),('Ben',17),('Cora',5)]),
      ([(1,'Ada'),(2,'Ben')],[(1,2,9,'paid'),(2,1,30,'failed'),(3,2,11,'paid')],[('Ben',20)])
    ]
    results=[]
    for n,(customers,orders,expected) in enumerate(fixtures,1):
        db=sqlite3.connect(':memory:')
        try:
            db.executescript('CREATE TABLE customers(id INTEGER,name TEXT);CREATE TABLE orders(id INTEGER,customer_id INTEGER,amount REAL,status TEXT);')
            db.executemany('INSERT INTO customers VALUES (?,?)',customers)
            db.executemany('INSERT INTO orders VALUES (?,?,?,?)',orders)
            db.set_authorizer(lambda action,*a: sqlite3.SQLITE_OK if action in (sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION) else sqlite3.SQLITE_DENY)
            db.set_progress_handler(lambda:1, 15000)
            cur=db.execute(query)
            cols=[x[0].lower() for x in cur.description or []]
            rows=cur.fetchall()
            valid=cols==['customer_name','total_revenue'] and len(rows)==len(expected) and all(
                name==want and isinstance(value,(int,float)) and abs(value-total)<.001 for (name,value),(want,total) in zip(rows,expected))
            results.append(check(f'SQL hidden fixture {n}',valid))
        except Exception as exc:
            results.append(check(f'SQL hidden fixture {n}',False,exc))
        finally: db.close()
    return results

def docker_lab():
    value=(BASE/'Dockerfile').read_text(encoding='utf-8')
    lines=[x.strip() for x in value.splitlines() if x.strip() and not x.lstrip().startswith('#')]
    commands=[(x.split(None,1)[0].upper(),x.split(None,1)[1] if len(x.split(None,1))>1 else '') for x in lines]
    values=lambda instruction:[v for k,v in commands if k==instruction]
    users=[v.split()[0].lower() for v in values('USER') if v.split()]
    forbidden=bool(re.search(r'(curl|wget)\b.*\|\s*(sh|bash)|--privileged|docker\.sock|ENV\s+.*(?:PASSWORD|TOKEN|SECRET)\s*=',value,re.I))
    return [
        check('Pinned nginx Alpine base',values('FROM')==['nginx:1.27-alpine']),
        check('Non-root final user',bool(users) and users[-1] not in ('root','0','0:0')),
        check('Expose port 8080',any('8080' in v.split() for v in values('EXPOSE'))),
        check('Healthcheck',bool(values('HEALTHCHECK'))),
        check('Reject known dangerous patterns',not forbidden),
        check('Recognized Dockerfile directives',all(k in {'FROM','RUN','COPY','WORKDIR','USER','EXPOSE','HEALTHCHECK','ENV','LABEL','CMD','ENTRYPOINT','ARG'} for k,v in commands))
    ]

def ansible_lab():
    import yaml
    try: docs=list(yaml.safe_load_all((BASE/'playbook.yml').read_text(encoding='utf-8')))
    except Exception as exc: return [check('Valid YAML',False,exc)]
    if len(docs)!=1 or not isinstance(docs[0],list) or len(docs[0])!=1 or not isinstance(docs[0][0],dict):
        return [check('One YAML play',False)]
    play=docs[0][0];tasks=play.get('tasks')
    if not isinstance(tasks,list) or any(not isinstance(t,dict) for t in tasks):
        return [check('Tasks must be mappings',False)]
    forbidden={'shell','command','raw','script','ansible.builtin.shell','ansible.builtin.command','ansible.builtin.raw','ansible.builtin.script'}
    packages=[t['ansible.builtin.package'] for t in tasks if isinstance(t.get('ansible.builtin.package'),dict)]
    services=[t['ansible.builtin.service'] for t in tasks if isinstance(t.get('ansible.builtin.service'),dict)]
    return [
        check('Web hosts and become',play.get('hosts')=='web' and play.get('become') is True),
        check('No imperative modules',all(not forbidden.intersection(t) and not t.get('local_action') and not t.get('delegate_to') for t in tasks)),
        check('Idempotent nginx package',any(t.get('name')=='nginx' and t.get('state')=='present' for t in packages)),
        check('Nginx service started and enabled',any(t.get('name')=='nginx' and t.get('state')=='started' and t.get('enabled') is True for t in services)),
        check('Only reviewed FQCN modules',all(not any(k.startswith('ansible.') and k not in ('ansible.builtin.package','ansible.builtin.service') for k in t) for t in tasks))
    ]

def backend_lab():
    code=('import runpy\n'
          f'fn=runpy.run_path({str(BASE/"solution.py")!r})["handle_request"]\n'
          'cases=[(("GET","/health",None),(200,{"status":"ok"})),'
          '(("POST","/tasks",{"title":"  Fix API  "}),(201,{"title":"Fix API"})),'
          '(("POST","/tasks",{"title":""}),(400,{"error":"invalid title"})),'
          '(("POST","/tasks",None),(400,{"error":"invalid title"})),'
          '(("DELETE","/tasks",None),(404,{"error":"not found"}))]\n'
          'assert all(fn(*a)==want for a,want in cases)\n')
    try:
        result=subprocess.run([sys.executable,'-I','-c',code],capture_output=True,text=True,timeout=8,cwd='/tmp')
        return [check('Hidden API contract tests',result.returncode==0,(result.stderr or result.stdout)[-200:])]
    except Exception as exc:return [check('Hidden API contract tests',False,exc)]

def pyspark_lab():
    code=('import runpy\nfrom pyspark.sql import SparkSession\n'
          'spark=SparkSession.builder.master("local[1]").appName("cf-grade").config("spark.ui.enabled","false").config("spark.driver.host","127.0.0.1").getOrCreate()\n'
          'try:\n'
          f' fn=runpy.run_path({str(BASE/"solution.py")!r})["summarize_paid_orders"]\n'
          ' for records,expected in [([(1,10.0,"paid"),(1,5.0,"draft"),(2,7.0,"paid"),(1,2.0,"paid")],[(1,12.0),(2,7.0)]),'
          ' ([(2,100.0,"failed"),(4,9.0,"paid"),(4,4.0,"paid")],[(4,13.0)])]:\n'
          '  df=spark.createDataFrame(records,["customer_id","amount","status"])\n'
          '  result=fn(df)\n'
          '  assert result.columns==["customer_id","total_revenue"]\n'
          '  got=[(r[0],float(r[1])) for r in result.collect()]\n'
          '  assert got==expected,(got,expected)\n'
          'finally:\n spark.stop()\n')
    try:
        import os
        result=subprocess.run([sys.executable,'-I','-c',code],capture_output=True,text=True,timeout=80,cwd='/tmp',env={**os.environ,'SPARK_LOCAL_IP':'127.0.0.1','SPARK_LOCAL_HOSTNAME':'localhost'})
        return [check('Local Spark hidden fixtures',result.returncode==0,(result.stderr or result.stdout)[-200:])]
    except Exception as exc:return [check('Local Spark hidden fixtures',False,exc)]
