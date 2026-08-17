/**
 * achievements.js — static achievement set for Jewel Cascade.
 *
 * Keys are stable lowercase identifiers; unlocks are idempotent (callers store
 * progress.achievements[key] once and re-evaluation never re-fires).
 * The set is deliberately small: first completion, mechanic mastery, a
 * sustained streak, a difficult milestone, and an accessibility-neutral
 * long-term goal.
 */

export const ACHIEVEMENTS = [
  {
    key: 'first_completion',
    name: 'First Setting',
    desc: 'Complete your first stage, any mode.',
  },
  {
    key: 'special_master',
    name: 'Full Spectrum Lapidary',
    desc: 'Create a ray, a bloom, and a prism over your career.',
  },
  {
    key: 'streak_5',
    name: 'Steady Hands',
    desc: 'Win five rounds in a row, any mode.',
  },
  {
    key: 'summit_40',
    name: 'Master of the Cascade',
    desc: 'Complete the final Journey stage.',
  },
  {
    key: 'cascade_veteran',
    name: 'Hundred Evenings',
    desc: 'Complete one hundred rounds in total.',
  },
];

/**
 * Evaluate career progress after a round. `progress` is the persisted
 * progression document; this function only reads it. Returns the list of
 * newly earned keys (already-unlocked keys are never returned).
 */
export function evaluateAchievements(progress) {
  const owned = progress.achievements || {};
  const earned = [];
  const has = (k) => !!owned[k];
  const career = progress.career || {};

  if (!has('first_completion') && (career.roundsWon || 0) >= 1) earned.push('first_completion');
  const made = career.specialsMade || {};
  if (!has('special_master') && made.ray && made.bloom && made.prism) earned.push('special_master');
  if (!has('streak_5') && (career.winStreak || 0) >= 5) earned.push('streak_5');
  if (!has('summit_40') && (progress.journeyStars || {})['j40'] > 0) earned.push('summit_40');
  if (!has('cascade_veteran') && (career.roundsCompleted || 0) >= 100) earned.push('cascade_veteran');

  return earned;
}

/**
 * Fold one finished round into the career counters that achievements and
 * mastery read. Mutates progress; idempotent per roundId.
 */
export function recordRound(progress, round) {
  if (!progress.career) {
    progress.career = {
      roundsCompleted: 0,
      roundsWon: 0,
      winStreak: 0,
      bestWinStreak: 0,
      specialsMade: { ray: false, bloom: false, prism: false },
      totalScore: 0,
    };
  }
  if (!progress.seenRounds) progress.seenRounds = [];
  if (progress.seenRounds.includes(round.roundId)) return false;
  progress.seenRounds.push(round.roundId);
  if (progress.seenRounds.length > 256) progress.seenRounds.splice(0, progress.seenRounds.length - 256);

  const c = progress.career;
  c.roundsCompleted++;
  c.totalScore += round.score || 0;
  if (round.won) {
    c.roundsWon++;
    c.winStreak++;
    c.bestWinStreak = Math.max(c.bestWinStreak, c.winStreak);
  } else {
    c.winStreak = 0;
  }
  if (round.stats && round.stats.made) {
    if (round.stats.made.ray > 0) c.specialsMade.ray = true;
    if (round.stats.made.bloom > 0) c.specialsMade.bloom = true;
    if (round.stats.made.prism > 0) c.specialsMade.prism = true;
  }
  return true;
}

/**
 * Mastery track: XP from completed rounds, levels unlock cosmetics.
 * xp = score/100 + win bonus + journey first-clear bonus.
 */
export const MASTERY_LEVELS = [
  { level: 1, xp: 0, reward: null },
  { level: 2, xp: 40, reward: { type: 'theme', id: 'moonlit-forge' } },
  { level: 3, xp: 100, reward: { type: 'trail', id: 'spark' } },
  { level: 4, xp: 180, reward: { type: 'theme', id: 'verdant-atelier' } },
  { level: 5, xp: 280, reward: { type: 'frame', id: 'brass' } },
  { level: 6, xp: 400, reward: { type: 'theme', id: 'frostbound-loft' } },
  { level: 7, xp: 560, reward: { type: 'trail', id: 'comet' } },
  { level: 8, xp: 780, reward: { type: 'theme', id: 'royal-velvet' } },
  { level: 9, xp: 1040, reward: { type: 'frame', id: 'filigree' } },
  { level: 10, xp: 1400, reward: { type: 'title', id: 'cascade-master' } },
];

export function masteryXpForRound(round, firstClear) {
  return Math.floor((round.score || 0) / 100) + (round.won ? 10 : 2) + (firstClear ? 15 : 0);
}

export function masteryLevelForXp(xp) {
  let level = 1;
  for (const m of MASTERY_LEVELS) if (xp >= m.xp) level = m.level;
  return level;
}
