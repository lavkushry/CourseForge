/** Labs honesty helpers — never invent pass/fail when Docker graders are offline. */

export function labsUnavailableBanner(gradingAvailable: boolean, kindAvailable: boolean): string | null {
  if (gradingAvailable) return null;
  if (kindAvailable) {
    return 'A lab executor is configured, but Docker Kind grading is not available in this environment.';
  }
  return 'Docker graders are not configured here. You can browse curated challenges, but Run & Grade is disabled.';
}

export function labsIsolationCopy(): string {
  return 'When graders are online, execution runs in an isolated Docker container with no network access and no root privileges. Pass/fail is never invented offline.';
}

export function labsRunDisabled(gradingAvailable: boolean): boolean {
  return !gradingAvailable;
}

export function labsLoadFailureCopy(message: string): { title: string; description: string } {
  return {
    title: 'Could not load labs',
    description: message || 'Lab catalog temporarily unavailable.',
  };
}
