export function labsUnavailableBanner(gradingAvailable: boolean, kindAvailable: boolean): string | null {
  if (gradingAvailable) return null;
  if (kindAvailable) {
    return 'A lab executor is configured, but Docker Kind grading is not available in this environment.';
  }
  return 'Docker graders are not configured here. You can browse curated challenges, but Run & Grade is disabled.';
}

export function labsRunDisabled(gradingAvailable: boolean): boolean {
  return !gradingAvailable;
}
