"""Provision/deprovision only the project-owned ephemeral kind cluster."""
import argparse
import json
import subprocess
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.config import settings
from app.db import utcnow

NAME='courseforge-lab'


def cmd(args, **kw):
    return subprocess.run(args,check=True,**kw)


def main():
    p=argparse.ArgumentParser(description='Manage the dedicated CourseForge kind cluster')
    p.add_argument('action',choices=['create','destroy'])
    args=p.parse_args()
    folder=settings.data_dir/'labs';folder.mkdir(parents=True,exist_ok=True)
    config=folder/'kind-kubeconfig';marker=folder/'kind-owned.json'
    if args.action=='create':
        if config.exists() or marker.exists():
            p.error('Existing kind project files found; refusing overwrite')
        output=cmd(['kind','get','clusters'],capture_output=True,text=True).stdout.splitlines()
        if NAME in output:
            p.error('A cluster with the reserved name already exists; refusing to adopt it')
        cmd(['kind','create','cluster','--name',NAME,'--kubeconfig',str(config),'--wait','90s'])
        config.chmod(0o600)
        marker.write_text(json.dumps({'name':NAME,'created_at':utcnow(),'kubeconfig':str(config)}))
        print('Created dedicated kind lab cluster. Set ENABLE_KIND_LABS=1 to enable API server dry-run.')
    else:
        if config.is_symlink() or not config.is_file() or not marker.is_file():
            p.error('No owned cluster files; refusing to delete a potentially unrelated cluster')
        data=json.loads(marker.read_text())
        if data.get('name')!=NAME or data.get('kubeconfig')!=str(config):
            p.error('Provenance marker mismatch; refusing deletion')
        cmd(['kind','delete','cluster','--name',NAME])
        config.unlink();marker.unlink()
        print('Removed project-owned kind lab cluster')

if __name__=='__main__':
    main()
