export function reviewsLoadFailureCopy(message: string): { title: string; description: string } {
  return {
    title: 'Could not load review cards',
    description: message || 'Review cards temporarily unavailable.',
  };
}

export function reviewsEmptyCopy(completedToday: number): { title: string; description: string } {
  if (completedToday > 0) {
    return {
      title: 'You are caught up for now',
      description: `Reviewed ${completedToday} card${completedToday === 1 ? '' : 's'} this session. Complete lecture quizzes to schedule new concepts.`,
    };
  }
  return {
    title: 'No flashcards due',
    description:
      'Complete quizzes in your lectures to schedule spaced-repetition cards. Nothing is invented when the due queue is empty.',
  };
}
