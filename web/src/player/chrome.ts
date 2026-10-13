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
  getChapters?: () => any[];
  onOpenChapters?: () => void;
}

// Enhance the existing controls without creating a second player/ownership or
// preference transport. Every command delegates to the application's controller.
export function mountPlayerChrome(wrap: HTMLElement, video: HTMLVideoElement, actions: ChromeActions, signal: AbortSignal): void {
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

  const ui = (tag: string, className: string) => {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  };
  const source = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
  const delegates: Array<{ button: HTMLButtonElement; source: HTMLButtonElement }> = [];
  const delegate = (label: string, selector: string, iconName: IconName) => {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'cinema-button';
    node.title = label; node.setAttribute('aria-label', label);
    node.append(svgIcon(iconName));
    const target = source(selector);
    if (target) {
      delegates.push({ button: node, source: target });
      node.addEventListener('click', () => target.click(), { signal });
    } else node.disabled = true;
    return node;
  };

  // All essential commands remain descendants of the fullscreen element.
  const top = ui('div', 'cinema-top-actions'); top.slot = 'top-chrome';
  const capture = delegate('Capture lesson timestamp', '#capture', 'edit');
  const episodes = delegate('Course lessons', '#episodes', 'grid');
  episodes.setAttribute('aria-haspopup', 'dialog');
  const theater = delegate('Toggle theater mode', '#theater', 'theater');
  const lock = delegate('Lock player controls', '#lock-controls', 'lock');
  top.append(capture, episodes, theater, lock);
  media.append(top);

  const spacer = ui('span', 'cinema-spacer'); row.append(spacer);

  // A-B Loop Repeat for mastering complex code and engineering demonstrations
  let loopA: number | null = null;
  let loopB: number | null = null;
  const loopBtn = document.createElement('button');
  loopBtn.className = 'cinema-button';
  loopBtn.type = 'button';
  loopBtn.title = 'A-B Loop Repeat (Set marker A)';
  loopBtn.append(svgIcon('loop'));
  loopBtn.addEventListener('click', () => {
    if (loopA === null) {
      loopA = video.currentTime;
      loopBtn.setAttribute('aria-pressed', 'true');
      loopBtn.title = `Loop A set at ${formatTime(loopA)}. Click to set marker B.`;
    } else if (loopB === null) {
      loopB = Math.max(loopA + 1, video.currentTime);
      loopBtn.title = `Looping ${formatTime(loopA)} - ${formatTime(loopB)}. Click to clear.`;
    } else {
      loopA = null;
      loopB = null;
      loopBtn.setAttribute('aria-pressed', 'false');
      loopBtn.title = 'A-B Loop Repeat (Set marker A)';
    }
  }, { signal });
  row.append(loopBtn);

  video.addEventListener('timeupdate', () => {
    if (loopA !== null && loopB !== null && video.currentTime >= loopB) {
      video.currentTime = loopA;
    }
  }, { signal });

  const speed = document.createElement('select');
  speed.className = 'cinema-speed'; speed.setAttribute('aria-label', 'In-player playback speed');
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const option = document.createElement('option'); option.value = String(rate); option.textContent = `${rate}×`; speed.append(option);
  }
  const externalSpeed = document.querySelector<HTMLSelectElement>('#speed');
  speed.value = externalSpeed?.value || '1';
  speed.addEventListener('change', () => {
    if (!externalSpeed) return;
    externalSpeed.value = speed.value;
    externalSpeed.dispatchEvent(new Event('change', { bubbles: true }));
  }, { signal });
  video.addEventListener('ratechange', () => { speed.value = String(video.playbackRate); }, { signal });
  video.addEventListener('loadedmetadata', () => { speed.value = String(video.playbackRate); }, { signal });
  const pip = delegate('Picture in picture', '#pip-toggle', 'pip');
  const full = delegate('Toggle fullscreen', '#fullscreen', 'fullscreen');
  row.append(speed, pip, full);

  const center = ui('div', 'cinema-center-actions'); center.slot = 'centered-chrome';
  const play = delegate('Play lesson', '#play-toggle', 'play'); play.classList.add('cinema-center-play');
  center.append(play); media.append(center);
  const updatePlay = () => {
    const paused = video.paused;
    play.setAttribute('aria-label', paused ? 'Play lesson' : 'Pause lesson');
    play.title = paused ? 'Play lesson' : 'Pause lesson';
    play.replaceChildren(svgIcon(paused ? 'play' : 'pause'));
    center.classList.toggle('is-playing', !paused);
  };
  for (const event of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(event, updatePlay, { signal });
  updatePlay();

  const feedback = ui('span', 'cinema-seek-feedback'); feedback.hidden = true;
  feedback.setAttribute('aria-live', 'polite'); wrap.append(feedback);
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  video.addEventListener('seeked', () => {
    feedback.textContent = formatTime(video.currentTime); feedback.hidden = false;
    clearTimeout(feedbackTimer); feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 900);
  }, { signal });

  const dialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
  const previousParent = dialog?.parentElement;
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

  // Keep browser capability and current controller state visible, including
  // disabled controls during loading/conflict and active theater/lock state.
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
    speed.disabled = video.readyState < 1;
    speed.value = externalSpeed?.value || String(video.playbackRate);
  };
  const observer = new MutationObserver(reflect);
  for (const item of delegates) observer.observe(item.source, { attributes: true, attributeFilter: ['disabled', 'aria-pressed'] });
  for (const event of ['loadedmetadata', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture']) video.addEventListener(event, reflect, { signal });
  document.addEventListener('fullscreenchange', reflect, { signal });
  externalSpeed?.addEventListener('change', reflect, { signal });
  reflect();

  // The documented YouTube-style L command is forward seek; X remains lock.
  // Capture phase prevents the legacy shell's conflicting L-lock handler.
  wrap.addEventListener('keydown', event => {
    const target = event.composedPath()[0];
    if (event.key.toLowerCase() !== 'l' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || wrap.classList.contains('controls-locked')) return;
    if (target instanceof HTMLElement && (target.matches('input,textarea,select,button') || target.isContentEditable)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    actions.seek(video.currentTime + 10);
  }, { signal, capture: true });

  // A desktop click plays/pauses; double click enters/exits fullscreen without
  // two accidental play commands. Touch's double-tap seek stays in the shell.
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  video.addEventListener('pointerup', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || wrap.classList.contains('controls-locked')) return;
    if (clickTimer !== undefined) { clearTimeout(clickTimer); clickTimer = undefined; source('#fullscreen')?.click(); }
    else clickTimer = setTimeout(() => { clickTimer = undefined; source('#play-toggle')?.click(); }, 250);
  }, { signal });

  const pin = () => { media.setAttribute('autohide', wrap.contains(document.activeElement) || Boolean(dialog?.open) ? '-1' : '3'); };
  wrap.addEventListener('focusin', pin, { signal });
  wrap.addEventListener('focusout', () => { queueMicrotask(() => { if (!signal.aborted) pin(); }); }, { signal });
  dialog?.addEventListener('close', pin, { signal });
  signal.addEventListener('abort', () => {
    observer.disconnect(); clearTimeout(feedbackTimer); clearTimeout(clickTimer);
    if (dialog && previousParent?.isConnected) previousParent.append(dialog);
  }, { once: true });
}
