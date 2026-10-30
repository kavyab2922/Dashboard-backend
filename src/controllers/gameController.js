const { pool, query } = require('../config/db');

const GAME_ORDER = ['sudoku', 'quiz', 'word', 'trivia'];
const GAME_APIS = {
  sudoku: 'https://sudoku-api.vercel.app/api/dosuku',
  quiz: 'https://opentdb.com/api.php?amount=10&type=multiple',
  word: 'https://api.datamuse.com/words?ml=game&max=10',
  trivia: 'https://the-trivia-api.com/v2/questions?limit=10',
};
const ORG_TIMEZONE = process.env.ORGANIZATION_TIMEZONE || process.env.ORG_TIMEZONE || 'UTC';
const GAME_REWARDS = { sudoku: 120, quiz: 100, word: 90, trivia: 110 };

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ORG_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Calendar-day arithmetic on YYYY-MM-DD strings (never Date objects, so the
 *  organisation timezone stays authoritative regardless of the server TZ). */
function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Consecutive-day streak maths, kept pure so it can be unit tested.
 *
 * @param {{lastCompletedDate: string|null, currentStreak: number, longestStreak: number}|null} streak
 * @param {string} today YYYY-MM-DD calendar day of the verified completion
 * @returns {{currentStreak: number, longestStreak: number, lastCompletedDate: string}}
 *
 * Rules: first completion ever → 1; the same calendar day never increments;
 * the previous calendar day → +1; any gap resets the active streak to 1 while
 * the longest streak is only ever raised, never lowered.
 */
function computeStreakState(streak, today) {
  if (!streak || !streak.lastCompletedDate) {
    return { currentStreak: 1, longestStreak: 1, lastCompletedDate: today };
  }
  const current = Math.max(1, Number(streak.currentStreak) || 0);
  const longest = Math.max(Number(streak.longestStreak) || 0, current);
  if (streak.lastCompletedDate === today) {
    return { currentStreak: current, longestStreak: longest, lastCompletedDate: today };
  }
  const currentStreak = streak.lastCompletedDate === shiftDate(today, -1) ? current + 1 : 1;
  return { currentStreak, longestStreak: Math.max(longest, currentStreak), lastCompletedDate: today };
}

/** Monday → Sunday window (in the organisation timezone) that contains `date`. */
function weekRange(date) {
  const mondayIndex = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = shiftDate(date, -mondayIndex);
  return { start, end: shiftDate(start, 6) };
}

/**
 * One streak day per employee per calendar day, guarded by the
 * (employee_id, award_date) primary key so replays, refreshes and duplicate
 * completion events can never award the same day twice. Runs inside the caller's
 * transaction and locks the streak row, so concurrent completions serialise.
 */
async function recordStreakAward(client, id, date, points) {
  const award = (await client.query(
    'INSERT INTO hcm.daily_game_streak_awards (employee_id, award_date) VALUES ($1, $2) ON CONFLICT (employee_id, award_date) DO NOTHING RETURNING award_date',
    [id, date],
  )).rows[0];
  const row = (await client.query(
    'SELECT current_streak, longest_streak, last_completed_date::text AS "lastCompletedDate" FROM hcm.daily_game_streaks WHERE employee_id = $1 FOR UPDATE',
    [id],
  )).rows[0];
  if (!award) {
    // Already counted today: the streak stays untouched, only points accumulate.
    if (row) await client.query('UPDATE hcm.daily_game_streaks SET total_points = total_points + $2, updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1', [id, points]);
    return { awarded: false, currentStreak: Number(row?.current_streak || 0) };
  }
  const next = computeStreakState(
    row ? { lastCompletedDate: row.lastCompletedDate, currentStreak: row.current_streak, longestStreak: row.longest_streak } : null,
    date,
  );
  if (!row) {
    await client.query(
      'INSERT INTO hcm.daily_game_streaks (employee_id, current_streak, longest_streak, last_completed_date, total_points) VALUES ($1, $2, $3, $4, $5)',
      [id, next.currentStreak, next.longestStreak, date, points],
    );
  } else {
    await client.query(
      'UPDATE hcm.daily_game_streaks SET current_streak = $2, longest_streak = $3, last_completed_date = $4, total_points = total_points + $5, updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1',
      [id, next.currentStreak, next.longestStreak, date, points],
    );
  }
  return { awarded: true, currentStreak: next.currentStreak };
}

function employeeId(req) {
  const raw = Number(req.user?.id);
  if (Number.isInteger(raw) && raw > 0) return raw;
  const identity = String(req.user?.email || req.user?.official_email || req.user?.employee_code || req.user?.id || 'employee');
  let hash = 0;
  for (const char of identity) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) || 1;
}

function employeeKey(req) {
  return String(req.user?.employee_key || req.user?.employeeKey || req.user?.employee_code || req.user?.email || '').trim();
}


async function recordGlobalPoints(client, req, points) {
  const key = employeeKey(req);

  if (!key) {
    throw new Error(
      'Cannot save Daily Games points: employee key is missing from the authenticated user.'
    );
  }

  const name =
    req.user?.name ||
    [req.user?.first_name, req.user?.last_name]
      .filter(Boolean)
      .join(' ') ||
    req.user?.employee_name ||
    key;

  // Register the employee for the global leaderboard.
  await client.query(
    `
      INSERT INTO hcm.daily_game_players
        (employee_key, name, visible)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (employee_key)
      DO UPDATE SET visible = TRUE
    `,
    [key, name]
  );

  // Create the stats row for a new employee, or add points
  // to the existing employee's total.
  await client.query(
    `
      INSERT INTO hcm.daily_game_employee_stats
        (employee_key, total_points)
      VALUES ($1, $2)
      ON CONFLICT (employee_key)
      DO UPDATE SET
        total_points =
          hcm.daily_game_employee_stats.total_points
          + EXCLUDED.total_points
    `,
    [key, points]
  );
}


function same(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function seededNumber(seed) {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return Math.abs(value);
}

/** Stable shuffle, so the correct answer is not always in the same position. */
function seededShuffle(list, seed) {
  return list
    .map((item, index) => ({ item, key: seededNumber(`${seed}:${index}:${item}`) }))
    .sort((left, right) => left.key - right.key)
    .map(({ item }) => item);
}

/** Questions are written with the correct choice first; shuffle and record where it lands. */
function shuffleQuestions(questions, seed) {
  const shuffled = questions.map((question, index) => {
    const choices = seededShuffle(question.choices, `${seed}:${index}`);
    return { ...question, choices, answer: choices.indexOf(question.choices[0]) };
  });
  return { questions: shuffled.map(({ answer, ...question }) => question), answers: shuffled.map((question) => question.answer) };
}

const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert', 'master'];
const DIFFICULTY_MULTIPLIER = { easy: 1, medium: 1.15, hard: 1.3, expert: 1.5, master: 1.75 };
/** Levels available per game and difficulty; the last one unlocks the
 *  "All levels completed" screen instead of an endless Next Level button. */
const MAX_LEVEL = 10;
// opentdb.com regularly takes ~1.5s, so a shorter timeout drops the quiz to the fallback.
const EXTERNAL_SOURCE_TIMEOUT_MS = 5000;

async function fetchExternalJson(url) {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function flattenGrid(grid) {
  return Array.isArray(grid) && grid.length === 9 && grid.every((row) => Array.isArray(row) && row.length === 9)
    ? grid.flat().map(Number)
    : null;
}

async function sourceMiniSudoku(generated, payload) {
  const source = payload || await fetchExternalJson(GAME_APIS.sudoku);
  const grid = source?.newboard?.grids?.[0];
  const givens = flattenGrid(grid?.value);
  const solution = flattenGrid(grid?.solution);
  if (!givens || !solution || solution.some((value) => !Number.isInteger(value) || value < 1 || value > 9)) return null;
  const puzzle = { config: { ...generated.config, givens: givens.map((value) => value || 0) }, solution: { cells: solution }, title: generated.title };
  return validateSubmission('sudoku', puzzle.solution, puzzle.solution, puzzle).valid ? puzzle : null;
}

function difficultyOf(value) {
  const normalized = String(value || 'easy').toLowerCase();
  return DIFFICULTIES.includes(normalized) ? normalized : 'easy';
}

function buildNQueens(size) {
  const solutions = {
    4: [1, 3, 0, 2],
    5: [0, 2, 4, 1, 3],
    6: [1, 3, 5, 0, 2, 4],
    7: [0, 2, 4, 6, 1, 3, 5],
    8: [0, 4, 7, 5, 2, 6, 1, 3],
  };
  const columns = solutions[size];
  if (!columns) throw new Error(`Could not generate a ${size}x${size} Queens board`);
  return columns.map((column, row) => [row, column]);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizedDifficultyCount(difficulty) {
  return { easy: 3, medium: 5, hard: 7, expert: 9, master: 10 }[difficultyOf(difficulty)];
}

/** Progressive difficulty: every couple of levels adds more work to solve. */
function levelExtra(level, step = 2, cap = 4) {
  return Math.min(cap, Math.floor((Math.max(1, Number(level) || 1) - 1) / step));
}

function buildQuizFromApi(payload, difficulty, level) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const count = Math.min(normalizedDifficultyCount(difficulty) + levelExtra(level), results.length);
  const questions = results.slice(0, count).map((item, index) => {
    const correct = decodeHtml(item.correct_answer);
    const choices = [correct, ...(Array.isArray(item.incorrect_answers) ? item.incorrect_answers : [])].map(decodeHtml);
    return { id: `quiz-${level}-${index}`, question: decodeHtml(item.question), choices: [...new Set(choices)], category: decodeHtml(item.category || 'General') };
  }).filter((item) => item.question && item.choices.length >= 2);
  if (questions.length < Math.max(2, Math.min(count, 3))) return null;
  const shuffled = shuffleQuestions(questions, `quiz:${difficulty}:${level}`);
  return { config: { questions: shuffled.questions, difficulty, level, timeLimit: Math.max(45, 150 - level * 2) }, solution: { answers: shuffled.answers }, title: 'Answer the questions before the clock runs out.' };
}

function buildTriviaFromApi(payload, difficulty, level) {
  const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const count = Math.min(normalizedDifficultyCount(difficulty) + levelExtra(level), source.length);
  const questions = source.slice(0, count).map((item, index) => {
    const correct = decodeHtml(String(item.correctAnswer || item.correct_answer || '').trim());
    const incorrect = Array.isArray(item.incorrectAnswers) ? item.incorrectAnswers : (Array.isArray(item.incorrect_answers) ? item.incorrect_answers : []);
    if (!correct) return null;
    const choices = [...new Set([correct, ...incorrect].map((choice) => decodeHtml(choice)).filter(Boolean))];
    return { id: `trivia-${level}-${index}`, question: decodeHtml(String(item.question?.text || item.question || '').trim()), choices, category: String(item.category || 'General') };
  }).filter((item) => item && item.question && item.choices.length >= 2);
  if (questions.length < Math.max(2, Math.min(count, 3))) return null;
  const shuffled = shuffleQuestions(questions, `trivia:${difficulty}:${level}`);
  return { config: { questions: shuffled.questions, difficulty, level, timeLimit: Math.max(45, 150 - level * 2) }, solution: { answers: shuffled.answers }, title: 'Choose the best answer for every trivia question.' };
}

function buildWordFromApi(payload, difficulty, level) {
  const words = (Array.isArray(payload) ? payload : []).map((item) => String(item?.word || '').trim().toLowerCase()).filter((word) => /^[a-z]{4,12}$/.test(word));
  const unique = [...new Set(words)];
  if (unique.length < 3) return null;
  const target = unique[(level - 1) % unique.length];
  // The clue names the letter count, so no other candidate may share it.
  const visible = unique.filter((word) => word.length !== target.length).slice(0, Math.max(2, normalizedDifficultyCount(difficulty) - 1 + levelExtra(level, 3)));
  if (visible.length < 2) return null;
  const choices = seededShuffle([target, ...visible], `word:${difficulty}:${level}`);
  return { config: { choices, clue: `Which word is linked to “game” and has exactly ${target.length} letters?`, difficulty, level }, solution: { word: target }, title: 'Choose the hidden word that matches the clue.' };
}

async function buildExternalPuzzle(gameId, difficulty, level, fallback) {
  const payload = await fetchExternalJson(GAME_APIS[gameId]);
  const generated = gameId === 'sudoku'
    ? await sourceMiniSudoku(fallback, payload)
    : gameId === 'quiz'
      ? buildQuizFromApi(payload, difficulty, level)
      : gameId === 'word'
        ? buildWordFromApi(payload, difficulty, level)
        : buildTriviaFromApi(payload, difficulty, level);
  // A slow or rate-limited provider must not block play: use the built-in puzzle instead.
  return generated || fallback;
}

function buildPuzzle(gameId, date, difficulty = 'easy', level = 1) {
  const selectedDifficulty = difficultyOf(difficulty);
  const selectedLevel = Math.max(1, Number(level) || 1);
  const scale = { easy: 0, medium: 1, hard: 2, expert: 3, master: 4 }[selectedDifficulty];
  const variantSeed = seededNumber(`${date}:${gameId}:${selectedDifficulty}:${selectedLevel}`);
  switch (gameId) {
    case 'sudoku': {
      const base = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const shifts = [0, 3, 6, 1, 4, 7, 2, 5, 8];
      const solution = shifts.flatMap((shift) => base.slice(shift).concat(base.slice(0, shift)));
      const gap = Math.max(2, 6 - scale);
      const givens = solution.map((value, index) => index % gap === 0 ? value : 0);
      return { config: { givens, difficulty: selectedDifficulty, level: selectedLevel }, solution: { cells: solution }, title: 'Complete every row, column, and box.' };
    }
    case 'pinpoint': {
      const banks = [
        ['Ruby', 'Emerald', 'Sapphire', 'Diamond', 'Opal'],
        ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter'],
        ['Violin', 'Cello', 'Viola', 'Bass', 'Harp'],
        ['Copper', 'Silver', 'Gold', 'Iron', 'Tin'],
      ];
      const answers = ['gemstones', 'planets', 'string instruments', 'metals'];
      const index = (variantSeed + scale + selectedLevel) % banks.length;
      const clues = banks[index].slice(0, Math.min(5, 3 + scale));
      return { config: { clueCount: clues.length, clues, difficulty: selectedDifficulty, level: selectedLevel }, solution: { answer: answers[index] }, title: 'Find the category shared by the clues.' };
    }
    case 'crossclimb': {
      const questions = [
        { id: 'q1', category: 'Science', difficulty: 'Easy', question: 'What gas do plants absorb?', choices: ['Oxygen', 'Carbon dioxide', 'Helium'], answer: 1 },
        { id: 'q2', category: 'Science', difficulty: 'Easy', question: 'What is H2O?', choices: ['Salt', 'Water', 'Ozone'], answer: 1 },
      ];
      const ladders = [['COLD', 'CORD', 'CARD', 'WARD', 'WARM'], ['FALL', 'FAIL', 'MAIL', 'MALL', 'MALE'], ['HEAD', 'HEAL', 'TEAL', 'TELL', 'TALL']];
      const ladder = ladders[(variantSeed + selectedLevel + scale) % ladders.length];
      return { config: { questions: questions.map(({ answer, ...question }) => question), ladder: { start: ladder[0], end: ladder[ladder.length - 1], blanks: ladder.length - 2 }, difficulty: selectedDifficulty, level: selectedLevel }, solution: { answers: [1, 1], words: ladder.slice(1, -1) }, title: 'Answer trivia and climb the word ladder.' };
    }
    case 'zip': {
      const size = Math.min(7, 4 + Math.floor((scale + selectedLevel - 1) / 2));
      const path = [];
      for (let row = 0; row < size; row += 1) {
        const columns = row % 2 === 0 ? Array.from({ length: size }, (_, col) => col) : Array.from({ length: size }, (_, col) => size - col - 1);
        columns.forEach((col) => path.push(row * size + col));
      }
      const numbers = Array(size * size).fill(null);
      const checkpointIndexes = [0, Math.floor((path.length - 1) / 4), Math.floor((path.length - 1) / 2), Math.floor(((path.length - 1) * 3) / 4), path.length - 1];
      checkpointIndexes.forEach((pathIndex, checkpoint) => { numbers[path[pathIndex]] = checkpoint + 1; });
      return { config: { size, numbers, labelCount: 5, difficulty: selectedDifficulty, level: selectedLevel }, solution: { path }, title: 'Draw one continuous path through every cell.' };
    }
    case 'tango': {
      const size = scale >= 3 ? 6 : 4;
      const cells = Array.from({ length: size * size }, (_, index) => { const row = Math.floor(index / size); const col = index % size; return (row + col + (variantSeed % 2)) % 2; });
      const givens = cells.map((value, index) => index % Math.max(3, 7 - scale) === 0 ? value : null);
      return { config: { size, symbolCount: 2, givens, difficulty: selectedDifficulty, level: selectedLevel }, solution: { cells }, title: 'Balance every row and column without three alike.' };
    }
    case 'quiz': {
      // Correct choice first; shuffleQuestions moves it.
      const { questions, answers } = shuffleQuestions([
        { id: 'quiz-fallback-1', question: 'Which planet is known as the Red Planet?', choices: ['Mars', 'Venus', 'Jupiter', 'Mercury'] },
        { id: 'quiz-fallback-2', question: 'How many sides does a hexagon have?', choices: ['Six', 'Five', 'Seven', 'Eight'] },
        { id: 'quiz-fallback-3', question: 'What is H2O commonly called?', choices: ['Water', 'Salt', 'Oxygen', 'Steam'] },
      ], `quiz-fallback:${date}:${selectedLevel}`);
      return { config: { questions, difficulty: selectedDifficulty, level: selectedLevel, timeLimit: 120 }, solution: { answers }, title: 'Answer the questions before the clock runs out.' };
    }
    case 'trivia': {
      const { questions, answers } = shuffleQuestions([
        { id: 'trivia-fallback-1', question: 'Which ocean is the largest?', choices: ['Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'] },
        { id: 'trivia-fallback-2', question: 'What is the capital of Japan?', choices: ['Tokyo', 'Kyoto', 'Osaka', 'Sapporo'] },
        { id: 'trivia-fallback-3', question: 'Which animal is known for building dams?', choices: ['Beaver', 'Otter', 'Badger', 'Fox'] },
      ], `trivia-fallback:${date}:${selectedLevel}`);
      return { config: { questions, difficulty: selectedDifficulty, level: selectedLevel, timeLimit: 120 }, solution: { answers }, title: 'Choose the best answer for every trivia question.' };
    }
    case 'word': {
      const choices = seededShuffle(['arcade', 'console', 'quest', 'joystick'], `word-fallback:${date}:${selectedLevel}`);
      return { config: { choices, clue: 'Which word is linked to “game” and has exactly 6 letters?', difficulty: selectedDifficulty, level: selectedLevel }, solution: { word: 'arcade' }, title: 'Choose the hidden word that matches the clue.' };
    }
    case 'wend': {
      const letters = ['C', 'A', 'T', 'D', 'O', 'G', 'S', 'E', 'R'];
      const words = ['CAT', 'DOG'];
      return { config: { size: 3, letters, theme: 'Friendly animals', wordCount: words.length, wordLengths: words.map((word) => word.length), difficulty: selectedDifficulty, level: selectedLevel }, solution: { words }, title: 'Find every hidden word in a straight line.' };
    }
    case 'patches': {
      const pieces = scale < 2
        ? ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase(), cells: [[0, 0], [0, 1], [1, 0], [1, 1]] }))
        : Array.from({ length: 8 }, (_, index) => ({ id: String.fromCharCode(97 + index), label: String.fromCharCode(65 + index), cells: [[0, 0], [0, 1]] }));
      const placements = {};
      pieces.forEach((piece, index) => { placements[piece.id] = scale < 2 ? { r: Math.floor(index / 2) * 2, c: (index % 2) * 2, rot: 0 } : { r: Math.floor(index / 2), c: (index % 2) * 2, rot: 0 }; });
      return { config: { size: 4, difficulty: selectedDifficulty, level: selectedLevel, pieces }, solution: { placements }, title: 'Arrange every patch into its matching shape.' };
    }
    default: throw new Error('Unknown daily game');
  }
}

function validateSubmission(gameId, submission, solution, puzzle) {
  if (!submission || typeof submission !== 'object') return { valid: false, reason: 'Finish the puzzle before submitting.' };
  if (gameId === 'quiz' || gameId === 'trivia') {
    const answers = submission.answers;
    if (!Array.isArray(answers) || answers.length !== solution.answers.length) return { valid: false, reason: 'Answer every question before submitting.' };
    const correct = answers.filter((answer, index) => Number(answer) === Number(solution.answers[index])).length;
    if (correct !== solution.answers.length) return { valid: false, reason: `${correct} of ${solution.answers.length} answers are correct. Change the others and try again.`, details: { correct } };
    return { valid: true, reason: 'Correct.' };
  }
  if (gameId === 'word') {
    const word = String(submission.word || '').trim().toLowerCase();
    return { valid: word === String(solution.word).toLowerCase(), reason: 'Choose the word that matches the clue.' };
  }
  if (gameId === 'pinpoint') return { valid: String(submission.answer || '').trim().toLowerCase() === solution.answer, reason: 'Try another category or reveal a clue.' };
  if (gameId === 'crossclimb') {
    const answers = submission.answers; const words = (submission.words || []).map((word) => String(word).trim().toUpperCase());
    if (!Array.isArray(answers) || !same(answers, solution.answers) || words.length !== solution.words.length) return { valid: false, reason: 'Answer every trivia question and fill every ladder rung.' };
    const ladder = [puzzle.config.ladder.start, ...words, puzzle.config.ladder.end];
    for (let index = 1; index < ladder.length; index += 1) { let differences = 0; for (let char = 0; char < ladder[index].length; char += 1) if (ladder[index][char] !== ladder[index - 1][char]) differences += 1; if (ladder[index].length !== ladder[index - 1].length || differences !== 1) return { valid: false, reason: 'Each ladder rung must change exactly one letter.' }; }
    return { valid: true, reason: 'Correct.' };
  }
  if (gameId === 'wend') {
    const words = [...new Set((submission.words || []).map((word) => String(word).trim().toUpperCase()).filter(Boolean))];
    const expected = solution.words.map((word) => String(word).toUpperCase());
    const validWords = words.filter((word) => expected.includes(word));
    const invalidWord = words.some((word) => !expected.includes(word));
    const complete = !invalidWord && validWords.length === expected.length && expected.every((word) => validWords.includes(word));
    return {
      valid: complete,
      complete,
      reason: invalidWord ? 'That selection is not a hidden word.' : 'Find all of the puzzle words.',
      details: { remaining: Math.max(0, expected.length - validWords.length), validWords },
    };
  }
  if (gameId === 'queens') {
    const cells = submission.cells;
    const size = puzzle.config.size;
    if (!Array.isArray(cells) || cells.length !== size) return { valid: false, reason: `Place ${size} queens before submitting.` };
    const rows = new Set(); const cols = new Set(); const regions = new Set();
    for (const [row, col] of cells) {
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= size || col >= size) return { valid: false, reason: 'A queen is outside the board.' };
      const region = puzzle.config.regions[row]?.[col];
      if (rows.has(row) || cols.has(col) || regions.has(region)) return { valid: false, reason: 'Queens cannot share a row, column, or region.' };
      if (cells.some(([otherRow, otherCol]) => otherRow !== row && Math.abs(otherRow - row) <= 1 && Math.abs(otherCol - col) <= 1)) return { valid: false, reason: 'Queens may not touch, even diagonally.' };
      rows.add(row); cols.add(col); regions.add(region);
    }
    return { valid: true, reason: 'Correct.' };
  }
  if (gameId === 'zip') {
    const path = submission.path;
    const size = puzzle.config.size; const total = size * size;
    const checkpointPositions = new Map();
    (puzzle.config.numbers || []).forEach((number, cell) => { if (number) checkpointPositions.set(Number(number), cell); });
    if (!Array.isArray(path) || path.length !== total) return { valid: false, reason: `Visit all ${total} cells before submitting.` };
    const seen = new Set();
    for (let index = 0; index < path.length; index += 1) {
      const cell = Number(path[index]); const row = Math.floor(cell / size); const col = cell % size;
      if (!Number.isInteger(cell) || cell < 0 || cell >= total || seen.has(cell)) return { valid: false, reason: 'The path cannot leave the board or revisit a cell.' };
      if (index > 0) { const previous = Number(path[index - 1]); const pr = Math.floor(previous / size); const pc = previous % size; if (Math.abs(row - pr) + Math.abs(col - pc) !== 1) return { valid: false, reason: 'Every step must move to an adjacent cell.' }; }
      seen.add(cell);
    }
    const checkpointOrder = [...checkpointPositions.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, cell]) => path.indexOf(cell));
    for (let index = 1; index < checkpointOrder.length; index += 1) {
      if (checkpointOrder[index] <= checkpointOrder[index - 1]) return { valid: false, reason: 'Visit numbered checkpoints in order.' };
    }
    return { valid: true, reason: 'Correct.' };
  }
  if (gameId === 'tango') {
    const cells = submission.cells; const size = puzzle.config.size;
    if (!Array.isArray(cells) || cells.length !== size * size || cells.some((cell) => cell !== 0 && cell !== 1)) return { valid: false, reason: 'Fill every Tango cell with a sun or moon.' };
    for (let row = 0; row < size; row += 1) { const line = cells.slice(row * size, row * size + size); if (line.filter((v) => v === 1).length !== size / 2 || line.some((v, i) => i > 1 && line[i - 1] === v && line[i - 2] === v)) return { valid: false, reason: 'Each row needs equal symbols and no three alike.' }; }
    for (let col = 0; col < size; col += 1) { const line = cells.filter((_, i) => i % size === col); if (line.filter((v) => v === 1).length !== size / 2 || line.some((v, i) => i > 1 && line[i - 1] === v && line[i - 2] === v)) return { valid: false, reason: 'Each column needs equal symbols and no three alike.' }; }
    return { valid: true, reason: 'Correct.' };
  }
  if (gameId === 'sudoku') {
    const cells = submission.cells; if (!Array.isArray(cells) || cells.length !== 81 || cells.some((v) => !Number.isInteger(v) || v < 1 || v > 9)) return { valid: false, reason: 'Complete all 81 Sudoku cells with numbers 1–9.' };
    for (let index = 0; index < 81; index += 1) if (puzzle.config.givens[index] && cells[index] !== puzzle.config.givens[index]) return { valid: false, reason: 'Given Sudoku clues cannot be changed.' };
    for (let row = 0; row < 9; row += 1) { const line = cells.slice(row * 9, row * 9 + 9); if (new Set(line).size !== 9) return { valid: false, reason: 'Every Sudoku row must contain 1–9 exactly once.' }; }
    for (let col = 0; col < 9; col += 1) { const line = cells.filter((_, i) => i % 9 === col); if (new Set(line).size !== 9) return { valid: false, reason: 'Every Sudoku column must contain 1–9 exactly once.' }; }
    for (let boxRow = 0; boxRow < 9; boxRow += 3) for (let boxCol = 0; boxCol < 9; boxCol += 3) { const box = []; for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) box.push(cells[(boxRow + r) * 9 + boxCol + c]); if (new Set(box).size !== 9) return { valid: false, reason: 'Every Sudoku box must contain 1–9 exactly once.' }; }
    // Any complete grid that keeps the clues and follows the rules is a solve;
    // sparse boards can have more than one.
    return { valid: true, reason: 'Correct.' };
  }
  if (gameId === 'patches') {
    const placements = submission.placements || {}; const pieces = puzzle.config.pieces || [];
    if (Object.keys(placements).length !== pieces.length || pieces.some((piece) => !Object.prototype.hasOwnProperty.call(placements, piece.id))) return { valid: false, reason: 'Place every patch before submitting.' };
    const occupied = new Set();
    for (const piece of pieces) {
      const placement = placements[piece.id];
      if (!placement || !Number.isInteger(placement.r) || !Number.isInteger(placement.c) || !Number.isInteger(placement.rot) || placement.rot < 0 || placement.rot > 3) return { valid: false, reason: 'Every patch needs a valid position and rotation.' };
      const rotated = piece.cells.map(([r, c]) => { if (placement.rot === 1) return [c, -r]; if (placement.rot === 2) return [-r, -c]; if (placement.rot === 3) return [-c, r]; return [r, c]; });
      const minRow = Math.min(...rotated.map(([r]) => r)); const minCol = Math.min(...rotated.map(([, c]) => c));
      for (const [r, c] of rotated) { const finalRow = placement.r + r - minRow; const finalCol = placement.c + c - minCol; const key = `${finalRow}-${finalCol}`; if (finalRow < 0 || finalCol < 0 || finalRow >= puzzle.config.size || finalCol >= puzzle.config.size || occupied.has(key)) return { valid: false, reason: 'Patches cannot overlap or leave gaps.' }; occupied.add(key); }
    }
    return { valid: occupied.size === puzzle.config.size * puzzle.config.size, reason: 'Every cell must be covered exactly once.' };
  }
  return { valid: false, reason: 'This puzzle cannot be validated.' };
}

function publicPuzzle(row) {
  return { id: row.game_id, date: row.puzzle_date, ...row.puzzle };
}

async function ensurePuzzle(client, gameId, date) {
  const existing = await client.query('SELECT puzzle_date, game_id, puzzle, solution FROM hcm.daily_puzzles WHERE puzzle_date = $1 AND game_id = $2', [date, gameId]);
  if (existing.rows[0]) return existing.rows[0];
  const generated = buildPuzzle(gameId, date);
  const publicPuzzle = { config: generated.config, title: generated.title };
  const inserted = await client.query(
    `INSERT INTO hcm.daily_puzzles (puzzle_date, game_id, puzzle, solution) VALUES ($1, $2, $3::jsonb, $4::jsonb) RETURNING puzzle_date, game_id, puzzle, solution`,
    [date, gameId, JSON.stringify(publicPuzzle), JSON.stringify(generated.solution)],
  );
  return inserted.rows[0];
}

async function ensureVariant(client, gameId, difficulty, level) {
  const selectedDifficulty = difficultyOf(difficulty);
  const selectedLevel = Math.max(1, Number(level) || 1);
  const existing = await client.query(
    'SELECT puzzle_id, game_id, difficulty, level_number, puzzle, solution, seed FROM hcm.daily_game_variants WHERE game_id = $1 AND difficulty = $2 AND level_number = $3',
    [gameId, selectedDifficulty, selectedLevel],
  );
  if (existing.rows[0]) return existing.rows[0];
  const fallback = buildPuzzle(gameId, `${localDate()}:${selectedLevel}`, selectedDifficulty, selectedLevel);
  // Normalize and validate external content before exposing it. If a provider is unavailable,
  // the deterministic fallback keeps the game playable while preserving the same contract.
  let generated = await buildExternalPuzzle(gameId, selectedDifficulty, selectedLevel, fallback);
  const publicPuzzle = { config: generated.config, title: generated.title };
  const seed = `${gameId}:${selectedDifficulty}:${selectedLevel}:${localDate()}`;
  // When two requests race, keep the first puzzle and its solution together;
  // overwriting only the puzzle would leave it checked against another puzzle's answers.
  const inserted = await client.query(
    `INSERT INTO hcm.daily_game_variants (game_id, difficulty, level_number, puzzle, solution, seed)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (game_id, difficulty, level_number) DO NOTHING
     RETURNING puzzle_id, game_id, difficulty, level_number, puzzle, solution, seed`,
    [gameId, selectedDifficulty, selectedLevel, JSON.stringify(publicPuzzle), JSON.stringify(generated.solution), seed],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  return (await client.query(
    'SELECT puzzle_id, game_id, difficulty, level_number, puzzle, solution, seed FROM hcm.daily_game_variants WHERE game_id = $1 AND difficulty = $2 AND level_number = $3',
    [gameId, selectedDifficulty, selectedLevel],
  )).rows[0];
}

/**
 * What the hints used so far reveal: each hint removes one wrong quiz/trivia
 * choice or word, or fills in one Sudoku cell. Returned with the puzzle too,
 * so a refresh keeps them.
 */
function hintReveals(gameId, variant, hintsUsed) {
  const count = Math.max(0, Math.min(Number(hintsUsed) || 0, 5));
  const { config = {} } = variant.puzzle || {};
  const solution = variant.solution || {};
  if (!count) return null;
  if (gameId === 'quiz' || gameId === 'trivia') {
    const questions = config.questions || [];
    const eliminated = {};
    for (let hint = 0; hint < count && questions.length; hint += 1) {
      const index = hint % questions.length;
      const wrong = questions[index].choices.map((_, choice) => choice).filter((choice) => choice !== solution.answers?.[index] && !(eliminated[index] || []).includes(choice));
      // Always leave at least two choices on the board.
      if (wrong.length > 1) eliminated[index] = [...(eliminated[index] || []), wrong[seededNumber(`${variant.puzzle_id}:${hint}`) % wrong.length]];
    }
    return { eliminated };
  }
  if (gameId === 'word') {
    const wrong = seededShuffle((config.choices || []).filter((word) => word !== solution.word), `${variant.puzzle_id}:word-hints`);
    return { eliminatedWords: wrong.slice(0, Math.min(count, wrong.length - 1)) };
  }
  if (gameId === 'sudoku') {
    const empty = seededShuffle((config.givens || []).map((value, index) => (value ? null : index)).filter((index) => index !== null), `${variant.puzzle_id}:sudoku-hints`);
    return { cells: Object.fromEntries(empty.slice(0, count).map((index) => [index, solution.cells[index]])) };
  }
  return null;
}

function hintMessage(gameId, hintsUsed) {
  if (gameId === 'quiz' || gameId === 'trivia') return `Hint ${hintsUsed}: one wrong answer has been removed.`;
  if (gameId === 'word') return `Hint ${hintsUsed}: one wrong word has been crossed out.`;
  if (gameId === 'sudoku') return `Hint ${hintsUsed}: one more cell has been filled in for you.`;
  return 'Keep going — check the rule panel for your next move.';
}

function variantRequested(req) {
  return req.query.difficulty !== undefined || req.query.level !== undefined || req.body?.difficulty !== undefined || req.body?.level !== undefined;
}

function variantArgs(req) {
  return { difficulty: difficultyOf(req.query.difficulty ?? req.body?.difficulty), level: Math.max(1, Number(req.query.level ?? req.body?.level) || 1) };
}

function publicVariant(row) {
  return { id: row.puzzle_id, gameId: row.game_id, difficulty: row.difficulty, level: row.level_number, ...row.puzzle };
}

async function getVariantPuzzle(req, res, next) {
  if (!GAME_ORDER.includes(req.params.gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
  const client = await pool.connect();
  try {
    const gameId = req.params.gameId; const { difficulty, level } = variantArgs(req); const id = employeeId(req);
    if (level > MAX_LEVEL) return res.status(404).json({ success: false, message: `All ${difficulty} levels are completed. Pick another difficulty to keep playing.` });
    const variant = await ensureVariant(client, gameId, difficulty, level);
    await client.query(`INSERT INTO hcm.daily_game_variant_sessions (employee_id, puzzle_id) VALUES ($1, $2) ON CONFLICT (employee_id, puzzle_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`, [id, variant.puzzle_id]);
    const session = (await client.query('SELECT hints_used AS "hintsUsed", status, started_at FROM hcm.daily_game_variant_sessions WHERE employee_id = $1 AND puzzle_id = $2', [id, variant.puzzle_id])).rows[0];
    const completion = (await client.query('SELECT points AS score, completion_ms, hints_used AS "hintsUsed", created_at FROM hcm.daily_game_variant_completions WHERE employee_id = $1 AND puzzle_id = $2', [id, variant.puzzle_id])).rows[0] || null;
    const game = (await client.query('SELECT id, title, difficulty, description, icon, color, minutes, max_points AS points, subtitle, rules, scoring FROM hcm.games WHERE id = $1', [gameId])).rows[0] || {};
    const progress = (await client.query('SELECT current_level AS "currentLevel", highest_level AS "highestLevel", total_completed AS "totalCompleted", total_points AS "totalPoints" FROM hcm.daily_game_progress WHERE employee_id = $1 AND game_id = $2 AND difficulty = $3', [id, gameId, difficulty])).rows[0] || { currentLevel: 1, highestLevel: 0, totalCompleted: 0, totalPoints: 0 };
    res.json({ success: true, data: { game: { ...game, rules: game.rules || [], scoring: game.scoring || [], difficulty }, puzzle: publicVariant(variant), session: { maxHints: 5, ...(session || {}), reveals: hintReveals(gameId, variant, session?.hintsUsed) }, completion, progress, maxLevel: MAX_LEVEL } });
  } catch (err) { next(err); } finally { client.release(); }
}

async function startVariantGame(req, res, next) {
  if (!GAME_ORDER.includes(req.params.gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
  const client = await pool.connect();
  try {
    const gameId = req.params.gameId; const { difficulty, level } = variantArgs(req); const id = employeeId(req);
    if (level > MAX_LEVEL) return res.status(404).json({ success: false, message: `All ${difficulty} levels are completed. Pick another difficulty to keep playing.` });
    const variant = await ensureVariant(client, gameId, difficulty, level);
    const result = await client.query(`INSERT INTO hcm.daily_game_variant_sessions (employee_id, puzzle_id) VALUES ($1, $2) ON CONFLICT (employee_id, puzzle_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING status, hints_used AS "hintsUsed", started_at`, [id, variant.puzzle_id]);
    res.json({ success: true, data: { ...result.rows[0], puzzleId: variant.puzzle_id, difficulty, level } });
  } catch (err) { next(err); } finally { client.release(); }
}

async function variantRowFor(req, client) {
  const { difficulty, level } = variantArgs(req);
  const requestedPuzzleId = req.body?.puzzleId || req.query?.puzzleId;
  const result = requestedPuzzleId
    ? await client.query('SELECT puzzle_id, game_id, difficulty, level_number, puzzle, solution, seed FROM hcm.daily_game_variants WHERE puzzle_id = $1 AND game_id = $2', [requestedPuzzleId, req.params.gameId])
    : await client.query('SELECT puzzle_id, game_id, difficulty, level_number, puzzle, solution, seed FROM hcm.daily_game_variants WHERE game_id = $1 AND difficulty = $2 AND level_number = $3', [req.params.gameId, difficulty, level]);
  if (!result.rows[0]) return null;
  return result.rows[0];
}

async function checkVariantSolution(req, res, next) {
  if (!GAME_ORDER.includes(req.params.gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
  const client = await pool.connect();
  try {
    const variant = await variantRowFor(req, client);
    if (!variant) return res.status(404).json({ success: false, message: 'Puzzle variant not found. Load the puzzle again.' });
    const result = validateSubmission(req.params.gameId, req.body?.submission, variant.solution, variant.puzzle);
    res.json({ success: true, data: { valid: result.valid, complete: result.complete ?? result.valid, reason: result.reason, details: result.details || null } });
  } catch (err) { next(err); } finally { client.release(); }
}

async function useVariantHint(req, res, next) {
  if (!GAME_ORDER.includes(req.params.gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
  const client = await pool.connect();
  try {
    const id = employeeId(req); const variant = await variantRowFor(req, client);
    if (!variant) return res.status(404).json({ success: false, message: 'Puzzle variant not found. Load the puzzle again.' });
    const result = await client.query(`UPDATE hcm.daily_game_variant_sessions SET hints_used = LEAST(hints_used + 1, 5), updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1 AND puzzle_id = $2 RETURNING hints_used AS "hintsUsed"`, [id, variant.puzzle_id]);
    const hintsUsed = result.rows[0]?.hintsUsed || 0;
    const clues = req.params.gameId === 'pinpoint' ? (variant.puzzle.config?.clues || []).slice(0, hintsUsed) : undefined;
    res.json({ success: true, data: { hintsUsed, reveals: hintReveals(req.params.gameId, variant, hintsUsed), ...(clues ? { clues } : {}), hint: clues ? `Clue ${hintsUsed} revealed.` : hintMessage(req.params.gameId, hintsUsed) } });
  } catch (err) { next(err); } finally { client.release(); }
}

async function completeVariantGame(req, res, next) {
  if (!GAME_ORDER.includes(req.params.gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
  const client = await pool.connect();
  try {
    const id = employeeId(req); const variant = await variantRowFor(req, client);
    if (!variant) return res.status(404).json({ success: false, message: 'Puzzle variant not found. Load the puzzle again.' });
    await client.query('BEGIN');
    const validation = validateSubmission(req.params.gameId, req.body?.submission, variant.solution, variant.puzzle);
    if (!validation.valid) { await client.query('ROLLBACK'); return res.status(422).json({ success: false, message: validation.reason, data: { valid: false, complete: validation.complete || false, points: 0 } }); }
    const session = (await client.query('SELECT hints_used, started_at FROM hcm.daily_game_variant_sessions WHERE employee_id = $1 AND puzzle_id = $2 FOR UPDATE', [id, variant.puzzle_id])).rows[0];
    if (!session) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, message: 'Start the game before submitting a completion.' }); }
    const maxPoints = (await client.query('SELECT max_points FROM hcm.games WHERE id = $1', [req.params.gameId])).rows[0]?.max_points || GAME_REWARDS[req.params.gameId] || 100;
    const points = Math.max(0, Math.round(maxPoints * DIFFICULTY_MULTIPLIER[variant.difficulty] * (1 - Math.min(Number(session.hints_used || 0), 5) * 0.1)));
    const completionMs = Math.max(0, Date.now() - new Date(session.started_at).getTime());
    const inserted = await client.query(`INSERT INTO hcm.daily_game_variant_completions (employee_id, puzzle_id, points, completion_ms, hints_used) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (employee_id, puzzle_id) DO NOTHING RETURNING points, completion_ms, created_at`, [id, variant.puzzle_id, points, completionMs, session.hints_used || 0]);
    const completion = inserted.rows[0] || (await client.query('SELECT points, completion_ms, created_at FROM hcm.daily_game_variant_completions WHERE employee_id = $1 AND puzzle_id = $2', [id, variant.puzzle_id])).rows[0];
    if (inserted.rows[0]) {
      const date = localDate();
      await client.query(`INSERT INTO hcm.daily_game_variant_reward_ledger (employee_id, puzzle_id, points, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, variant.puzzle_id, points, `Validated ${variant.game_id} ${variant.difficulty} level ${variant.level_number} completion`]);
      await recordGlobalPoints(client, req, points);
      await client.query(`INSERT INTO hcm.daily_game_progress (employee_id, game_id, difficulty, current_level, highest_level, total_completed, total_points) VALUES ($1, $2, $3, $4, $4, 1, $5) ON CONFLICT (employee_id, game_id, difficulty) DO UPDATE SET current_level = GREATEST(hcm.daily_game_progress.current_level, $4 + 1), highest_level = GREATEST(hcm.daily_game_progress.highest_level, $4), total_completed = hcm.daily_game_progress.total_completed + 1, total_points = hcm.daily_game_progress.total_points + $5, updated_at = CURRENT_TIMESTAMP`, [id, variant.game_id, variant.difficulty, variant.level_number, points]);
      await recordStreakAward(client, id, date, points);
    }
    await client.query('UPDATE hcm.daily_game_variant_sessions SET status = $3, updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1 AND puzzle_id = $2', [id, variant.puzzle_id, 'completed']);
    const progress = (await client.query('SELECT current_level AS "currentLevel", highest_level AS "highestLevel", total_completed AS "totalCompleted", total_points AS "totalPoints" FROM hcm.daily_game_progress WHERE employee_id = $1 AND game_id = $2 AND difficulty = $3', [id, variant.game_id, variant.difficulty])).rows[0];
    const stats = await statsFor(client, id, localDate());
    await client.query('COMMIT');
    res.json({ success: true, data: { valid: true, duplicate: !inserted.rows[0], completion: { ...completion, score: completion?.score ?? completion?.points }, progress, stats, difficulty: variant.difficulty, level: variant.level_number, maxLevel: MAX_LEVEL, nextLevel: variant.level_number >= MAX_LEVEL ? null : variant.level_number + 1, celebrations: [] } });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); next(err); } finally { client.release(); }
}

/**
 * Monday → Sunday completion history for the calendar week that contains `date`.
 * A day counts as completed when the employee banked at least one verified
 * game completion that calendar day (legacy or level-based play alike).
 */
async function weekFor(client, id, date) {
  const { start, end } = weekRange(date);
  const result = await client.query(`
    SELECT DISTINCT d::text AS day FROM (
      SELECT award_date AS d
      FROM hcm.daily_game_streak_awards
      WHERE employee_id = $1 AND award_date >= $2::date AND award_date <= $3::date
      UNION
      SELECT puzzle_date AS d
      FROM hcm.daily_game_completions
      WHERE employee_id = $1 AND puzzle_date >= $2::date AND puzzle_date <= $3::date
      UNION
      SELECT (c.created_at AT TIME ZONE $4)::date AS d
      FROM hcm.daily_game_variant_completions c
      WHERE c.employee_id = $1
        AND (c.created_at AT TIME ZONE $4)::date >= $2::date
        AND (c.created_at AT TIME ZONE $4)::date <= $3::date
    ) days(d)
    ORDER BY day
  `, [id, start, end, ORG_TIMEZONE]);
  const completed = new Set(result.rows.map((row) => row.day));
  return Array.from({ length: 7 }, (_, index) => {
    const day = shiftDate(start, index);
    return { date: day, completed: completed.has(day), isToday: day === date };
  });
}

async function statsFor(client, id, date) {
  const streakResult = await client.query('SELECT current_streak AS "currentStreak", longest_streak AS "longestStreak", total_points AS "totalPoints", last_completed_date::text AS "lastCompletedDate" FROM hcm.daily_game_streaks WHERE employee_id = $1', [id]);
  const completionResult = await client.query(`
    SELECT COUNT(*)::int AS "totalLevels",
           COUNT(*) FILTER (WHERE completed_date = $2)::int AS "levelsCompletedToday",
           COUNT(*)::int AS "totalCompleted",
           COUNT(*) FILTER (WHERE completed_date = $2)::int AS "completedToday",
           COALESCE(SUM(points), 0)::int AS "totalPoints",
           COALESCE(SUM(points) FILTER (WHERE completed_date = $2), 0)::int AS "todayPoints"
    FROM (
      SELECT game_id, points, puzzle_date AS completed_date
      FROM hcm.daily_game_completions
      WHERE employee_id = $1
      UNION ALL
      SELECT p.game_id, c.points, (c.created_at AT TIME ZONE '${ORG_TIMEZONE}')::date AS completed_date
      FROM hcm.daily_game_variant_completions c
      JOIN hcm.daily_game_variants p ON p.puzzle_id = c.puzzle_id
      WHERE c.employee_id = $1
    ) completed
  `, [id, date]);
  const streak = streakResult.rows[0];
  const lastCompletedDate = streak?.lastCompletedDate || null;
  const activeStreak = lastCompletedDate === date || lastCompletedDate === shiftDate(date, -1);
  const completionStats = completionResult.rows[0] || {};
  const stats = {
    currentStreak: activeStreak ? Number(streak?.currentStreak || 0) : 0,
    longestStreak: Number(streak?.longestStreak || 0),
    totalPoints: Number(completionStats.totalPoints || 0),
    totalCompleted: Number(completionStats.totalCompleted || 0),
    completedToday: Number(completionStats.completedToday || 0),
    todayPoints: Number(completionStats.todayPoints || 0),
    levelsCompleted: Number(completionStats.totalLevels || 0),
    levelsCompletedToday: Number(completionStats.levelsCompletedToday || 0),
    lastCompletedDate,
    week: await weekFor(client, id, date),
  };
  const bests = await client.query(`
    SELECT game_id, points AS score, completion_ms FROM hcm.daily_game_completions WHERE employee_id = $1
    UNION ALL
    SELECT p.game_id, c.points AS score, c.completion_ms
    FROM hcm.daily_game_variant_completions c
    JOIN hcm.daily_game_variants p ON p.puzzle_id = c.puzzle_id
    WHERE c.employee_id = $1
    ORDER BY game_id, score DESC, completion_ms ASC
  `, [id]);
  stats.personalBests = {};
  for (const row of bests.rows) if (!stats.personalBests[row.game_id]) stats.personalBests[row.game_id] = row;
  return stats;
}

exports.getAllGames = async (req, res, next) => {
  try {
    const result = await query('SELECT id, title, subtitle, difficulty, description, icon, color, available FROM hcm.games WHERE available = true AND id = ANY($1::text[]) ORDER BY array_position($1::text[], id)', [GAME_ORDER]);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

exports.listDailyGames = async (req, res, next) => {
  try {
    const id = employeeId(req); const date = localDate(); const client = await pool.connect();
    try {
      const games = await client.query(`SELECT id, title, subtitle, difficulty, description, icon, color, minutes, max_points AS points FROM hcm.games WHERE available = true AND id = ANY($1::text[]) ORDER BY array_position($1::text[], id)`, [GAME_ORDER]);
      const completions = await client.query('SELECT game_id, points, completion_ms, created_at FROM hcm.daily_game_completions WHERE employee_id = $1 AND puzzle_date = $2', [id, date]);
      const sessions = await client.query('SELECT game_id, status FROM hcm.daily_game_sessions WHERE employee_id = $1 AND puzzle_date = $2', [id, date]);
      const variantCompletions = await client.query(`SELECT p.game_id, COUNT(*)::int AS completed, COALESCE(SUM(c.points), 0)::int AS points, MAX(c.created_at) AS created_at FROM hcm.daily_game_variant_completions c JOIN hcm.daily_game_variants p ON p.puzzle_id = c.puzzle_id WHERE c.employee_id = $1 AND (c.created_at AT TIME ZONE '${ORG_TIMEZONE}')::date = $2 GROUP BY p.game_id`, [id, date]);
      const completionMap = new Map(completions.rows.map((row) => [row.game_id, { ...row, levelsCompleted: 1 }]));
      for (const row of variantCompletions.rows) {
        const existing = completionMap.get(row.game_id);
        completionMap.set(row.game_id, {
          ...(existing || { game_id: row.game_id }),
          points: Number(existing?.points || 0) + Number(row.points || 0),
          created_at: row.created_at,
          levelsCompleted: Number(existing?.levelsCompleted || 0) + Number(row.completed || 0),
        });
      }
      const sessionMap = new Map(sessions.rows.map((row) => [row.game_id, row.status]));
      const stats = await statsFor(client, id, date);
      res.json({ success: true, data: games.rows.map((game) => ({ ...game, status: completionMap.has(game.id) ? 'completed' : (sessionMap.get(game.id) || 'not_played'), completion: completionMap.get(game.id) || null })), stats: { ...stats, totalGames: games.rowCount, totalLevels: stats.levelsCompleted } });
    } finally { client.release(); }
  } catch (err) { next(err); }
};

exports.getStats = async (req, res, next) => { try { const client = await pool.connect(); try { res.json({ success: true, data: await statsFor(client, employeeId(req), localDate()) }); } finally { client.release(); } } catch (err) { next(err); } };

exports.getPuzzle = async (req, res, next) => {
  try {
    const gameId = req.params.gameId; if (!GAME_ORDER.includes(gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
    if (variantRequested(req)) return getVariantPuzzle(req, res, next);
    const id = employeeId(req); const date = localDate(); const client = await pool.connect();
    try {
      const puzzleRow = await ensurePuzzle(client, gameId, date);
      await client.query(`INSERT INTO hcm.daily_game_sessions (employee_id, puzzle_date, game_id) VALUES ($1, $2, $3) ON CONFLICT (employee_id, puzzle_date, game_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`, [id, date, gameId]);
      const game = (await client.query('SELECT id, title, difficulty, description, icon, color, minutes, max_points AS points, subtitle, rules, scoring FROM hcm.games WHERE id = $1', [gameId])).rows[0] || {};
      const completion = (await client.query('SELECT points AS score, completion_ms, created_at FROM hcm.daily_game_completions WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3', [id, date, gameId])).rows[0] || null;
      const session = (await client.query('SELECT hints_used AS "hintsUsed" FROM hcm.daily_game_sessions WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3', [id, date, gameId])).rows[0];
      res.json({ success: true, data: { game: { ...game, rules: game.rules || [], scoring: game.scoring || [] }, puzzle: publicPuzzle(puzzleRow), session: { maxHints: 3, ...(session || {}) }, completion } });
    } finally { client.release(); }
  } catch (err) { next(err); }
};

exports.startGame = async (req, res, next) => {
  if (variantRequested(req)) return startVariantGame(req, res, next);
  const client = await pool.connect();
  try {
    const gameId = req.params.gameId;
    if (!GAME_ORDER.includes(gameId)) return res.status(404).json({ success: false, message: 'Game not found' });
    const id = employeeId(req); const date = localDate();
    await client.query('BEGIN');
    await ensurePuzzle(client, gameId, date);
    const result = await client.query(`INSERT INTO hcm.daily_game_sessions (employee_id, puzzle_date, game_id) VALUES ($1, $2, $3) ON CONFLICT (employee_id, puzzle_date, game_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING status, hints_used AS "hintsUsed", started_at`, [id, date, gameId]);
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); next(err); } finally { client.release(); }
};

exports.checkSolution = async (req, res, next) => {
  if (variantRequested(req)) return checkVariantSolution(req, res, next);
  try {
    const gameId = req.params.gameId; const client = await pool.connect();
    try { const row = await ensurePuzzle(client, gameId, localDate()); const result = validateSubmission(gameId, req.body?.submission, row.solution, row.puzzle); res.json({ success: true, data: { valid: result.valid, reason: result.valid ? 'Correct so far.' : result.reason, details: result.details || null } }); } finally { client.release(); }
  } catch (err) { next(err); }
};

exports.useHint = async (req, res, next) => {
  if (variantRequested(req)) return useVariantHint(req, res, next);
  try {
    const id = employeeId(req); const date = localDate(); const gameId = req.params.gameId; const client = await pool.connect();
    try {
      const result = await client.query(`UPDATE hcm.daily_game_sessions SET hints_used = LEAST(hints_used + 1, 3), updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3 RETURNING hints_used AS "hintsUsed"`, [id, date, gameId]);
      const hintsUsed = result.rows[0]?.hintsUsed || 0;
      const puzzle = await ensurePuzzle(client, gameId, date);
      const clues = gameId === 'pinpoint' ? puzzle.puzzle.config.clues.slice(0, hintsUsed) : undefined;
      res.json({ success: true, data: { hintsUsed, ...(clues ? { clues } : {}), hint: clues ? `Clue ${hintsUsed} revealed.` : 'Keep going — check the rule panel for your next move.' } });
    } finally { client.release(); }
  } catch (err) { next(err); }
};

exports.completeGame = async (req, res, next) => {
  if (variantRequested(req)) return completeVariantGame(req, res, next);
  const client = await pool.connect();
  try {
    const id = employeeId(req); const date = localDate(); const gameId = req.params.gameId;
    await client.query('BEGIN');
    const puzzle = await ensurePuzzle(client, gameId, date);
    const validation = validateSubmission(gameId, req.body?.submission, puzzle.solution, puzzle.puzzle);
    if (!validation.valid) {
      await client.query('UPDATE hcm.daily_game_sessions SET status = \'failed_validation\', updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3', [id, date, gameId]);
      await client.query('COMMIT');
      return res.status(422).json({ success: false, message: validation.reason, data: { valid: false, points: 0, status: 'failed_validation' } });
    }
    const session = (await client.query('SELECT hints_used, started_at FROM hcm.daily_game_sessions WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3 FOR UPDATE', [id, date, gameId])).rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Start the game before submitting a completion.' });
    }
    const maxPoints = (await client.query('SELECT max_points FROM hcm.games WHERE id = $1', [gameId])).rows[0]?.max_points || GAME_REWARDS[gameId] || 100;
    const hints = Number(session?.hints_used || 0); const points = Math.max(0, Math.round(maxPoints * (1 - Math.min(hints, 3) * 0.1)));
    const completionMs = Math.max(0, Date.now() - new Date(session.started_at).getTime());
    const inserted = await client.query(`INSERT INTO hcm.daily_game_completions (employee_id, puzzle_date, game_id, points, completion_ms, hints_used) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (employee_id, puzzle_date, game_id) DO NOTHING RETURNING points, completion_ms, created_at`, [id, date, gameId, points, completionMs, hints]);
    const completion = inserted.rows[0] || (await client.query('SELECT points, points AS score, completion_ms, created_at FROM hcm.daily_game_completions WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3', [id, date, gameId])).rows[0];
    if (completion && completion.score === undefined) completion.score = completion.points;
    if (inserted.rows[0]) {
      await client.query(`INSERT INTO hcm.daily_game_reward_ledger (employee_id, puzzle_date, game_id, points, reason) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [id, date, gameId, points, `Validated ${gameId} completion`]);
      await recordGlobalPoints(client, req, points);
      await recordStreakAward(client, id, date, points);
    }
    await client.query('UPDATE hcm.daily_game_sessions SET status = \'completed\', updated_at = CURRENT_TIMESTAMP WHERE employee_id = $1 AND puzzle_date = $2 AND game_id = $3', [id, date, gameId]);
    const stats = await statsFor(client, id, date); await client.query('COMMIT');
    res.json({ success: true, data: { valid: true, duplicate: !inserted.rows[0], completion, stats, celebrations: [] } });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); next(err); } finally { client.release(); }
};

async function leaderboard(req, res, next, topOnly = false) {
  try {
    const period = ['today', 'week', 'month', 'all'].includes(req.query.period) ? req.query.period : 'all';
    const date = localDate(); const condition = period === 'today' ? 'c.puzzle_date = $1' : period === 'week' ? "c.puzzle_date >= ($1::date - INTERVAL '6 days')" : period === 'month' ? "c.puzzle_date >= ($1::date - INTERVAL '29 days')" : 'TRUE';
    const result = await query(`
      SELECT c.employee_id AS "employeeKey",
             COALESCE(MAX(NULLIF(CONCAT_WS(' ', e.first_name, e.last_name), '')), 'Employee') AS name,
             SUM(c.points)::int AS points,
             COUNT(DISTINCT c.game_id)::int AS "gamesInPeriod",
             COALESCE(MAX(s.current_streak), 0)::int AS streak
      FROM (
        SELECT employee_id, game_id, puzzle_date, points FROM hcm.daily_game_completions
        UNION ALL
        SELECT v.employee_id, p.game_id,
               (p.created_at AT TIME ZONE '${ORG_TIMEZONE}')::date AS puzzle_date,
               v.points
        FROM hcm.daily_game_variant_completions v
        JOIN hcm.daily_game_variants p ON p.puzzle_id = v.puzzle_id
      ) c
      LEFT JOIN hcm.employees e ON e.id = c.employee_id
      LEFT JOIN hcm.daily_game_streaks s ON s.employee_id = c.employee_id
      WHERE ${condition}
      GROUP BY c.employee_id
      ORDER BY points DESC, streak DESC, "gamesInPeriod" DESC
      LIMIT ${topOnly ? 3 : 25}
    `, condition === 'TRUE' ? [] : [date]);
    const rows = result.rows.map((row, index) => ({ ...row, rank: index + 1, initials: row.name.split(' ').map((part) => part[0]).join('').slice(0, 2), isMe: Number(row.employeeKey) === employeeId(req) }));
    const me = rows.find((row) => row.isMe) || null; res.json({ success: true, data: topOnly ? { champions: rows, me } : { rows, me } });
  } catch (err) { next(err); }
}

/**
 * Shared global Top 3 players leaderboard for the Daily Games summary banner.
 * Reads directly from the existing hcm.daily_game_employee_stats and
 * hcm.daily_game_players tables. Every authenticated employee sees the same
 * globally ranked data; only validated game-completion handlers update scores.
 */



exports.getChampions = async (req, res, next) => {
  try {
    const result = await query(`
      WITH all_completions AS (
        SELECT
          employee_id,
          game_id,
          puzzle_date AS completed_date,
          points
        FROM hcm.daily_game_completions

        UNION ALL

        SELECT
          v.employee_id,
          p.game_id,
          (p.created_at AT TIME ZONE '${ORG_TIMEZONE}')::date AS completed_date,
          v.points
        FROM hcm.daily_game_variant_completions v
        JOIN hcm.daily_game_variants p
          ON p.puzzle_id = v.puzzle_id
      ),
      player_totals AS (
        SELECT
          employee_id,
          SUM(points)::int AS points,
          COUNT(*)::int AS completed_games
        FROM all_completions
        GROUP BY employee_id
      )
      SELECT
        e.id::text AS "employeeKey",
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), ''),
          'Employee'
        ) AS name,
        pt.points,
        pt.completed_games AS "completedGames"
      FROM player_totals pt
      LEFT JOIN hcm.employees e
        ON e.id = pt.employee_id
      ORDER BY
        pt.points DESC,
        pt.completed_games DESC,
        name ASC
      LIMIT 3
    `);

    const champions = result.rows.map((row, index) => ({
      employeeKey: row.employeeKey,
      name: row.name || 'Employee',
      initials: (row.name || 'Employee')
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
      points: Number(row.points || 0),
      completedGames: Number(row.completedGames || 0),
      rank: index + 1,
    }));

    return res.json({
      success: true,
      data: { champions },
    });
  } catch (err) {
    next(err);
  }
};




exports.getLeaderboard = (req, res, next) => leaderboard(req, res, next, false);
exports.getCelebrations = async (req, res, next) => { try { res.json({ success: true, data: [] }); } catch (err) { next(err); } };
exports.acknowledgeCelebration = async (req, res, next) => { try { res.json({ success: true }); } catch (err) { next(err); } };
exports.validateSubmission = validateSubmission;
exports.buildPuzzle = buildPuzzle;
exports.hintReveals = hintReveals;
exports.computeStreakState = computeStreakState;
exports.recordStreakAward = recordStreakAward;
exports.statsFor = statsFor;
exports.weekRange = weekRange;
exports.shiftDate = shiftDate;
