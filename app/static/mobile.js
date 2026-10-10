'use strict';
(() => {
  const nav=document.createElement('nav');nav.className='mobile-tabs';nav.setAttribute('aria-label','Learning navigation');nav.hidden=true;
  for(const [label,view,glyph]of [['Home','dashboard','grid'],['Today','planner','clock'],['Courses','library','book'],['Review','reviews','cards']]){
    const b=make('button','mobile-tab',label);b.type='button';b.dataset.mobileView=view;b.prepend(icon(glyph));
    b.onclick=async()=>{if(document.getElementById('appShell').hidden)await window.CourseForgeAcademy.workspace();navigate(view);};nav.append(b);
  }
  const next=make('button','mobile-next btn btn-primary','Next lesson');next.type='button';next.hidden=true;
  next.onclick=()=>document.getElementById('nextLessonBtn').click();document.body.append(next,nav);
  function sync(){
    nav.hidden=!window.CourseForgeAccount?.user?.verified;
    const learning=document.body.classList.contains('in-learning');next.hidden=!learning||!state.currentVideoId;
    next.disabled=document.getElementById('nextLessonBtn').disabled;
    for(const b of nav.children){const selected=b.dataset.mobileView===state.view&&!document.getElementById('appShell').hidden;b.classList.toggle('active',selected);selected?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');}
  }
  const observer=new MutationObserver(sync);observer.observe(document.body,{attributes:true,attributeFilter:['class']});
  observer.observe(document.getElementById('appShell'),{attributes:true,attributeFilter:['hidden']});
  observer.observe(document.getElementById('nextLessonBtn'),{attributes:true,attributeFilter:['disabled']});
  window.addEventListener('courseforge-ready',sync);window.addEventListener('courseforge-navigate',sync);
  // An edge swipe goes back without capturing controls, writing, or scrolling.
  let start=null;
  document.addEventListener('pointerdown',e=>{
    start=e.pointerType==='touch'&&e.isPrimary&&e.clientX<=24&&document.body.classList.contains('in-learning')&&!e.target.closest('button,a,input,textarea,select,video,media-controller')?{x:e.clientX,y:e.clientY,t:performance.now()}:null;
  },{passive:true});
  document.addEventListener('pointercancel',()=>start=null,{passive:true});
  document.addEventListener('pointerup',e=>{const s=start;start=null;if(s&&e.clientX-s.x>=90&&Math.abs(e.clientY-s.y)<45&&performance.now()-s.t<700&&!document.fullscreenElement)navigate('library');},{passive:true});
  function keyboard(){const v=window.visualViewport;document.body.classList.toggle('phone-keyboard',Boolean(v&&innerHeight-v.height>150&&document.activeElement?.matches('input,textarea')));}
  window.visualViewport?.addEventListener('resize',keyboard);document.addEventListener('focusout',()=>setTimeout(keyboard,0));
})();
