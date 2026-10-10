"""Bounded, durable work queue for AI calls and reviewed lab graders."""
import json
import os
import secrets
from fastapi import APIRouter, HTTPException, Request
from .db import connect,owner,utcnow
from . import auth

router=APIRouter()
KINDS={'ask','reviews','path','assessment','lab','syllabus'}


def enqueue(kind: str,payload: dict) -> dict:
    if kind not in KINDS:raise ValueError('Unknown task kind')
    uid=owner()
    quota=int(os.getenv('DAILY_LAB_QUOTA' if kind=='lab' else 'DAILY_AI_QUOTA','10' if kind=='lab' else '30'))
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        pending=db.execute("SELECT COUNT(*) FROM task_queue WHERE user_id=? AND status IN ('queued','running')",(uid,)).fetchone()[0]
        if pending>=3:raise HTTPException(429,'You already have three pending tasks. Wait for one to finish.')
        count=db.execute("SELECT COUNT(*) FROM task_queue WHERE user_id=? AND created_at>=? AND (kind='lab')=?",(uid,utcnow()[:10],int(kind=='lab'))).fetchone()[0]
        if count>=quota:raise HTTPException(429,'Daily task limit reached. Please try again tomorrow.')
        # The global bound prevents unlimited public registration from filling
        # the queue faster than the single resource-limited worker can drain it.
        if db.execute("SELECT COUNT(*) FROM task_queue WHERE status IN ('queued','running')").fetchone()[0]>=100:
            raise HTTPException(503,'Learning services are busy. Please try again shortly.')
        tid='task_'+secrets.token_hex(16)
        db.execute('INSERT INTO task_queue(id,user_id,kind,payload,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                   (tid,uid,kind,json.dumps(payload),utcnow(),utcnow()))
    return {'task_id':tid,'status':'queued'}


@router.get('/api/tasks/{tid}')
def task_status(tid: str,request: Request):
    user=auth.require_user(request)
    with connect() as db:
        row=db.execute('SELECT id,kind,status,result,error,created_at,updated_at FROM task_queue WHERE id=? AND user_id=?',(tid,user['id'])).fetchone()
    if not row:raise HTTPException(404,'Task not found')
    result=dict(row)
    result['result']=json.loads(row['result']) if row['result'] else None
    return result
