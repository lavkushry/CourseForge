'use strict';
/* Presentation only: existing classes, event handlers and player ownership stay intact. */
(() => {
  const interactive = 'button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[tabindex]:not([tabindex="-1"]),media-play-button,media-mute-button,media-seek-backward-button,media-seek-forward-button,media-fullscreen-button,media-time-range,media-volume-range,.recent-chip,.drawer-episode-item,[onclick]';
  const cards = '.panel,.compact-panel,.course-card,.stream-card,.academy-course,.lab-card,.topic,.flip-card,.metric,.metric-card,.saved-note,.material-item-card,.planner-day,.week-day';
  const chips = '.tag,.pill-mini,.nav-counter,.course-tag,.source-chip,.academy-course-category,.admin-mat-chip,.status-badge,.badge-count,.billboard-badge,.meta-badge-hd,.meta-badge-cert,.new-chip,.recent-chip,.meta-badge-quality,.meta-badge-audio';
  const tabs = '#catalogNav,#learningNav,#adminNav,#accountNav,.nav-item,.mobile-tab,.topbar-nav-link,.lesson-tab,.title-tab,.filter,.mode,.category-pill,[data-theme-option],[role=tab]';
  const rows = '.lesson-link,.timeline-btn,.saved-path,.search-result-item,.interview-topic-btn,.drawer-episode-item,summary';
  const iconButtons = '.icon-button,.player-button,.shortcuts-close,.row-nav-btn,.billboard-dot,.accent-dot,.history-play-overlay,.episode-thumb-play,.title-dialog-close,.chip-remove,.drawer-close-btn';
  const mediaIcons={
    'media-play-button':{play:'i-play',pause:'i-pause'},
    'media-mute-button':{off:'i-volume-mute',low:'i-volume',medium:'i-volume',high:'i-volume'},
    'media-seek-backward-button':{icon:'i-replay-10'},
    'media-seek-forward-button':{icon:'i-forward-10'},
    'media-fullscreen-button':{enter:'i-fullscreen',exit:'i-fullscreen'},
  };
  function classify(e) {
    const tag=e.tagName.toLowerCase();
    if(tag==='media-controller'||e.matches('.native-player-stage'))return ['card','media'];
    if(e.matches('.player-speed-options button'))return ['tab','section'];
    if(e.matches('dialog,[role=dialog]'))return ['modal','panel'];
    if (tag==='input' || tag==='textarea') return [e.matches('[type=checkbox],[type=radio],[type=range]')?'select':'input',e.matches('[type=checkbox],[type=radio]')?'checkable':e.matches('[type=range]')?'range':tag==='textarea'?'multiline':'text'];
    if (tag==='select' || tag.endsWith('-range')) return ['select',tag==='select'?'list':'range'];
    if (e.matches(cards)) return ['card',e.matches('.course-card,.stream-card')?'media':'panel'];
    if (e.matches(rows)) return ['row','default'];
    if (e.matches(tabs)) return ['tab',e.matches('#catalogNav,#learningNav,#adminNav,#accountNav,.nav-item,.mobile-tab,.topbar-nav-link')?'navigation':'section'];
    if (e.matches(chips)) return ['chip','action'];
    if (e.matches(iconButtons) || tag.startsWith('media-')) return ['button','icon'];
    // Shared actions have the same emphasis even when their historical markup differs.
    const text=(e.getAttribute('aria-label')||e.textContent||'').trim();
    if (/^(Sign in|Refresh|Reload|Retry)\b/i.test(text) || e.matches('.material-download-btn')) return ['button',/^Sign in\b/i.test(text)?'primary':'secondary'];
    if (e.matches('.btn-primary,.btn-white')) return ['button','primary'];
    if (e.matches('.btn,.player-unlock')) return ['button','secondary'];
    return ['button','ghost'];
  }
  function apply(root) {
    // Replace vendor fallback glyphs through its supported slots. Media state,
    // events, ownership and accessibility remain managed by the existing player.
    const mediaSelector=Object.keys(mediaIcons).join(',');
    for(const e of [...(root.matches?.(mediaSelector)?[root]:[]),...root.querySelectorAll(mediaSelector)]){
      for(const [slot,id] of Object.entries(mediaIcons[e.tagName.toLowerCase()])){
        if(e.querySelector('svg[slot="'+slot+'"]'))continue;
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('class','icon');svg.setAttribute('slot',slot);svg.setAttribute('aria-hidden','true');
        const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#'+id);svg.append(use);e.append(svg);
      }
    }
    const isInteractive=e=>e.matches(interactive)||typeof e.onclick==='function';
    const nodes=[...(root.matches&&isInteractive(root)?[root]:[]),...[...root.querySelectorAll('*')].filter(isInteractive)];
    for (const e of nodes) {
      const [component,variant]=classify(e);
      e.dataset.uiComponent=component;e.dataset.uiVariant=variant;
    }
    for (const e of root.querySelectorAll(cards+','+chips+',dialog,[role=dialog]')) {
      if(e.matches(interactive)||typeof e.onclick==='function')continue;
      e.dataset.uiComponent=e.matches('dialog,[role=dialog]')?'modal':e.matches(chips)?'chip':'card';
      e.dataset.uiVariant=e.matches('.course-card,.stream-card')?'media':'panel';
    }
  }
  apply(document);
  new MutationObserver(records=>{
    for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)apply(node);
  }).observe(document.documentElement,{subtree:true,childList:true});
  window.CourseForgeComponents={apply,classify,interactive};
})();
