'use strict';
/* Bounded, ordered playback delivery. Retries keep the same event sequence. */
(() => {
  window.CourseForgePlaybackDelivery = ({request,onSaved,onError}) => {
    let queue=[],running=false,stopped=false,controller=null;
    function stop(){stopped=true;queue=[];controller?.abort();}
    async function deliver(packet){
      for(let attempt=0;attempt<2;attempt++){
        if(stopped)return;
        if(navigator.onLine===false)throw new Error('You are offline. Tracking resumes when the connection returns.');
        controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),4000);
        try{return await request(packet,controller.signal);}
        catch(error){
          if(stopped)return;
          // Access failures and rate limits need user/server recovery.
          const transient=!error.status||error.status===408||error.status>=500;
          if(!transient||attempt===1)throw error;
        }finally{clearTimeout(timeout);controller=null;}
      }
    }
    async function pump(){
      if(running||stopped)return;running=true;
      try{
        while(queue.length&&!stopped){
          const packet=queue.shift();
          try{const result=await deliver(packet);if(!stopped)onSaved(result);}
          catch(error){
            if(stopped)return;
            if([401,403,404].includes(error.status))stop();
            onError(error);
          }
        }
      }finally{running=false;}
    }
    function send(packet){
      if(stopped)return;
      // Keep transitions in order, replacing only queued heartbeat samples.
      if(packet.event==='heartbeat')queue=queue.filter(e=>e.event!=='heartbeat');
      if(queue.length>=128){
        stop();const error=new Error('Tracking could not keep up. Reopen this lesson to continue.');
        error.code='queue_full';onError(error);return;
      }
      queue.push(packet);void pump();
    }
    return {send,stop};
  };
})();
