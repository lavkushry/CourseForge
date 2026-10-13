import { svgIcon, type IconName } from '../icons';
import './chrome.css';
import { formatTime } from './controller';

export interface ChromeActions {
  seek(position: number): void;
  nextLesson?: () => void;
  getNextLesson?: () => void;
  prevLesson?: () => void;
  toggleTheater?: () => void;
  markComplete?: () => Promise<void>;
  onWatchNext?: () => void;
  onCancelNext?: () => void;
  toggleZen?: () => void;
}

function ui<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function mountPlayerChrome(
  wrap: HTMLElement,
  video: HTMLVideoElement,
  actions: ChromeActions,
  signal: AbortSignal
): void {
  const media = wrap.querySelector<HTMLElement>('media-controller');
  const row = media?.querySelector<HTMLElement>('media-control-bar');
  const timeline = row?.querySelector<HTMLElement>('media-time-range');
  if (!media || !row || !timeline || signal.aborted) return;

  media.setAttribute('fullscreenelement', wrap.id);
  wrap.classList.add('player-enhanced');
  row.classList.add('cinema-control-row');
  timeline.classList.add('cinema-timeline');
  timeline.setAttribute('aria-label', 'Seek lesson');
  media.insertBefore(timeline, row);

  const source = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
  const delegates: Array<{ button: HTMLButtonElement; source: HTMLButtonElement }> = [];

  const delegate = (label: string, selector: string, iconName: IconName, extraClass = '') => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `cinema-button ${extraClass}`.trim();
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(svgIcon(iconName));
    const target = source(selector);
    if (target) {
      delegates.push({ button: node, source: target });
      node.addEventListener('click', () => target.click(), { signal });
    } else {
      node.disabled = true;
    }
    return node;
  };

  // 1. TOP CHROME: Title breadcrumb & Quick Actions
  const top = ui('div', 'cinema-top-actions');
  top.slot = 'top-chrome';

  const breadcrumb = ui('div', 'cinema-breadcrumb');
  const courseCrumb = ui('span', 'cinema-course-crumb');
  courseCrumb.id = 'cinema-course-crumb';
  const sep = ui('span', 'cinema-sep', '/');
  const lessonCrumb = ui('span', 'cinema-lesson-crumb');
  lessonCrumb.id = 'cinema-lesson-crumb';
  breadcrumb.append(courseCrumb, sep, lessonCrumb);

  const topButtons = ui('div', 'cinema-top-buttons');
  const episodes = delegate('Course lessons', '#episodes', 'grid');
  episodes.setAttribute('aria-haspopup', 'dialog');

  const capture = delegate('Capture lesson timestamp', '#capture', 'edit');

  const zenBtn = document.createElement('button');
  zenBtn.type = 'button';
  zenBtn.className = 'cinema-button cinema-zen-btn';
  zenBtn.id = 'studio-zen-toggle';
  zenBtn.title = 'Toggle Zen Study Studio Mode (Z)';
  zenBtn.setAttribute('aria-label', 'Toggle Zen Study Studio Mode');
  zenBtn.append(svgIcon('target'));
  zenBtn.addEventListener('click', () => {
    const isZen = document.body.classList.toggle('in-zen-studio');
    zenBtn.setAttribute('aria-pressed', String(isZen));
    actions.toggleZen?.();
    triggerHud('target', isZen ? 'Zen Mode On' : 'Zen Mode Off');
  }, { signal });

  const shortcutsBtn = document.createElement('button');
  shortcutsBtn.type = 'button';
  shortcutsBtn.className = 'cinema-button';
  shortcutsBtn.title = 'Keyboard shortcuts';
  shortcutsBtn.setAttribute('aria-label', 'Keyboard shortcuts');
  shortcutsBtn.append(svgIcon('help'));

  const lock = delegate('Lock player controls', '#lock-controls', 'lock');
  topButtons.append(episodes, capture, zenBtn, shortcutsBtn, lock);
  top.append(breadcrumb, topButtons);
  media.append(top);

  // Sync breadcrumb titles
  const updateBreadcrumb = () => {
    const courseEl = document.querySelector('#course-name') || document.querySelector('#course-name-sub');
    const lessonEl = document.querySelector('#lesson-title');
    courseCrumb.textContent = courseEl?.textContent || 'CourseForge';
    lessonCrumb.textContent = lessonEl?.textContent || 'Lesson';
  };
  const titleObserver = new MutationObserver(updateBreadcrumb);
  const courseNameEl = document.querySelector('#course-name');
  const lessonTitleEl = document.querySelector('#lesson-title');
  if (courseNameEl) titleObserver.observe(courseNameEl, { childList: true, characterData: true, subtree: true });
  if (lessonTitleEl) titleObserver.observe(lessonTitleEl, { childList: true, characterData: true, subtree: true });
  updateBreadcrumb();

  // 2. CENTER CHROME: Center Play Button, Double-tap Ripples, HUD Pill
  const center = ui('div', 'cinema-center-actions');
  center.slot = 'centered-chrome';

  const leftRipple = ui('div', 'cinema-ripple ripple-left');
  leftRipple.hidden = true;
  leftRipple.append(svgIcon('skip-back-10'), ui('span', 'ripple-text', '-10s'));

  const rightRipple = ui('div', 'cinema-ripple ripple-right');
  rightRipple.hidden = true;
  rightRipple.append(svgIcon('skip-forward-10'), ui('span', 'ripple-text', '+10s'));

  const centerPlay = document.createElement('button');
  centerPlay.type = 'button';
  centerPlay.className = 'cinema-button cinema-center-play';
  centerPlay.setAttribute('aria-label', 'Play lesson');
  centerPlay.title = 'Play lesson (Space/K)';
  centerPlay.append(svgIcon('play'));
  centerPlay.addEventListener('click', () => {
    source('#play-toggle')?.click();
  }, { signal });

  const hudPill = ui('div', 'cinema-seek-feedback player-hud-pill');
  hudPill.hidden = true;
  hudPill.setAttribute('aria-live', 'polite');
  const hudIconWrap = ui('span', 'hud-icon');
  const hudText = ui('span', 'hud-text');
  hudPill.append(hudIconWrap, hudText);

  center.append(leftRipple, centerPlay, rightRipple, hudPill);
  media.append(center);

  let hudTimer: any = undefined;
  const triggerHud = (icon: IconName, text: string) => {
    hudIconWrap.replaceChildren(svgIcon(icon));
    hudText.textContent = text;
    hudPill.hidden = false;
    hudPill.classList.remove('is-active');
    void hudPill.offsetWidth;
    hudPill.classList.add('is-active');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hudPill.classList.remove('is-active');
      hudPill.hidden = true;
    }, 1100);
  };

  const showRipple = (side: 'left' | 'right') => {
    const el = side === 'left' ? leftRipple : rightRipple;
    el.hidden = false;
    el.classList.remove('is-animating');
    void el.offsetWidth;
    el.classList.add('is-animating');
    setTimeout(() => {
      el.classList.remove('is-animating');
      el.hidden = true;
    }, 600);
  };

  const updatePlayState = () => {
    const paused = video.paused;
    centerPlay.setAttribute('aria-label', paused ? 'Play lesson' : 'Pause lesson');
    centerPlay.title = paused ? 'Play lesson (Space/K)' : 'Pause lesson (Space/K)';
    centerPlay.replaceChildren(svgIcon(paused ? 'play' : 'pause'));
    center.classList.toggle('is-playing', !paused);
    bottomPlayBtn.replaceChildren(svgIcon(paused ? 'play' : 'pause'));
    bottomPlayBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    bottomPlayBtn.title = paused ? 'Play (k)' : 'Pause (k)';
  };
  for (const ev of ['play', 'pause', 'ended', 'emptied']) {
    video.addEventListener(ev, updatePlayState, { signal });
  }

  // 3. TIMELINE SCRUBBER & FLOATING TIME TOOLTIP
  const tooltip = ui('div', 'timeline-tooltip');
  tooltip.hidden = true;
  timeline.append(tooltip);

  timeline.addEventListener('mousemove', (e: MouseEvent) => {
    const rect = timeline.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pos = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = pos / rect.width;
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const hoverTime = dur * pct;
    tooltip.textContent = formatTime(hoverTime);
    tooltip.style.left = `${pos}px`;
    tooltip.hidden = false;
  }, { signal });

  timeline.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  }, { signal });

  // 4. BOTTOM CHROME CONTROLS ROW
  row.replaceChildren();

  const leftGroup = ui('div', 'cinema-left-group');

  const bottomPlayBtn = document.createElement('button');
  bottomPlayBtn.type = 'button';
  bottomPlayBtn.className = 'cinema-button cinema-play-btn';
  bottomPlayBtn.title = 'Play (k)';
  bottomPlayBtn.setAttribute('aria-label', 'Play');
  bottomPlayBtn.append(svgIcon('play'));
  bottomPlayBtn.addEventListener('click', () => {
    source('#play-toggle')?.click();
  }, { signal });

  const skipBack10 = document.createElement('button');
  skipBack10.type = 'button';
  skipBack10.className = 'cinema-button';
  skipBack10.title = 'Rewind 10s (j)';
  skipBack10.setAttribute('aria-label', 'Rewind 10s');
  skipBack10.append(svgIcon('skip-back-10'));
  skipBack10.addEventListener('click', () => {
    actions.seek(video.currentTime - 10);
    showRipple('left');
    triggerHud('skip-back-10', '-10s');
  }, { signal });

  const skipFwd10 = document.createElement('button');
  skipFwd10.type = 'button';
  skipFwd10.className = 'cinema-button';
  skipFwd10.title = 'Forward 10s (l)';
  skipFwd10.setAttribute('aria-label', 'Forward 10s');
  skipFwd10.append(svgIcon('skip-forward-10'));
  skipFwd10.addEventListener('click', () => {
    actions.seek(video.currentTime + 10);
    showRipple('right');
    triggerHud('skip-forward-10', '+10s');
  }, { signal });

  const prevLessonBtn = document.createElement('button');
  prevLessonBtn.type = 'button';
  prevLessonBtn.className = 'cinema-button';
  prevLessonBtn.title = 'Previous lesson (Shift+P)';
  prevLessonBtn.setAttribute('aria-label', 'Previous lesson');
  prevLessonBtn.append(svgIcon('prev-lesson'));
  prevLessonBtn.addEventListener('click', () => {
    actions.prevLesson?.();
    triggerHud('prev-lesson', 'Previous Lesson');
  }, { signal });

  const nextLessonBtn = document.createElement('button');
  nextLessonBtn.type = 'button';
  nextLessonBtn.className = 'cinema-button';
  nextLessonBtn.title = 'Next lesson (Shift+N)';
  nextLessonBtn.setAttribute('aria-label', 'Next lesson');
  nextLessonBtn.append(svgIcon('next-lesson'));
  nextLessonBtn.addEventListener('click', () => {
    const nextBtn = document.querySelector<HTMLButtonElement>('#next-lesson');
    if (nextBtn && !nextBtn.disabled) nextBtn.click();
    else if (actions.nextLesson) actions.nextLesson();
    else actions.onWatchNext?.();
    triggerHud('next-lesson', 'Next Lesson');
  }, { signal });

  const volumeGroup = ui('div', 'cinema-volume-group');
  const volumeBtn = document.createElement('button');
  volumeBtn.type = 'button';
  volumeBtn.className = 'cinema-button cinema-volume-btn';
  volumeBtn.title = 'Mute (m)';
  volumeBtn.setAttribute('aria-label', 'Mute audio');
  volumeBtn.append(svgIcon('volume'));

  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = String(video.volume);
  volumeSlider.className = 'cinema-volume-slider';
  volumeSlider.setAttribute('aria-label', 'Volume');

  const updateVolumeUI = () => {
    const muted = video.muted || video.volume === 0;
    volumeBtn.replaceChildren(svgIcon(muted ? 'volume-mute' : 'volume'));
    volumeBtn.title = muted ? 'Unmute (m)' : 'Mute (m)';
    volumeSlider.value = muted ? '0' : String(video.volume);
  };
  video.addEventListener('volumechange', updateVolumeUI, { signal });
  updateVolumeUI();

  volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    triggerHud(video.muted ? 'volume-mute' : 'volume', video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
  }, { signal });

  volumeSlider.addEventListener('input', () => {
    video.volume = Number(volumeSlider.value);
    video.muted = false;
    triggerHud('volume', `Volume ${Math.round(video.volume * 100)}%`);
  }, { signal });

  volumeGroup.append(volumeBtn, volumeSlider);

  let showRemaining = false;
  const timeDisplay = document.createElement('button');
  timeDisplay.type = 'button';
  timeDisplay.className = 'cinema-time-btn';
  timeDisplay.title = 'Click to toggle remaining time';
  timeDisplay.setAttribute('aria-label', 'Playback time');

  const updateTimeText = () => {
    const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    if (showRemaining) {
      const rem = Math.max(0, dur - cur);
      timeDisplay.textContent = `-${formatTime(rem)}`;
    } else {
      timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }
  };
  timeDisplay.addEventListener('click', () => {
    showRemaining = !showRemaining;
    updateTimeText();
  }, { signal });
  video.addEventListener('timeupdate', updateTimeText, { signal });
  video.addEventListener('loadedmetadata', updateTimeText, { signal });
  updateTimeText();

  leftGroup.append(
    bottomPlayBtn,
    skipBack10,
    skipFwd10,
    prevLessonBtn,
    nextLessonBtn,
    volumeGroup,
    timeDisplay
  );
  row.append(leftGroup);

  const spacer = ui('span', 'cinema-spacer');
  row.append(spacer);

  const rightGroup = ui('div', 'cinema-right-group');

  let loopA: number | null = null;
  let loopB: number | null = null;
  const loopBtn = document.createElement('button');
  loopBtn.className = 'cinema-button cinema-loop-btn';
  loopBtn.type = 'button';
  loopBtn.title = 'A-B Loop Repeat (Set marker A)';
  loopBtn.setAttribute('aria-label', 'A-B Loop repeat');
  loopBtn.append(svgIcon('loop'));
  loopBtn.addEventListener('click', () => {
    if (loopA === null) {
      loopA = video.currentTime;
      loopBtn.setAttribute('aria-pressed', 'true');
      loopBtn.title = `Loop A set at ${formatTime(loopA)}. Click to set marker B.`;
      triggerHud('loop', `Loop A: ${formatTime(loopA)}`);
    } else if (loopB === null) {
      loopB = Math.max(loopA + 1, video.currentTime);
      loopBtn.title = `Looping ${formatTime(loopA)} - ${formatTime(loopB)}. Click to clear.`;
      triggerHud('loop', `Loop: ${formatTime(loopA)} - ${formatTime(loopB)}`);
    } else {
      loopA = null;
      loopB = null;
      loopBtn.setAttribute('aria-pressed', 'false');
      loopBtn.title = 'A-B Loop Repeat (Set marker A)';
      triggerHud('loop', 'Loop cleared');
    }
  }, { signal });
  video.addEventListener('timeupdate', () => {
    if (loopA !== null && loopB !== null && video.currentTime >= loopB) {
      video.currentTime = loopA;
    }
  }, { signal });
  rightGroup.append(loopBtn);

  const autoplayToggle = document.createElement('button');
  autoplayToggle.type = 'button';
  autoplayToggle.className = 'cinema-button cinema-autoplay-btn';
  autoplayToggle.title = 'Autoplay next lesson';
  autoplayToggle.setAttribute('aria-label', 'Autoplay next lesson');
  const autoplayCheckbox = document.querySelector<HTMLInputElement>('#autoplay');
  const updateAutoplayBtn = () => {
    const isAuto = autoplayCheckbox?.checked ?? false;
    autoplayToggle.setAttribute('aria-pressed', String(isAuto));
    autoplayToggle.classList.toggle('active', isAuto);
    autoplayToggle.title = isAuto ? 'Autoplay is on' : 'Autoplay is off';
  };
  autoplayToggle.append(svgIcon('pulse'), ui('span', 'autoplay-label', 'AUTO'));
  autoplayToggle.addEventListener('click', () => {
    if (autoplayCheckbox) {
      autoplayCheckbox.checked = !autoplayCheckbox.checked;
      autoplayCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      updateAutoplayBtn();
      triggerHud('pulse', autoplayCheckbox.checked ? 'Autoplay On' : 'Autoplay Off');
    }
  }, { signal });
  autoplayCheckbox?.addEventListener('change', updateAutoplayBtn, { signal });
  updateAutoplayBtn();
  rightGroup.append(autoplayToggle);

  const speedGroup = ui('div', 'cinema-popover-group speed-group');
  const speedBtn = document.createElement('button');
  speedBtn.type = 'button';
  speedBtn.className = 'cinema-button cinema-speed-btn';
  speedBtn.title = 'Playback speed';
  speedBtn.setAttribute('aria-label', 'Playback speed');
  const speedLabel = ui('span', 'speed-badge', `${video.playbackRate}x`);
  speedBtn.append(speedLabel);

  const speedPopover = ui('div', 'cinema-frosted-popover speed-popover');
  speedPopover.hidden = true;
  const speedRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  const externalSpeed = document.querySelector<HTMLSelectElement>('#speed');
  const internalSelect = document.createElement('select');
  internalSelect.className = 'cinema-speed sr-only-actionable';
  internalSelect.setAttribute('aria-label', 'In-player playback speed');
  for (const r of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const opt = document.createElement('option');
    opt.value = String(r);
    opt.textContent = `${r}×`;
    internalSelect.append(opt);
  }
  speedGroup.append(internalSelect);

  const renderSpeedPopover = () => {
    speedPopover.replaceChildren();
    const heading = ui('div', 'popover-heading', 'Playback Speed');
    speedPopover.append(heading);

    for (const rate of speedRates) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'popover-item' + (video.playbackRate === rate ? ' active' : '');
      item.textContent = `${rate}x`;
      item.addEventListener('click', () => {
        video.playbackRate = rate;
        speedLabel.textContent = `${rate}x`;
        internalSelect.value = String(rate);
        if (externalSpeed) {
          externalSpeed.value = String(rate);
          externalSpeed.dispatchEvent(new Event('change', { bubbles: true }));
        }
        speedPopover.hidden = true;
        triggerHud('settings', `${rate}x Speed`);
      }, { signal });
      speedPopover.append(item);
    }
  };

  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    qualityPopover.hidden = true;
    renderSpeedPopover();
    speedPopover.hidden = !speedPopover.hidden;
    pin();
  }, { signal });

  const syncSpeed = () => {
    const rate = video.playbackRate;
    speedLabel.textContent = `${rate}x`;
    internalSelect.value = String(rate);
    if (externalSpeed && externalSpeed.value !== String(rate)) {
      externalSpeed.value = String(rate);
    }
  };
  video.addEventListener('ratechange', syncSpeed, { signal });
  video.addEventListener('loadedmetadata', syncSpeed, { signal });
  internalSelect.addEventListener('change', () => {
    const val = Number(internalSelect.value);
    video.playbackRate = val;
    syncSpeed();
    if (externalSpeed) {
      externalSpeed.value = String(val);
      externalSpeed.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { signal });
  externalSpeed?.addEventListener('change', () => {
    const val = Number(externalSpeed.value);
    video.playbackRate = val;
    syncSpeed();
  }, { signal });
  syncSpeed();

  speedGroup.append(speedBtn, speedPopover);
  rightGroup.append(speedGroup);

  const qualityGroup = ui('div', 'cinema-popover-group quality-group');
  const qualityBtn = document.createElement('button');
  qualityBtn.type = 'button';
  qualityBtn.className = 'cinema-button cinema-quality-btn';
  qualityBtn.title = 'Video Quality';
  qualityBtn.setAttribute('aria-label', 'Video Quality');
  const qualityBadge = ui('span', 'quality-badge', '1080p');
  qualityBtn.append(qualityBadge);

  const qualityPopover = ui('div', 'cinema-frosted-popover quality-popover');
  qualityPopover.hidden = true;
  const qualityOptions = ['Auto (1080p)', '1080p', '720p', '480p'];
  let currentQuality = 'Auto (1080p)';

  const renderQualityPopover = () => {
    qualityPopover.replaceChildren();
    const heading = ui('div', 'popover-heading', 'Streaming Quality');
    qualityPopover.append(heading);

    for (const q of qualityOptions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'popover-item' + (currentQuality === q ? ' active' : '');
      item.textContent = q;
      item.addEventListener('click', () => {
        currentQuality = q;
        qualityBadge.textContent = q.startsWith('Auto') ? 'Auto' : q;
        qualityPopover.hidden = true;
        triggerHud('quality', `Quality: ${q}`);
      }, { signal });
      qualityPopover.append(item);
    }
  };

  qualityBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedPopover.hidden = true;
    renderQualityPopover();
    qualityPopover.hidden = !qualityPopover.hidden;
    pin();
  }, { signal });

  qualityGroup.append(qualityBtn, qualityPopover);
  rightGroup.append(qualityGroup);

  const ccBtn = document.createElement('button');
  ccBtn.type = 'button';
  ccBtn.className = 'cinema-button';
  ccBtn.title = 'Subtitles / CC (c)';
  ccBtn.setAttribute('aria-label', 'Subtitles');
  ccBtn.append(svgIcon('captions'));
  let captionsEnabled = false;
  ccBtn.addEventListener('click', () => {
    captionsEnabled = !captionsEnabled;
    const tracks = video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr) tr.mode = captionsEnabled ? 'showing' : 'hidden';
    }
    ccBtn.setAttribute('aria-pressed', String(captionsEnabled));
    ccBtn.classList.toggle('active', captionsEnabled);
    triggerHud('captions', captionsEnabled ? 'Subtitles On' : 'Subtitles Off');
  }, { signal });
  rightGroup.append(ccBtn);

  const pip = delegate('Picture in picture', '#pip-toggle', 'pip');
  rightGroup.append(pip);

  const theaterBtn = delegate('Toggle theater mode', '#theater', 'theater');
  rightGroup.append(theaterBtn);

  const full = delegate('Toggle fullscreen', '#fullscreen', 'fullscreen');
  rightGroup.append(full);

  row.append(rightGroup);

  document.addEventListener('click', (e) => {
    if (!speedGroup.contains(e.target as Node)) speedPopover.hidden = true;
    if (!qualityGroup.contains(e.target as Node)) qualityPopover.hidden = true;
  }, { signal });

  // 5. AUTOHIDE & ACTIVITY TRACKING (2.5 seconds)
  let autohideTimer: any = undefined;
  const isPopoverOpen = () => !speedPopover.hidden || !qualityPopover.hidden || !shortcutsPopover.hidden;

  const showControls = () => {
    wrap.classList.remove('user-inactive');
    clearTimeout(autohideTimer);
    if (!video.paused && !isPopoverOpen() && !wrap.classList.contains('controls-locked')) {
      autohideTimer = setTimeout(() => {
        if (!video.paused && !isPopoverOpen() && !wrap.classList.contains('controls-locked')) {
          wrap.classList.add('user-inactive');
        }
      }, 2500);
    }
  };

  wrap.addEventListener('mousemove', showControls, { signal });
  wrap.addEventListener('pointermove', showControls, { signal });
  wrap.addEventListener('pointerdown', showControls, { signal });
  wrap.addEventListener('touchstart', showControls, { signal });
  video.addEventListener('play', showControls, { signal });
  video.addEventListener('pause', () => {
    wrap.classList.remove('user-inactive');
    clearTimeout(autohideTimer);
  }, { signal });

  const dialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
  const prevParent = dialog ? dialog.parentElement : null;
  if (dialog) {
    wrap.append(dialog);
    let openedFromInPlayer = false;
    episodes.addEventListener('click', () => {
      openedFromInPlayer = true;
      episodes.setAttribute('aria-expanded', String(dialog.open));
    }, { signal });
    dialog.addEventListener('close', () => {
      episodes.setAttribute('aria-expanded', 'false');
      if (openedFromInPlayer && wrap.isConnected && !signal.aborted) {
        episodes.focus();
      }
      openedFromInPlayer = false;
    }, { signal });
  }

  const shortcutsPopover = ui('div', 'player-shortcuts-popover');
  shortcutsPopover.hidden = true;
  shortcutsPopover.setAttribute('role', 'dialog');
  shortcutsPopover.setAttribute('aria-label', 'Keyboard shortcuts cheatsheet');
  shortcutsPopover.innerHTML = `
    <div class="shortcuts-header">
      <strong>Keyboard Shortcuts</strong>
      <button type="button" class="cinema-button shortcuts-close" aria-label="Close shortcuts">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="shortcuts-grid">
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Space</kbd><kbd>K</kbd></span><span class="shortcut-label">Play / Pause</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>J</kbd><kbd>←</kbd></span><span class="shortcut-label">Rewind 10s</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>L</kbd><kbd>→</kbd></span><span class="shortcut-label">Forward 10s</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>↑</kbd><kbd>↓</kbd></span><span class="shortcut-label">Volume ±5%</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>M</kbd></span><span class="shortcut-label">Mute / Unmute</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>F</kbd></span><span class="shortcut-label">Fullscreen</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>T</kbd><kbd>C</kbd></span><span class="shortcut-label">Theater Mode</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Shift+N</kbd></span><span class="shortcut-label">Next Lesson</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>Shift+P</kbd></span><span class="shortcut-label">Previous Lesson</span></div>
      <div class="shortcut-row"><span class="shortcut-keys"><kbd>&lt;</kbd><kbd>&gt;</kbd></span><span class="shortcut-label">Speed Down / Up</span></div>
    </div>
  `;
  wrap.append(shortcutsPopover);
  shortcutsBtn.addEventListener('click', () => {
    shortcutsPopover.hidden = !shortcutsPopover.hidden;
    pin();
  }, { signal });
  shortcutsPopover.querySelector('.shortcuts-close')?.addEventListener('click', () => {
    shortcutsPopover.hidden = true;
  }, { signal });

  const reflect = () => {
    for (const item of delegates) {
      item.button.disabled = item.source.disabled;
      const pressed = item.source.getAttribute('aria-pressed');
      if (pressed !== null) item.button.setAttribute('aria-pressed', pressed);
    }
    const pipAvailable = Boolean(document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function');
    pip.disabled = !pipAvailable || video.readyState < 1;
    pip.title = pipAvailable ? 'Picture in picture' : 'Picture in picture is unavailable in this browser';
    full.setAttribute('aria-pressed', String(document.fullscreenElement === wrap));
    full.title = document.fullscreenElement === wrap ? 'Exit fullscreen' : 'Fullscreen';
  };
  const observer = new MutationObserver(reflect);
  for (const item of delegates) {
    observer.observe(item.source, { attributes: true, attributeFilter: ['disabled', 'aria-pressed'] });
  }
  for (const event of ['loadedmetadata', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture']) {
    video.addEventListener(event, reflect, { signal });
  }
  document.addEventListener('fullscreenchange', reflect, { signal });
  reflect();

  // 6. KEYBOARD SHORTCUTS & VISUAL HUD PILL
  wrap.addEventListener('keydown', (event) => {
    const target = event.composedPath()[0];
    if (target instanceof HTMLElement && (target.matches('input,textarea,select') || target.isContentEditable)) return;
    if (wrap.classList.contains('controls-locked')) return;

    const key = event.key;
    const lower = key.toLowerCase();

    if ((key === ' ' || lower === 'k') && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      source('#play-toggle')?.click();
      triggerHud(video.paused ? 'pause' : 'play', video.paused ? 'Pause' : 'Play');
      return;
    }

    if ((lower === 'j' || key === 'ArrowLeft') && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.seek(video.currentTime - 10);
      showRipple('left');
      triggerHud('skip-back-10', '-10s');
      return;
    }

    if ((lower === 'l' || key === 'ArrowRight') && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.seek(video.currentTime + 10);
      showRipple('right');
      triggerHud('skip-forward-10', '+10s');
      return;
    }

    if (key === 'ArrowUp' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      video.volume = Math.min(1, video.volume + 0.05);
      video.muted = false;
      triggerHud('volume', `Volume ${Math.round(video.volume * 100)}%`);
      return;
    }

    if (key === 'ArrowDown' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      video.volume = Math.max(0, video.volume - 0.05);
      triggerHud('volume', `Volume ${Math.round(video.volume * 100)}%`);
      return;
    }

    if (lower === 'm' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      video.muted = !video.muted;
      triggerHud(video.muted ? 'volume-mute' : 'volume', video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
      return;
    }

    if (lower === 'f' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      source('#fullscreen')?.click();
      triggerHud('fullscreen', document.fullscreenElement === wrap ? 'Exit Fullscreen' : 'Fullscreen');
      return;
    }

    if ((lower === 't' || lower === 'c') && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      source('#theater')?.click();
      triggerHud('theater', 'Theater Mode');
      return;
    }

    if (key === 'N' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const nextBtn = document.querySelector<HTMLButtonElement>('#next-lesson');
      if (nextBtn && !nextBtn.disabled) nextBtn.click();
      else if (actions.nextLesson) actions.nextLesson();
      else actions.onWatchNext?.();
      triggerHud('next-lesson', 'Next Lesson');
      return;
    }

    if (key === 'P' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      actions.prevLesson?.();
      triggerHud('prev-lesson', 'Previous Lesson');
      return;
    }

    if (key === '<' || key === ',') {
      const idx = speedRates.findIndex(r => r === video.playbackRate);
      if (idx > 0) {
        const prevRate = speedRates[idx - 1];
        if (prevRate !== undefined) {
          video.playbackRate = prevRate;
          syncSpeed();
          triggerHud('settings', `${prevRate}x Speed`);
        }
      }
      return;
    }
    if (key === '>' || key === '.') {
      const idx = speedRates.findIndex(r => r === video.playbackRate);
      if (idx !== -1 && idx < speedRates.length - 1) {
        const nextRate = speedRates[idx + 1];
        if (nextRate !== undefined) {
          video.playbackRate = nextRate;
          syncSpeed();
          triggerHud('settings', `${nextRate}x Speed`);
        }
      }
      return;
    }

    if (key === 'Escape') {
      speedPopover.hidden = true;
      qualityPopover.hidden = true;
      shortcutsPopover.hidden = true;
    }
  }, { signal, capture: true });

  // 7. DOUBLE CLICK / DOUBLE TAP TO SEEK & RIPPLE
  let clickTimer: any = undefined;
  video.addEventListener('pointerup', (event) => {
    if (wrap.classList.contains('controls-locked')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const rect = video.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const width = rect.width;

    if (clickTimer !== undefined) {
      clearTimeout(clickTimer);
      clickTimer = undefined;

      if (clickX < width * 0.4) {
        actions.seek(video.currentTime - 10);
        showRipple('left');
        triggerHud('skip-back-10', '-10s');
      } else if (clickX > width * 0.6) {
        actions.seek(video.currentTime + 10);
        showRipple('right');
        triggerHud('skip-forward-10', '+10s');
      } else {
        source('#fullscreen')?.click();
      }
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = undefined;
        source('#play-toggle')?.click();
      }, 250);
    }
  }, { signal });

  const pin = () => {
    media.setAttribute('autohide', wrap.contains(document.activeElement) || Boolean(dialog?.open) || isPopoverOpen() ? '-1' : '3');
  };
  wrap.addEventListener('focusin', pin, { signal });
  wrap.addEventListener('focusout', () => {
    queueMicrotask(() => { if (!signal.aborted) pin(); });
  }, { signal });
  dialog?.addEventListener('close', pin, { signal });

  signal.addEventListener('abort', () => {
    observer.disconnect();
    titleObserver.disconnect();
    clearTimeout(hudTimer);
    clearTimeout(clickTimer);
    clearTimeout(autohideTimer);
    if (dialog && prevParent && prevParent.isConnected) prevParent.append(dialog);
    shortcutsPopover.remove();
  }, { once: true });
}
