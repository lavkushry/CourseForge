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
    state.progress.set(a.lesson,{...progress,video_id:a.lesson,position:position(a)});
    a.recovery?.cancel();clearInterval(a.watchdog);clearInterval(a.timer);clearTimeout(a.hold);clearTimeout(a.feedbackTimer);a.send('closed',true);a.stopped=true;
    a.cleanup?.();a.video.pause();a.video.removeAttribute('src');a.video.load();
  }
  function position(a){return a.video.readyState>=1&&!a.video.error&&Number.isFinite(a.video.currentTime)?a.video.currentTime:a.savedPosition;}
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
    const status=element('p','native-player-status','Loading lesson…');status.setAttribute('aria-live','polite');stage.append(status);
    const prefs=window.CourseForgePlayerSession?.preferences()||{speed:1};
    const a={video:v,stage,controller,status,feedback,id:session.id,lesson:lesson.id,sequence:0,last:performance.now(),position:0,
      rate:prefs.speed,running:false,delivery:null,stopped:false,timer:null,locked:false,hold:null,
      savedPosition:session.start_pos||0,resumeAt:session.start_pos||0,wantsPlay:false,reloading:false,
      lastAdvance:performance.now(),loadedOnce:false};active=a;
    const actual=()=>document.hidden?'hidden':v.paused?'pause':v.readyState<3?'waiting':'playing';
    a.send=(event,final=false)=>{
      if(a.stopped)return;
      const now=performance.now(),wall=(now-a.last)/1000,pos=position(a);
      const advanced=pos-a.position;
      const elapsed=a.running&&navigator.onLine!==false&&advanced>0&&advanced<=Math.min(wall,20)*a.rate+1?Math.min(20,wall,advanced/a.rate):0;
      const packet={sequence:++a.sequence,event,position:pos,duration:Number.isFinite(v.duration)?v.duration:0,
        elapsed_seconds:Math.max(0,elapsed),rate:a.rate,playback_state:actual()};
      a.last=now;a.position=pos;a.rate=v.playbackRate;
      a.running=navigator.onLine!==false&&actual()==='playing'&&!['seeking','seeked','ready','error','closed'].includes(event);
      const apply=r=>{
        if(active!==a||!r)return;
        if(['closed','expired','ownership_lost'].includes(r.reason)){
          a.running=false;a.recovery.suspend();v.pause();status.textContent='Playback is paused. Resume here to continue.';
          window.CourseForgeStudio?.ownershipLost(status.textContent);return;
        }
        if(!r.accepted&&r.reason!=='duplicate')return;
        if(r.resume_saved===false)return;
        const p=state.progress.get(a.lesson)||{};
        const completed=r.completed??p.completed;
        state.progress.set(a.lesson,{...p,video_id:a.lesson,position:r.position,completed,percent:completed?100:r.coverage_percent});
        window.CourseForgeStudio?.completion(completed);
        if(completed&&!p.completed){renderLessons();toast('Lesson completed.');}
      };
      if(final){
        a.delivery?.stop();fetch(`/api/player/${a.id}/events`,{method:'POST',keepalive:true,credentials:'same-origin',
          headers:{'Content-Type':'application/json','X-CSRF-Token':window.CourseForgeAccount?.csrf||''},body:JSON.stringify(packet)}).catch(()=>{});return;
      }
      if(!a.delivery)a.delivery=window.CourseForgePlaybackDelivery({
        request:(sample,signal)=>api(`/api/player/${a.id}/events`,{...json('POST',sample),signal}),onSaved:apply,
        onError:error=>{if(active!==a)return;if([401,403,404].includes(error.status)||error.code==='queue_full'){a.recovery.suspend();v.pause();window.CourseForgeStudio?.ownershipLost('Please resume the lesson to continue.');}}
      });
      a.delivery.send(packet);
    };
    v.addEventListener('loadedmetadata',()=>{
      if(active!==a)return;
      if(a.resumeAt>0)v.currentTime=Math.min(a.resumeAt,Math.max(0,v.duration-.1));
      v.playbackRate=a.rate;status.textContent='';a.lastAdvance=performance.now();a.send('ready');
      if(!a.loadedOnce)window.CourseForgeStudio?.resumePrompt(a.resumeAt);a.loadedOnce=true;
    });
    for(const event of ['playing','pause','seeking','waiting','ended','ratechange'])v.addEventListener(event,()=>{
      if(active!==a||a.reloading)return;a.send(document.hidden?'hidden':event);
      if(event==='playing'){a.wantsPlay=true;a.lastAdvance=performance.now();status.textContent='';stage.querySelector('.player-resume')?.remove();}
      if(event==='pause'&&!v.error){a.wantsPlay=false;}
      if(event==='ratechange')window.CourseForgePlayerSession?.setPreferences({speed:v.playbackRate});
      if(event==='ended')window.CourseForgeStudio?.ended(lesson);
    });
    v.addEventListener('seeked',()=>{if(active===a){a.send('seeked');if(!v.paused&&!document.hidden)a.send('playing');}});
    v.addEventListener('timeupdate',()=>{
      if(active!==a||v.error||v.readyState<1)return;
      const advanced=v.currentTime-a.savedPosition;a.savedPosition=v.currentTime;
      if(!v.paused&&advanced>0&&advanced<2){a.lastAdvance=performance.now();a.recovery.healthy(advanced/Math.max(.25,v.playbackRate));}
    });
    v.addEventListener('play',()=>{if(!a.reloading){a.wantsPlay=true;a.lastAdvance=performance.now();}});
    a.recovery=window.CourseForgePlayerRecovery({
      canRecover:()=>active===a&&!a.blocked&&!document.hidden&&navigator.onLine!==false&&window.CourseForgePlayerSession.isOwner(),
      onState:mode=>{if(active!==a)return;status.textContent=mode==='waiting'?'Waiting for your connection…':mode==='reconnecting'?'Reconnecting…':'';stage.toggleAttribute('data-recovering',mode==='reconnecting'||mode==='waiting');},
      onFailure:()=>{if(active===a)onFailure();},
      reload:async signal=>{
        a.reloading=true;a.running=false;a.resumeAt=position(a);a.delivery?.stop();a.delivery=null;
        const request=new AbortController(),timeout=setTimeout(()=>request.abort(),20000);
        const abort=()=>request.abort();signal.addEventListener('abort',abort,{once:true});
        try{
          const fresh=await api(`/api/videos/${encodeURIComponent(lesson.id)}/native-session`,{...json('POST',{
            start_pos:a.resumeAt,player_session_id:window.CourseForgePlayerSession.current()}),signal:request.signal});
          if(active!==a||signal.aborted)throw new DOMException('Cancelled','AbortError');
          a.id=fresh.id;a.sequence=0;a.last=performance.now();a.position=a.resumeAt;
          await new Promise((resolve,reject)=>{
            const finish=error=>{v.removeEventListener('canplay',ready);v.removeEventListener('error',fail);request.signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
            const ready=()=>finish(),fail=()=>finish(new Error('Media unavailable')),cancel=()=>finish(new DOMException('Cancelled','AbortError'));
            v.addEventListener('canplay',ready,{once:true});v.addEventListener('error',fail,{once:true});request.signal.addEventListener('abort',cancel,{once:true});
            v.src=fresh.media_url;v.load();
          });
          a.lastAdvance=performance.now();a.reloading=false;
          if(a.wantsPlay&&!document.hidden&&window.CourseForgePlayerSession.isOwner())await v.play();
        }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);a.reloading=false;}
      }
    });
    v.addEventListener('error',()=>{if(active===a&&!a.reloading){a.send('error');a.recovery.fail(v.error?.code===3?{code:'decode'}:new Error('Media unavailable'));}});
    a.timer=setInterval(()=>{if(active===a&&!a.reloading)a.send(document.hidden?'hidden':'heartbeat');},10000);
    a.watchdog=setInterval(()=>{if(active===a&&!a.recovery.busy()&&(v.readyState===0||a.wantsPlay&&!v.ended)&&performance.now()-a.lastAdvance>20000){a.lastAdvance=performance.now();a.recovery.fail(new Error('Playback stalled'));}},2000);
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
      for(const [tag,attrs] of [['media-play-button',{}],['media-seek-backward-button',{seekoffset:'10'}],['media-seek-forward-button',{seekoffset:'10'}],['media-mute-button',{}],['media-volume-range',{}]]){
        const e=element(tag);for(const [k,value]of Object.entries(attrs))e.setAttribute(k,value);row.append(e);
      }
      const clock=element('span','player-clock'),spacer=element('span','player-control-spacer');
      const compactTime=seconds=>prettyTime(Math.max(0,seconds)).replace(/^00:/,'');
      const updateClock=()=>{clock.textContent=`${compactTime(position(a))} / ${Number.isFinite(v.duration)?compactTime(v.duration):'--:--'}`;};
      updateClock();v.addEventListener('timeupdate',updateClock);v.addEventListener('loadedmetadata',updateClock);
      row.append(clock);
      const speed=button('Playback speed','<path d="m9 3 .5 2a7 7 0 0 1 5 0L15 3l3 2-1 2a7 7 0 0 1 2.5 4L22 12l-2.5 1a7 7 0 0 1-2.5 4l1 2-3 2-.5-2a7 7 0 0 1-5 0L9 21l-3-2 1-2a7 7 0 0 1-2.5-4L2 12l2.5-1A7 7 0 0 1 7 7L6 5z"/><circle cx="12" cy="12" r="3"/>',()=>toggleMenu(menu.hidden));
      speed.classList.add('player-settings');speed.setAttribute('aria-haspopup','true');speed.setAttribute('aria-expanded','false');
      const menu=element('div','player-speed-menu');menu.hidden=true;menu.setAttribute('role','group');menu.setAttribute('aria-label','Playback speed');
      menu.append(element('strong','','Playback speed'));
      const rates=element('div','player-speed-options');
      for(const rate of [.5,.75,1,1.25,1.5,1.75,2,2.5,3]){
        const choice=element('button','',rate===1?'Normal':`${rate}×`);choice.type='button';choice.dataset.rate=rate;
        choice.setAttribute('aria-pressed',String(rate===prefs.speed));choice.onclick=()=>{v.playbackRate=rate;toggleMenu(false);speed.focus();};rates.append(choice);
      }
      menu.append(rates);stage.append(menu);
      const pinControls=()=>controller.setAttribute('autohide',a.locked||!menu.hidden||stage.matches(':focus-visible')||stage.querySelector(':focus-visible')?'-1':'3');
      function toggleMenu(open){menu.hidden=!open;speed.setAttribute('aria-expanded',String(open));pinControls();if(open)rates.querySelector('[aria-pressed="true"]')?.focus();}
      v.addEventListener('ratechange',()=>{for(const choice of rates.children)choice.setAttribute('aria-pressed',String(Number(choice.dataset.rate)===v.playbackRate));});
      stage.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.composedPath().includes(menu)&&!event.composedPath().includes(speed))toggleMenu(false);});
      menu.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();toggleMenu(false);speed.focus();}});
      menu.addEventListener('focusout',event=>{if(event.relatedTarget&&!menu.contains(event.relatedTarget)&&event.relatedTarget!==speed)toggleMenu(false);});
      const full=button('Fullscreen','<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',async()=>{try{document.fullscreenElement?await document.exitFullscreen():await wrap.requestFullscreen();}catch{toast('Fullscreen is unavailable.',true);}});
      row.append(spacer,speed,full);chrome.append(timeline,row);controller.append(chrome);
      const center=element('div','player-center-controls');center.slot='centered-chrome';
      const back=button('Back 10 seconds','<path d="M3 9a9 9 0 1 1 1 9M3 4v5h5"/><text x="12" y="15" text-anchor="middle" stroke="none" fill="currentColor" font-size="8" font-weight="600">10</text>',()=>seek(-10));
      const play=button('Play lesson','<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>',()=>v.paused?v.play().catch(()=>{}):v.pause());
      const forward=button('Forward 10 seconds','<path d="M21 9a9 9 0 1 0-1 9M21 4v5h-5"/><text x="12" y="15" text-anchor="middle" stroke="none" fill="currentColor" font-size="8" font-weight="600">10</text>',()=>seek(10));
      play.classList.add('player-center-play');center.append(back,play,forward);controller.append(center);
      const updatePlay=()=>{
        stage.classList.toggle('is-playing',!v.paused);
        play.setAttribute('aria-label',v.paused?'Play lesson':'Pause lesson');play.title=v.paused?'Play lesson':'Pause lesson';
        play.querySelector('svg').innerHTML=v.paused?'<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>':'<path d="M8 5v14M16 5v14" stroke-width="4"/>';
      };
      for(const event of ['play','pause','ended'])v.addEventListener(event,updatePlay);
      const unlock=element('button','player-unlock','Hold to unlock');unlock.type='button';unlock.hidden=true;unlock.setAttribute('aria-label','Hold for one second to unlock, or press Enter or Escape');stage.append(unlock);
      function setLock(locked){
        a.locked=locked;toggleMenu(false);stage.classList.toggle('controls-locked',locked);chrome.inert=locked;top.inert=locked;center.inert=locked;
        unlock.hidden=!locked;pinControls();unlock.textContent='Hold to unlock';
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
      stage.addEventListener('focusin',pinControls);
      stage.addEventListener('focusout',()=>queueMicrotask(pinControls));
    }else{
      controller.replaceWith(v);stage.classList.add('native-fallback');
    }
    const volumeKey='courseforge-volume-'+window.CourseForgeAccount?.user?.id;
    try{const saved=JSON.parse(localStorage.getItem(volumeKey)||'null');if(saved){v.volume=Math.max(0,Math.min(1,saved.volume));v.muted=Boolean(saved.muted);}}catch{}
    v.addEventListener('volumechange',()=>{try{localStorage.setItem(volumeKey,JSON.stringify({volume:v.volume,muted:v.muted}));}catch{}});
    v.src=session.media_url;return v;
  }
  function suspend(){if(active){active.recovery.suspend();active.send('hidden');active.running=false;active.video.pause();}}
  window.addEventListener('offline',()=>{if(active){active.running=false;active.send('hidden');active.status.textContent='You’re offline. Waiting for your connection…';}});
  window.addEventListener('online',()=>active?.recovery.resume());
  window.CourseForgeNative={open,stop,seek,suspend,toolbar:()=>element('div'),currentPosition:()=>active?position(active):null,
    video:()=>active?.video,locked:()=>Boolean(active?.locked),unlock:()=>active?.unlock?.(),
    resetBaseline:()=>{if(active){active.last=performance.now();active.position=position(active);active.running=false;active.blocked=false;}},
    pauseForRecovery:()=>{if(active){active.blocked=true;active.recovery.suspend();active.running=false;active.video.pause();}},
    resumeRecovery:()=>active?.recovery.resume(),
    trackingNotice:()=>{}};
})();
