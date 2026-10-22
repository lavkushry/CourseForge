import { FIXTURE_ARTIFACT } from './fixture';
import { openSpatialOverlay } from './overlay';
import { citationIncludesArtifact, formatExactTimestamp, playheadShowsArtifact, returnSeekSeconds } from './provenance';
import type { CitationStamp, SpatialArtifact } from './types';

export interface SpatialEntryOptions {
  wrap: HTMLElement;
  video: HTMLVideoElement;
  getLessonId: () => string;
  onReturn: (seconds: number) => void;
  onPause?: () => void;
  signal: AbortSignal;
  artifact?: SpatialArtifact;
}

export function mountSpatialPlayerEntry(options: SpatialEntryOptions): HTMLButtonElement {
  const artifact = options.artifact ?? FIXTURE_ARTIFACT;
  const stamp = formatExactTimestamp(artifact.timestampSeconds);
  options.wrap.querySelector('#spatial-ar-entry')?.remove();
  const button = document.createElement('button');
  button.id = 'spatial-ar-entry';
  button.type = 'button';
  button.className = 'spatial-ar-entry';
  button.hidden = true;
  button.textContent = `View in AR · ${stamp}`;
  button.title = `Open the ${artifact.title} model. Devices without AR get the rotatable viewer.`;
  button.addEventListener(
    'click',
    () => {
      options.onPause?.();
      openSpatialOverlay({
        artifact,
        signal: options.signal,
        onReturn: seconds => options.onReturn(seconds),
      });
    },
    { signal: options.signal },
  );

  const sync = () => {
    button.hidden = !playheadShowsArtifact(options.getLessonId(), options.video.currentTime, artifact);
  };
  for (const eventName of ['timeupdate', 'seeked', 'loadedmetadata'] as const) {
    options.video.addEventListener(eventName, sync, { signal: options.signal });
  }
  sync();
  options.wrap.append(button);
  return button;
}

export function spatialCitationButton(
  citation: CitationStamp,
  onReturn: (seconds: number) => void,
): HTMLButtonElement | null {
  const artifact = FIXTURE_ARTIFACT;
  if (!citationIncludesArtifact(citation, artifact)) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'citation-link spatial-ar-cite';
  button.textContent = `View in AR · ${formatExactTimestamp(artifact.timestampSeconds)}`;
  button.addEventListener('click', () => {
    openSpatialOverlay({
      artifact,
      onReturn: () => onReturn(returnSeekSeconds(artifact)),
    });
  });
  return button;
}
