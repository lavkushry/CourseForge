import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// Evidence deliberately excludes source snippets, request URLs, cookies, headers,
// arbitrary attachment bodies and error text. Playwright traces stay local.
export default class BrowserEvidenceReporter implements Reporter {
  private readonly results: object[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const samples = result.attachments.flatMap(attachment => {
      if (!['decoded-media-sample', 'displaced-playback-response'].includes(attachment.name) || !attachment.body)
        return [];
      const sample = JSON.parse(attachment.body.toString()) as Record<string, unknown>;
      const permitted = [
        'project',
        'source',
        'sampleElapsedMs',
        'decodedFrames',
        'totalVideoFrames',
        'presentedFrames',
        'droppedFrames',
        'width',
        'height',
        'currentTime',
        'duration',
        'readyState',
        'route',
        'status',
        'code',
        'owner',
      ];
      return [
        {
          name: attachment.name,
          ...Object.fromEntries(permitted.filter(key => key in sample).map(key => [key, sample[key]])),
        },
      ];
    });
    this.results.push({
      project: test.parent.project()?.name,
      title: test.title,
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
      samples,
    });
  }

  onEnd(result: FullResult): void {
    const file = resolve(
      process.env.COURSEFORGE_BROWSER_EVIDENCE || '../output/playwright/courseforge/browser-results.json',
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          status: result.status,
          durationMs: result.duration,
          results: this.results,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
