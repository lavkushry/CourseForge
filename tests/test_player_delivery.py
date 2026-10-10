"""Exercise the real JS delivery queue with failed acknowledgments and timeouts."""
from pathlib import Path
import shutil
import subprocess

import pytest


def test_playback_delivery_recovers_without_duplicate_or_unbounded_events():
    node=shutil.which('node')
    if not node:pytest.skip('Node is required for client delivery checks')
    script=Path(__file__).resolve().parents[1]/'app/static/player-tracking.js'
    harness=r'''
const assert=require('node:assert/strict');
global.window={};global.navigator={onLine:true};
require(process.argv[1]);
const create=window.CourseForgePlaybackDelivery;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  // The server stored the first packet, but its acknowledgment was lost.
  const calls=[],saved=[];let ledger=0;
  const retry=create({request:async p=>{
    calls.push(p.sequence);
    if(ledger===0){ledger++;throw new TypeError('Connection lost after commit');}
    return {accepted:false,reason:'duplicate',playing_seconds:ledger};
  },onSaved:r=>saved.push(r),onError:e=>{throw e;}});
  retry.send({sequence:1,event:'playing'});await tick();
  assert.deepEqual(calls,[1,1]);assert.equal(ledger,1);
  assert.equal(saved[0].reason,'duplicate');retry.stop();

  // Heartbeat replacement must not reorder seeking/pause transitions.
  let release;const ordered=[];
  const queue=create({request:p=>{
    ordered.push(p.sequence);
    return p.sequence===1?new Promise(resolve=>release=()=>resolve({accepted:true})):Promise.resolve({accepted:true});
  },onSaved:()=>{},onError:e=>{throw e;}});
  queue.send({sequence:1,event:'playing'});
  queue.send({sequence:2,event:'heartbeat'});
  queue.send({sequence:3,event:'seeking'});
  queue.send({sequence:4,event:'heartbeat'});
  queue.send({sequence:5,event:'pause'});
  release();await tick();
  assert.deepEqual(ordered,[1,3,4,5]);queue.stop();

  // Timeouts finish after two attempts. A subsequent sample can still save.
  const realTimeout=global.setTimeout,realClear=global.clearTimeout;
  global.setTimeout=f=>{queueMicrotask(f);return 0;};global.clearTimeout=()=>{};
  let attempts=0;const errors=[],success=[];
  const timed=create({request:(_p,signal)=>{attempts++;return new Promise((_r,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('Timeout')),{once:true});
  });},onSaved:r=>success.push(r),onError:e=>errors.push(e.message)});
  timed.send({sequence:1,event:'playing'});await tick();
  assert.equal(attempts,2);assert.equal(errors.length,1);timed.stop();
  global.setTimeout=realTimeout;global.clearTimeout=realClear;

  // Permanent access failures are not retried or left queued.
  let denied=0;const fatal=[];
  const forbidden=create({request:async()=>{denied++;const e=new Error('Access revoked');e.status=403;throw e;},
    onSaved:()=>assert.fail('denied event saved'),onError:e=>fatal.push(e.status)});
  forbidden.send({sequence:1,event:'playing'});forbidden.send({sequence:2,event:'heartbeat'});await tick();
  assert.equal(denied,1);assert.deepEqual(fatal,[403]);

  // Repeated heartbeats never fill memory behind a blocked request; even
  // a flood of state transitions is bounded and closes delivery explicitly.
  let aborted=false;const overflow=[];
  const bounded=create({request:(_p,signal)=>new Promise((_r,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Stopped'));},{once:true});
  }),onSaved:()=>{},onError:e=>overflow.push(e.code)});
  bounded.send({sequence:1,event:'playing'});
  for(let i=2;i<1000;i++)bounded.send({sequence:i,event:'heartbeat'});
  assert.equal(aborted,false);assert.equal(overflow.length,0);
  for(let i=1000;i<1135;i++)bounded.send({sequence:i,event:'seeking'});
  await tick();assert.equal(aborted,true);assert.deepEqual(overflow,['queue_full']);

  // Offline delivery sends no network request and resumes on the next sample.
  global.navigator.onLine=false;let sent=0;const offlineErrors=[],onlineSaved=[];
  const offline=create({request:async()=>{sent++;return {accepted:true};},
    onSaved:r=>onlineSaved.push(r),onError:e=>offlineErrors.push(e.message)});
  offline.send({sequence:1,event:'hidden'});await tick();assert.equal(sent,0);
  global.navigator.onLine=true;offline.send({sequence:2,event:'playing'});await tick();
  assert.equal(sent,1);assert.equal(onlineSaved.length,1);assert.equal(offlineErrors.length,1);offline.stop();
})().catch(error=>{console.error(error);process.exitCode=1;});
'''
    result=subprocess.run([node,'-e',harness,str(script)],capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr
