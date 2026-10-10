"""Run the actual player opening boundary when a Retry action follows a media error."""
from pathlib import Path
import shutil
import subprocess

import pytest


def test_retry_reopens_errored_media_and_healthy_timestamp_links_seek():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is required for client player checks')
    source = Path(__file__).resolve().parents[1] / 'app/static/app.js'
    harness = r'''
const assert = require('node:assert/strict');
const fs = require('node:fs');
const script = fs.readFileSync(process.argv[1], 'utf8');
const boundary = script.slice(script.indexOf('let openingGeneration=0;'),script.indexOf("$('#markCompleteBtn').addEventListener"));
global.state = {currentVideoId:'lesson'};
const calls = [], seeks = [];
let media = {error:{code:4},readyState:0,duration:NaN};
const reached = new Error('Reached fresh lesson request');
global.window = {
  CourseForgeNative:{video:()=>media,locked:()=>false,seek:p=>seeks.push(p),stop:()=>{}},
  CourseForgePlayerSession:{close:async()=>{}},CourseForgeAcademy:{stopActivity:()=>{}}
};
global.request = async path => {calls.push(path);throw reached;};
global.syncLessonRoute = ()=>{};
global.toast = ()=>assert.fail('Unexpected player notice');
eval(boundary+';global.openVideo=openVideo;');
(async()=>{
  // This is the exact Retry call made by the failure overlay. The broken
  // player must request a new session rather than silently seeking NaN media.
  await openVideo('lesson',120).catch(error=>assert.equal(error,reached));
  assert.deepEqual(calls,['/api/videos/lesson']);
  assert.deepEqual(seeks,[]);
  calls.length=0;media={error:null,readyState:4,duration:240};
  await openVideo('lesson',125);
  assert.deepEqual(calls,[]);assert.deepEqual(seeks,[125]);
})().catch(error=>{console.error(error);process.exitCode=1;});
'''
    result = subprocess.run([node, '-e', harness, str(source)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr


def test_recovery_is_bounded_offline_safe_and_cancelled_on_leave():
    node=shutil.which('node')
    if not node:pytest.skip('Node is required for client player checks')
    source=Path(__file__).resolve().parents[1]/'app/static/player-recovery.js'
    harness=r'''
const assert=require('node:assert/strict');global.window={};require(process.argv[1]);
const timers=[],states=[];let online=false,calls=0,failures=0,signal;
const cycle=window.CourseForgePlayerRecovery({canRecover:()=>online,
  reload:async s=>{calls++;signal=s;throw new Error('source failed');},
  onState:s=>states.push(s),onFailure:()=>failures++,
  setTimer:f=>{timers.push(f);return f;},clearTimer:f=>timers.splice(timers.indexOf(f),1)});
(async()=>{
  cycle.fail(new Error('network'));cycle.fail(new Error('network'));
  assert.equal(calls,0);assert.equal(timers.length,0);
  online=true;cycle.resume();cycle.resume();assert.equal(timers.length,1);
  await timers.shift()();assert.equal(calls,1);assert.equal(timers.length,1);
  await timers.shift()();assert.equal(calls,2);assert.equal(failures,1);assert.equal(timers.length,0);
  cycle.fail(new Error('network'));assert.equal(calls,2);assert.equal(timers.length,0);assert.equal(failures,1);
  const auth=window.CourseForgePlayerRecovery({canRecover:()=>true,reload:()=>assert.fail(),
    onState:()=>{},onFailure:()=>failures++});auth.fail({status:403});assert.equal(failures,2);
  let reject;
  const cancelled=window.CourseForgePlayerRecovery({canRecover:()=>true,
    reload:s=>{signal=s;return new Promise((_,r)=>reject=r);},onState:()=>{},onFailure:()=>assert.fail(),
    setTimer:f=>{timers.push(f);return f;},clearTimer:()=>{}});
  cancelled.fail(new Error('network'));const running=timers.shift()();
  cancelled.cancel();assert.equal(signal.aborted,true);reject(new Error('aborted'));await running;
  assert.equal(timers.length,0);
  let successful=0;
  const healthy=window.CourseForgePlayerRecovery({canRecover:()=>true,reload:async()=>successful++,
    onState:()=>{},onFailure:()=>assert.fail(),setTimer:f=>{timers.push(f);return f;},clearTimer:()=>{}});
  healthy.fail({});await timers.shift()();healthy.fail({});await timers.shift()();
  healthy.healthy(30);healthy.fail({});await timers.shift()();assert.equal(successful,3);
})().catch(error=>{console.error(error);process.exitCode=1;});
'''
    result=subprocess.run([node,'-e',harness,str(source)],capture_output=True,text=True,timeout=10)
    assert result.returncode==0,result.stderr
