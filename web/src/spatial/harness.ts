import { FIXTURE_ARTIFACT } from './fixture';
import { mountSpatialPlayerEntry, spatialCitationButton } from './entry';
import { formatExactTimestamp } from './provenance';

const artifact = FIXTURE_ARTIFACT;
const video = document.querySelector<HTMLVideoElement>('#lesson-video');
const wrap = document.querySelector<HTMLElement>('#player-wrap');
const playhead = document.querySelector<HTMLElement>('#playhead');
const citations = document.querySelector<HTMLElement>('#citations');
if (!video || !wrap || !playhead || !citations) {
  throw new Error('Spatial harness is missing its player nodes');
}

const lesson = document.querySelector<HTMLElement>('#lecture-id');
if (lesson) lesson.textContent = artifact.lectureId;
const frame = document.querySelector<HTMLElement>('#keyframe-time');
if (frame) frame.textContent = `${artifact.keyframeTimeMs} ms`;

const showPlayhead = () => {
  playhead.textContent = formatExactTimestamp(video.currentTime);
};
video.addEventListener('timeupdate', showPlayhead);
video.addEventListener('seeked', showPlayhead);
video.addEventListener(
  'loadedmetadata',
  () => {
    if (video.currentTime < 1) video.currentTime = artifact.timestampSeconds;
    showPlayhead();
  },
  { once: true },
);
showPlayhead();

mountSpatialPlayerEntry({
  wrap,
  video,
  getLessonId: () => artifact.lectureId,
  onPause: () => video.pause(),
  onReturn: seconds => {
    video.currentTime = seconds;
  },
  signal: new AbortController().signal,
  artifact,
});

const samples = [
  {
    lesson_id: artifact.lectureId,
    start_seconds: 20,
    end_seconds: 36,
    text: artifact.context[0]?.quote ?? '',
  },
  {
    lesson_id: 'other-lecture',
    start_seconds: 30,
    end_seconds: 40,
    text: 'unrelated',
  },
];

for (const sample of samples) {
  const row = document.createElement('div');
  const cite = document.createElement('button');
  cite.type = 'button';
  cite.className = 'citation-link';
  cite.textContent = `${sample.lesson_id} (${formatExactTimestamp(sample.start_seconds)})`;
  cite.addEventListener('click', () => {
    video.currentTime = sample.start_seconds;
  });
  row.append(cite);
  const ar = spatialCitationButton(sample, seconds => {
    video.currentTime = seconds;
  });
  if (ar) row.append(ar);
  citations.append(row);
}
