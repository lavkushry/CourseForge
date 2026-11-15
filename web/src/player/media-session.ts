/**
 * Platform Media Session (lock screen / headset) wired to the ownership-aware
 * lesson controller. Never reclaim a displaced lease from a lock-screen action.
 */

export interface MediaSessionActions {
  owns: () => boolean;
  play: () => void;
  pause: () => void;
  seek: (position: number) => void;
  seekBy: (delta: number) => void;
  next?: () => void;
  previous?: () => void;
  getPosition: () => number;
  getDuration: () => number;
  getTitle: () => string;
  getArtist: () => string;
}

export function bindMediaSession(actions: MediaSessionActions, signal: AbortSignal): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || signal.aborted) return;
  const session = navigator.mediaSession;

  const refreshMetadata = () => {
    try {
      session.metadata = new MediaMetadata({
        title: actions.getTitle() || 'Lesson',
        artist: actions.getArtist() || 'CourseForge',
        album: 'CourseForge',
      });
    } catch {
      /* MediaMetadata unsupported or partial */
    }
  };

  const refreshPosition = () => {
    try {
      const duration = actions.getDuration();
      const position = actions.getPosition();
      if (!Number.isFinite(duration) || duration <= 0) return;
      session.setPositionState?.({
        duration,
        playbackRate: 1,
        position: Math.max(0, Math.min(duration, position)),
      });
    } catch {
      /* setPositionState optional */
    }
  };

  const whenOwned = (fn: () => void) => () => {
    if (!actions.owns()) return;
    fn();
    refreshPosition();
  };

  try {
    session.setActionHandler('play', () => {
      // Ownership-aware play only — never deliberate takeover from OS chrome.
      if (!actions.owns()) return;
      actions.play();
      session.playbackState = 'playing';
      refreshPosition();
    });
    session.setActionHandler('pause', whenOwned(() => {
      actions.pause();
      session.playbackState = 'paused';
    }));
    session.setActionHandler('seekbackward', details => {
      if (!actions.owns()) return;
      const offset = details.seekOffset ?? 10;
      actions.seekBy(-offset);
      refreshPosition();
    });
    session.setActionHandler('seekforward', details => {
      if (!actions.owns()) return;
      const offset = details.seekOffset ?? 10;
      actions.seekBy(offset);
      refreshPosition();
    });
    session.setActionHandler('seekto', details => {
      if (!actions.owns() || details.seekTime === undefined || !Number.isFinite(details.seekTime)) return;
      actions.seek(details.seekTime);
      refreshPosition();
    });
    session.setActionHandler('nexttrack', () => {
      if (!actions.owns()) return;
      actions.next?.();
    });
    session.setActionHandler('previoustrack', () => {
      if (!actions.owns()) return;
      actions.previous?.();
    });
  } catch {
    /* Some browsers reject unsupported action names */
  }

  refreshMetadata();
  refreshPosition();

  const onTick = () => {
    refreshMetadata();
    refreshPosition();
  };
  document.addEventListener('visibilitychange', onTick, { signal });
  signal.addEventListener(
    'abort',
    () => {
      try {
        for (const action of [
          'play',
          'pause',
          'seekbackward',
          'seekforward',
          'seekto',
          'nexttrack',
          'previoustrack',
        ] as MediaSessionAction[]) {
          session.setActionHandler(action, null);
        }
        session.metadata = null;
      } catch {
        /* ignore cleanup failures */
      }
    },
    { once: true },
  );
}
