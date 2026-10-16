/**
 * SM-2 spaced repetition, entirely on the device.
 * grade: 0 = forgot, 3 = hard, 4 = good, 5 = easy.
 */
const DAY = 24 * 60 * 60 * 1000;

export function newReview(cardId, setId, now = Date.now()) {
  return { id: cardId, setId, ease: 2.5, interval: 0, repetitions: 0, due: now, history: [] };
}

export function reviewCard(review, grade, now = Date.now()) {
  const g = Math.max(0, Math.min(5, Math.round(grade)));
  let { ease, interval, repetitions } = review;
  if (g < 3) {
    repetitions = 0;
    interval = 0; // again in this session (10 minutes)
  } else {
    repetitions += 1;
    interval = repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round(interval * ease);
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - g) * (0.08 + (5 - g) * 0.02)));
  const due = interval === 0 ? now + 10 * 60 * 1000 : now + interval * DAY;
  return { ...review, ease: Number(ease.toFixed(2)), interval, repetitions, due, history: [...(review.history || []), { at: now, grade: g }].slice(-30) };
}

export function isDue(review, now = Date.now()) {
  return !review || review.due <= now;
}
