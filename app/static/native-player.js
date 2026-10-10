'use strict';
(() => {
  const api=window.CourseForgeServices.request,json=window.CourseForgeServices.json;
  let active=null;
  function element(tag,cls='',text=''){const e=document.createElement(tag);e.className=cls;e.textContent=text;return e;}
  function stop(){
    const a=active;active=null;if(!a)return;
    const progress=state.progress.get(a.lesson)||{};
    state.progress.set(a.lesson,{...progress,video_id:a.lesson,position:a.video.currentTime||0});
    clearInterval(a.timer);a.send('closed',true);a.stopped=true;
    a.video.pause();a.video.removeAttribute('src');a.video.load();
  }
  function open(wrap,lesson,session,onFailure){
    stop();
    const stage=element('div','native-player-stage'),v=element('video');
    v.id='nativeLecturePlayer';v.controls=true;v.playsInline=true;v.preload='metadata';
    v.setAttribute('aria-label',lesson.title);v.setAttribute('controlsList','nodownload nofullscreen');
    const watermark=element('div','native-watermark',session.watermark);
    stage.append(v,watermark);wrap.append(stage);
    const status=element('p','native-player-status','Ready. Your playback position saves automatically.');
    status.setAttribute('aria-live','polite');wrap.append(status);
    const a={video:v,id:session.id,lesson:lesson.id,sequence:0,last:performance.now(),position:0,
      rate:1,running:false,chain:Promise.resolve(),stopped:false,timer:null};active=a;
    a.send=(event,final=false)=>{
      if(a.stopped)return;
      const now=performance.now(),wall=(now-a.last)/1000,pos=Number.isFinite(v.currentTime)?v.currentTime:0;
      const advanced=pos-a.position;
      const elapsed=a.running&&advanced>0&&advanced<=Math.min(wall,20)*a.rate+1?Math.min(20,wall,advanced/a.rate):0;
      const packet={sequence:++a.sequence,event,position:pos,duration:Number.isFinite(v.duration)?v.duration:0,
        elapsed_seconds:Math.max(0,elapsed),rate:a.rate};
      a.last=now;a.position=pos;a.rate=v.playbackRate;
      a.running=event==='playing'||(['heartbeat','ratechange'].includes(event)&&a.running);
      const apply=r=>{
        if(active!==a||!r.accepted)return;
        const p=state.progress.get(a.lesson)||{};
        state.progress.set(a.lesson,{...p,video_id:a.lesson,position:r.position,percent:p.completed?100:r.coverage_percent});
        const bar=document.getElementById('playerProgressBar');if(bar)bar.style.width=(p.completed?100:r.coverage_percent)+'%';
        status.textContent=`Playback recorded: ${prettyTime(r.playing_seconds)} · Resume at ${prettyTime(r.position)} · ${r.coverage_percent}% coverage`;
      };
      if(final){
        // Send the closure immediately during pagehide. A late older sequence
        // is ignored by the server once this final packet has closed the session.
        fetch(`/api/player/${a.id}/events`,{method:'POST',keepalive:true,credentials:'same-origin',
          headers:{'Content-Type':'application/json','X-CSRF-Token':window.CourseForgeAccount.csrf},body:JSON.stringify(packet)}).catch(()=>{});
        return;
      }
      a.chain=a.chain.then(()=>api(`/api/player/${a.id}/events`,json('POST',packet))).then(apply).catch(error=>{
        if(active!==a)return;
        status.textContent='Playback tracking could not save: '+error.message;
        if([401,403,404].includes(error.status))stop();
      });
    };
    v.addEventListener('loadedmetadata',()=>{
      if(active!==a)return;
      if(session.start_pos>0)v.currentTime=Math.min(session.start_pos,Math.max(0,v.duration-.1));
      a.send('ready');
    });
    for(const event of ['playing','pause','seeking','waiting','ended','ratechange'])v.addEventListener(event,()=>{
      if(active!==a)return;
      a.send(document.hidden?'hidden':event);
    });
    v.addEventListener('seeked',()=>{if(active===a){a.send('seeked');if(!v.paused&&!document.hidden)a.send('playing');}});
    v.addEventListener('error',()=>{if(active===a){a.send('error');status.textContent='The video provider could not deliver this lecture. Retry or switch to the embedded player.';onFailure();}});
    a.timer=setInterval(()=>{if(active===a)a.send(document.hidden?'hidden':'heartbeat');},10000);
    v.src=session.media_url;
    return v;
  }
  document.addEventListener('visibilitychange',()=>{
    if(!active)return;
    active.send(document.hidden?'hidden':!active.video.paused&&active.video.readyState>=3?'playing':'pause');
  });
  function toolbar(){
    const tools=element('div','native-controls');
    for(const seconds of [-10,10]){
      const b=element('button','btn btn-outline',seconds<0?'Back 10s':'Forward 10s');b.type='button';
      b.onclick=()=>{if(active)active.video.currentTime=Math.max(0,Math.min(active.video.duration||0,active.video.currentTime+seconds));};tools.append(b);
    }
    const label=element('label','','Playback speed '),select=element('select','form-input');
    select.setAttribute('aria-label','Playback speed');
    for(const rate of [.5,.75,1,1.25,1.5,1.75,2]){const option=element('option','',rate+'×');option.value=rate;option.selected=rate===1;select.append(option);}
    select.onchange=()=>{if(active)active.video.playbackRate=Number(select.value);};label.append(select);tools.append(label);
    const capture=element('button','btn btn-outline','Use current timestamp');capture.type='button';
    capture.onclick=()=>{if(!active)return;for(const id of ['notePosition','bookmarkPosition'])document.getElementById(id).value=prettyTime(active.video.currentTime);toast('Current timestamp added to your note and bookmark forms.');};tools.append(capture);
    return tools;
  }
  window.CourseForgeNative={open,stop,toolbar,currentPosition:()=>active?.video.currentTime??null};
})();
