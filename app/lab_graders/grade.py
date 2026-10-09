"""Trusted grader RUNS INSIDE Docker, never on developer host."""
import json
import subprocess
import sys
from pathlib import Path

BASE = Path('/workspace')


def check(name, ok, details=''):
    return {'name':name, 'passed':bool(ok), 'details':str(details)[:250]}


def python_lab():
    source = BASE/'solution.py'
    results = []
    try:
        code = ('import runpy\n'
                f'fn=runpy.run_path({str(source)!r})["count_errors"]\n'
                'cases=[(["INFO ready","ERROR disk full","WARN high","ERROR failed"],2),'
                '(["ERROR rate=0","INFO error_count=5"],1),([],0)]\n'
                'assert all(fn(x)==y for x,y in cases),"Incorrect counts"\n')
        p = subprocess.run([sys.executable,'-I','-c',code],capture_output=True,text=True,timeout=8,cwd='/tmp')
        results.append(check('Hidden functional test cases',p.returncode==0,(p.stderr or p.stdout)[-200:]))
    except Exception as e:
        results.append(check('Hidden functional test cases',False,e))
    return results


def shell_lab():
    sample='GET /ok 200\nPOST /fail 500\nGET /retry 503\nGET /gone 404\nPOST /error 599\n'
    p = subprocess.run(['/bin/sh',str(BASE/'solution.sh')],input=sample,capture_output=True,text=True,timeout=8,cwd='/tmp')
    return [check('Count all 5xx HTTP responses',p.returncode==0 and p.stdout.strip()=='3',p.stderr or p.stdout),
            check('No errors in clean logs',_run_shell('GET /ok 200\nGET /missing 404\n')=='0')]


def _run_shell(sample):
    p = subprocess.run(['/bin/sh',str(BASE/'solution.sh')],input=sample,capture_output=True,text=True,timeout=8,cwd='/tmp')
    return p.stdout.strip() if p.returncode==0 else ''


def k8s_lab():
    import yaml
    try:
        manifests=list(yaml.safe_load_all((BASE/'manifest.yaml').read_text(encoding='utf-8')))
    except Exception as exc:
        return [check('Valid YAML documents',False,str(exc))]
    if any(not isinstance(x,dict) for x in manifests):
        return [check('Each YAML document is a mapping',False)]
    # Reject advanced resource types and pod-level host access, even on a dedicated kind cluster.
    allowed={'Deployment','Service'}
    safe_kinds=all(x.get('kind') in allowed for x in manifests)
    safe_namespace=all(x.get('metadata',{}).get('namespace') in (None,'default') for x in manifests)
    deployments=[x for x in manifests if x.get('kind')=='Deployment']
    services=[x for x in manifests if x.get('kind')=='Service']
    deployment=next((x for x in deployments if x.get('metadata',{}).get('name')=='learning-api'),{})
    service=next((x for x in services if x.get('metadata',{}).get('name')=='learning-api'),{})
    spec=deployment.get('spec',{}) or {}
    pod=spec.get('template',{}).get('spec',{}) or {}
    container=(pod.get('containers') or [{}])[0]
    resources=container.get('resources',{}) or {}
    probes=bool(container.get('readinessProbe'))
    restricted = not any(pod.get(k) for k in ('hostNetwork','hostPID','hostIPC','volumes')) and not any(
        container.get(k) for k in ('privileged','volumeMounts')) and not container.get('securityContext',{}).get('privileged',False)
    port=service.get('spec',{}).get('ports',[{}])
    port=port[0] if isinstance(port,list) and port else {}
    selector=service.get('spec',{}).get('selector',{})
    return [check('Only allowed resource kinds (Deployment/Service)',safe_kinds),
            check('Default namespace only',safe_namespace),
            check('No host access or volumes',restricted),
            check('Deployment replicas equals 2',spec.get('replicas')==2),
            check('Deployment label selector',spec.get('selector',{}).get('matchLabels',{}).get('app')=='learning-api' and
                  spec.get('template',{}).get('metadata',{}).get('labels',{}).get('app')=='learning-api'),
            check('Container readiness probe',probes),
            check('Resource requests and limits',bool(resources.get('requests')) and bool(resources.get('limits'))),
            check('ClusterIP service routes 8080',service.get('spec',{}).get('type','ClusterIP')=='ClusterIP' and
                  selector.get('app')=='learning-api' and port.get('targetPort')==8080)]


try:
    # Normal pytest import from source checkout.
    from app.lab_graders.tracks import sql_lab, pyspark_lab, docker_lab, ansible_lab, backend_lab
except ModuleNotFoundError:
    # Standalone /grader/grade.py inside the restricted grader image.
    from tracks import sql_lab, pyspark_lab, docker_lab, ansible_lab, backend_lab

def main():
    tasks={'python-log-analysis':python_lab,'shell-http-analysis':shell_lab,'k8s-resilient-service':k8s_lab,'sql-customer-revenue':sql_lab,'pyspark-order-analytics':pyspark_lab,'docker-hardened-service':docker_lab,'ansible-idempotent-web':ansible_lab,'backend-request-handler':backend_lab}
    if len(sys.argv)!=2 or sys.argv[1] not in tasks:
        sys.exit(2)
    try:
        checks=tasks[sys.argv[1]]()
    except Exception as exc:
        checks=[check('Grader ran successfully',False,str(exc))]
    print(json.dumps({'passed':all(c['passed'] for c in checks),'checks':checks}))


if __name__=='__main__':
    main()
