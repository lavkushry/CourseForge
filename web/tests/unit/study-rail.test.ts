import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const studyRail = readFileSync(join(root, 'player/study-rail.ts'), 'utf8');
const controller = readFileSync(join(root, 'player/controller.ts'), 'utf8');
const classroomCss = readFileSync(join(root, 'styles/pages/classroom.css'), 'utf8');
const bootstrap = readFileSync(join(root, 'app/features/bootstrap.ts'), 'utf8');

describe('study rail honesty', () => {
  it('does not fabricate quiz mastery, synthetic transcripts, or invented brief copy', () => {
    expect(studyRail).not.toMatch(/Quiz Mastered/);
    expect(studyRail).not.toMatch(/Spaced Review deck/);
    expect(studyRail).not.toMatch(/populateSyntheticChunks/);
    expect(studyRail).not.toMatch(/Discussion covering core architectures/);
    expect(studyRail).not.toMatch(/Deep-dive lecture covering foundational/);
    expect(studyRail).not.toMatch(/Generating questions/);
    expect(studyRail).toMatch(/awaiting approval/);
    expect(studyRail).toMatch(/No searchable transcript is available/);
    expect(studyRail).toMatch(/No lesson overview is available/);
    expect(studyRail).toMatch(/Scores appear only after the server grades/);
    expect(studyRail).toMatch(/learningApi\.attempt/);
    expect(studyRail).toMatch(/onQuizPassed/);
  });

  it('keeps materials downloads same-origin and surfaces real captions when present', () => {
    expect(studyRail).toMatch(/url\.pathname\.startsWith\('\/api\/'\)/);
    expect(studyRail).toMatch(/Captions in player/);
    expect(studyRail).toMatch(/No caption tracks are attached/);
    expect(studyRail).toMatch(/No supplementary download files are attached/);
    expect(bootstrap).toMatch(/onQuizPassed:\s*lessonId\s*=>/);
  });
});

describe('classroom end-only up next', () => {
  it('arms navigation only from ended, not mid-lesson progress crosses', () => {
    expect(controller).toMatch(/End-only autoplay/);
    expect(controller).not.toMatch(/crossedPlaybackThreshold\(/);
    expect(controller).toMatch(/this\.navigation\.ended\(this\.options\.hasNext\(\)\)/);
    expect(classroomCss).toMatch(/#playerUpNextCard\[hidden\][\s\S]*display:\s*none\s*!important/);
  });
});
