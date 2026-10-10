'use strict';
(() => {
  const api=window.CourseForgeServices.request,json=window.CourseForgeServices.json;
  let active=null;
  const element=(tag,cls='',text='')=>{const e=document.createElement(tag);e.className=cls;e.textContent=text;return e;};
  function button(label,svg,action){
    const b=element('button','player-button');b.type='button';b.title=label;b.setAttribute('aria-label',label);
    b.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`;b.onclick=action;return b;
  }
  function stop(){
    const a=active;active=null;if(!a)return;
    const progress=state.progress.get(a.lesson)||{};
    state.progress.set(a.lesson,{...progress,video_id:a.lesson,position:a.video.currentTime||0});
    clearInterval(a.timer);clearTimeout(a.hold);clearTimeout(a.feedbackTimer);a.send('closed',true);a.stopped=true;
    a.cleanup?.();a.video.pause();a.video.removeAttribute('src');a.video.load();
  }
  function seek(seconds,absolute=false){
    const a=active;if(!a||a.locked||!Number.isFinite(a.video.duration))return;
    a.video.currentTime=Math.max(0,Math.min(a.video.duration,absolute?seconds:a.video.currentTime+seconds));
    a.feedback.textContent=absolute?`Jumped to ${prettyTime(a.video.currentTime)}`:`${seconds<0?'Back':'Forward'} ${Math.abs(seconds)} seconds`;
    a.feedback.hidden=false;clearTimeout(a.feedbackTimer);a.feedbackTimer=setTimeout(()=>a.feedback.hidden=true,900);
  }
  async function open(wrap,lesson,session,onFailure){
    stop();
    const stage=element('div','native-player-stage'),controller=element('media-controller'),v=element('video');
    stage.tabIndex=0;stage.setAttribute('aria-label','Lesson player. Space plays or pauses, arrows seek, M mutes, F opens fullscreen, L locks controls.');
    controller.setAttribute('autohide','3');controller.setAttribute('nohotkeys','');controller.setAttribute('gesturesdisabled','');
    controller.setAttribute('fullscreenelement','lecturePlayerWrap');
    v.id='nativeLecturePlayer';v.controls=true;v.playsInline=true;v.preload='metadata';v.slot='media';
    v.disablePictureInPicture=true;v.setAttribute('disableRemotePlayback','');
    v.setAttribute('aria-label',lesson.title);v.setAttribute('controlsList','nodownload nofullscreen noremoteplayback');
    const watermark=element('div','native-watermark',session.watermark),feedback=element('div','seek-feedback');feedback.hidden=true;feedback.setAttribute('aria-live','polite');
    const loading=element('media-loading-indicator');loading.setAttribute('slot','centered-chrome');loading.setAttribute('noautohide','');
    controller.append(v,loading);stage.append(controller,watermark,feedback);wrap.append(stage);
    const status=element('p','native-player-status','Loading lecture…');status.setAttribute('aria-live','polite');wrap.append(status);
    const prefs=window.CourseForgePlayerSession?.preferences()||{speed:1};
    const a={video:v,stage,controller,status,feedback,id:session.id,lesson:lesson.id,sequence:0,last:performance.now(),position:0,
      rate:prefs.speed,running:false,delivery:null,stopped:false,timer:null,locked:false,hold:null};active=a;
    const actual=()=>document.hidden?'hidden':v.paused?'pause':v.readyState<3?'waiting':'playing';
    a.send=(event,final=false)=>{
      if(a.stopped)return;
      const now=performance.now(),wall=(now-a.last)/1000,pos=Number.isFinite(v.currentTime)?v.currentTime:0;
      const advanced=pos-a.position;
      const elapsed=a.running&&navigator.onLine!==false&&advanced>0&&advanced<=Math.min(wall,20)*a.rate+1?Math.min(20,wall,advanced/a.rate):0;
      const packet={sequence:++a.sequence,event,position:pos,duration:Number.isFinite(v.duration)?v.duration:0,
        elapsed_seconds:Math.max(0,elapsed),rate:a.rate,playback_state:actual()};
      a.last=now;a.position=pos;a.rate=v.playbackRate;
      a.running=navigator.onLine!==false&&actual()==='playing'&&!['seeking','seeked','ready','error','closed'].includes(event);
      const apply=r=>{
        if(active!==a||!r)return;
        if(['closed','expired','ownership_lost'].includes(r.reason)){
          a.running=false;v.pause();status.textContent='Playback ownership ended. Select Resume here to continue.';
          window.CourseForgeStudio?.ownershipLost(status.textContent);return;
        }
        if(!r.accepted&&r.reason!=='duplicate')return;
        if(r.resume_saved===false){status.textContent='Progress is being saved by your other player window.';return;}
        const p=state.progress.get(a.lesson)||{};
        state.progress.set(a.lesson,{...p,video_id:a.lesson,position:r.position,percent:p.completed?100:r.coverage_percent});
        const bar=document.getElementById('playerProgressBar');if(bar)bar.style.width=(p.completed?100:r.coverage_percent)+'%';
        status.textContent=`Resume saved at ${prettyTime(r.position)}. Playback ${prettyTime(r.playing_seconds)}. Coverage ${r.coverage_percent}%.`;
      };
      if(final){
        a.delivery?.stop();fetch(`/api/player/${a.id}/events`,{method:'POST',keepalive:true,credentials:'same-origin',
          headers:{'Content-Type':'application/json','X-CSRF-Token':window.CourseForgeAccount?.csrf||''},body:JSON.stringify(packet)}).catch(()=>{});return;
      }
      if(!a.delivery)a.delivery=window.CourseForgePlaybackDelivery({
        request:(sample,signal)=>api(`/api/player/${a.id}/events`,{...json('POST',sample),signal}),onSaved:apply,
        onError:error=>{if(active!==a)return;status.textContent='Tracking could not save: '+error.message;if([401,403,404].includes(error.status)||error.code==='queue_full'){v.pause();window.CourseForgeStudio?.ownershipLost('Your tracking session ended. Reopen the lesson.');}}
      });
      a.delivery.send(packet);
    };
    v.addEventListener('loadedmetadata',()=>{
      if(active!==a)return;
      if(session.start_pos>0)v.currentTime=Math.min(session.start_pos,Math.max(0,v.duration-.1));
      v.playbackRate=prefs.speed;status.textContent=session.start_pos>0?`Resume at ${prettyTime(session.start_pos)} or choose Restart.`:'Ready to play. Your position saves automatically.';a.send('ready');window.CourseForgeStudio?.resumePrompt(session.start_pos);
    });
    for(const event of ['playing','pause','seeking','waiting','ended','ratechange'])v.addEventListener(event,()=>{
      if(active!==a)return;a.send(document.hidden?'hidden':event);
      if(event==='playing')stage.querySelector('.player-resume')?.remove();
      if(event==='waiting')status.textContent='Buffering lecture…';
      if(event==='ratechange')window.CourseForgePlayerSession?.setPreferences({speed:v.playbackRate});
      if(event==='ended')window.CourseForgeStudio?.ended(lesson);
    });
    v.addEventListener('seeked',()=>{if(active===a){a.send('seeked');if(!v.paused&&!document.hidden)a.send('playing');}});
    v.addEventListener('error',()=>{if(active===a){a.send('error');status.textContent='The provider could not deliver this lecture. Choose Retry or Embedded player.';onFailure();}});
    a.timer=setInterval(()=>{if(active===a)a.send(document.hidden?'hidden':'heartbeat');},10000);
    // Media Chrome is locally hosted. Preserve the browser's controls if the
    // component bundle cannot load, rather than leaving an unusable player.
    const ready=await Promise.race([customElements.whenDefined('media-controller').then(()=>true),new Promise(r=>setTimeout(()=>r(false),4000))]);
    if(active!==a)return null;
    const chrome=element('div','native-controls');
    if(ready){
      v.controls=false;
      const top=element('div','player-top-controls');top.slot='top-chrome';
      const capture=button('Capture timestamp','<path d="M6 3h12v18l-6-4-6 4z"/>',()=>window.CourseForgeStudio?.capture());
      const theater=button('Theater mode','<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14"/>',()=>window.CourseForgeStudio?.toggleTheater());
      const lock=button('Lock player controls','<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',()=>setLock(true));
      top.append(capture,theater,lock);controller.append(top);
      const timeline=element('media-time-range','player-timeline');timeline.setAttribute('aria-label','Seek lecture');
      const row=element('media-control-bar','player-control-row');
      for(const [tag,attrs] of [['media-play-button',{}],['media-seek-backward-button',{seekoffset:'10'}],['media-seek-forward-button',{seekoffset:'10'}],['media-mute-button',{}],['media-volume-range',{}],['media-time-display',{}]]){
        const e=element(tag);if(tag==='media-time-display')e.title='Click to switch elapsed and remaining time';for(const [k,value]of Object.entries(attrs))e.setAttribute(k,value);row.append(e);
      }
      const spacer=element('span','player-control-spacer'),speed=element('select','player-speed');speed.setAttribute('aria-label','Playback speed');
      for(const rate of [.5,.75,1,1.25,1.5,1.75,2,2.5,3]){const option=element('option','',`${rate}×`);option.value=rate;option.selected=rate===prefs.speed;speed.append(option);}
      speed.onchange=()=>v.playbackRate=Number(speed.value);v.addEventListener('ratechange',()=>speed.value=v.playbackRate);
      const full=button('Fullscreen','<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',async()=>{try{document.fullscreenElement?await document.exitFullscreen():await wrap.requestFullscreen();}catch{toast('Fullscreen is unavailable.',true);}});
      row.append(spacer,speed,full);chrome.append(timeline,row);controller.append(chrome);
      const unlock=element('button','player-unlock','Hold to unlock');unlock.type='button';unlock.hidden=true;unlock.setAttribute('aria-label','Hold for one second to unlock, or press Enter or Escape');stage.append(unlock);
      function setLock(locked){
        a.locked=locked;stage.classList.toggle('controls-locked',locked);chrome.inert=locked;top.inert=locked;
        unlock.hidden=!locked;controller.toggleAttribute('noautohide',locked);unlock.textContent='Hold to unlock';
        if(locked)unlock.focus();else stage.focus();
      }
      a.unlock=()=>setLock(false);
      unlock.addEventListener('pointerdown',event=>{if(event.button!==0)return;unlock.setPointerCapture(event.pointerId);unlock.textContent='Keep holding…';a.hold=setTimeout(()=>setLock(false),1000);});
      for(const event of ['pointerup','pointercancel','lostpointercapture'])unlock.addEventListener(event,()=>{clearTimeout(a.hold);if(a.locked)unlock.textContent='Hold to unlock';});
      unlock.onclick=event=>{if(event.detail===0)setLock(false);};
      stage.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&a.locked){event.preventDefault();event.stopPropagation();setLock(false);return;}
        if(a.locked)return;
        const target=event.composedPath()[0];if(target!==stage&&target!==v)return;
        if(event.ctrlKey||event.metaKey||event.altKey)return;
        const actions={' ':()=>v.paused?v.play().catch(()=>{}):v.pause(),ArrowLeft:()=>seek(-10),ArrowRight:()=>seek(10),m:()=>v.muted=!v.muted,f:()=>full.click(),l:()=>setLock(true)};
        const action=actions[event.key.length===1?event.key.toLowerCase():event.key];if(action){event.preventDefault();action();}
      });
      let lastTap=0,lastSide=null;
      v.addEventListener('pointerup',event=>{
        if(a.locked)return;
        if(event.pointerType==='mouse'){v.paused?v.play().catch(()=>{}):v.pause();return;}
        const side=event.offsetX<v.clientWidth/2?'left':'right',now=performance.now();
        if(now-lastTap<350&&side===lastSide){seek(side==='left'?-10:10);lastTap=0;}else{lastTap=now;lastSide=side;}
      });
      stage.addEventListener('focusin',()=>controller.setAttribute('noautohide',''));
      stage.addEventListener('focusout',()=>{if(!a.locked)controller.removeAttribute('noautohide');});
    }else{
      controller.replaceWith(v);stage.classList.add('native-fallback');
      chrome.append(element('p','','Browser controls are active. Reload to restore enhanced controls.'));wrap.append(chrome);
    }
    const volumeKey='courseforge-volume-'+window.CourseForgeAccount?.user?.id;
    try{const saved=JSON.parse(localStorage.getItem(volumeKey)||'null');if(saved){v.volume=Math.max(0,Math.min(1,saved.volume));v.muted=Boolean(saved.muted);}}catch{}
    v.addEventListener('volumechange',()=>{try{localStorage.setItem(volumeKey,JSON.stringify({volume:v.volume,muted:v.muted}));}catch{}});
    v.src=session.media_url;return v;
  }
  function suspend(){if(active){active.send('hidden');active.running=false;active.video.pause();}}
  window.addEventListener('offline',()=>{if(active){active.running=false;active.send('hidden');}});
  window.CourseForgeNative={open,stop,seek,suspend,toolbar:()=>element('div'),currentPosition:()=>active?.video.currentTime??null,
    video:()=>active?.video,locked:()=>Boolean(active?.locked),unlock:()=>active?.unlock?.(),
    resetBaseline:()=>{if(active){active.last=performance.now();active.position=active.video.currentTime;active.running=false;}},
    trackingNotice:text=>{if(active)active.status.textContent=text;}};
})();
