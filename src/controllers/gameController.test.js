const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPuzzle, validateSubmission } = require('./gameController');

const games = ['sudoku', 'quiz', 'word', 'trivia'];
const difficulties = ['easy', 'medium', 'hard', 'expert', 'master'];

test('generates and accepts a valid puzzle for every game and difficulty', () => {
  for (const difficulty of difficulties) {
    for (const game of games) {
      const puzzle = buildPuzzle(game, `test-seed-${difficulty}`, difficulty, 7);
      const result = validateSubmission(game, puzzle.solution, puzzle.solution, puzzle);
      assert.equal(result.valid, true, `${game}/${difficulty}: ${result.reason}`);
      assert.equal(puzzle.config.difficulty, difficulty);
      assert.equal(puzzle.config.level, 7);
    }
  }
});

test('rejects an incomplete Sudoku board', () => {
  const puzzle = buildPuzzle('sudoku', 'sudoku-test', 'hard', 2);
  const result = validateSubmission('sudoku', { cells: puzzle.solution.cells.slice(0, -1) }, puzzle.solution, puzzle);
  assert.equal(result.valid, false);
  assert.match(result.reason, /81/i);
});

test('rejects incomplete multiple-choice answers', () => {
  const puzzle = buildPuzzle('quiz', 'quiz-test', 'easy', 3);
  const result = validateSubmission('quiz', { answers: puzzle.solution.answers.slice(0, -1) }, puzzle.solution, puzzle);
  assert.equal(result.valid, false);
});

test('rejects Sudoku changes to givens', () => {
  const puzzle = buildPuzzle('sudoku', 'sudoku-test', 'medium', 1);
  const cells = [...puzzle.solution.cells];
  const givenIndex = puzzle.config.givens.findIndex(Boolean);
  cells[givenIndex] = cells[givenIndex] === 9 ? 1 : cells[givenIndex] + 1;
  const result = validateSubmission('sudoku', { cells }, puzzle.solution, puzzle);
  assert.equal(result.valid, false);
  assert.match(result.reason, /given/i);
});

test('rejects an incorrect Word Quest answer and accepts the solution', () => {
  const word = buildPuzzle('word', 'word-test', 'master', 4);
  assert.equal(validateSubmission('word', { word: 'not-the-answer' }, word.solution, word).valid, false);
  assert.equal(validateSubmission('word', word.solution, word.solution, word).valid, true);
});

test('rejects an incorrect Trivia answer', () => {
  const trivia = buildPuzzle('trivia', 'trivia-test', 'easy', 1);
  const answers = trivia.solution.answers.map(() => 99);
  assert.equal(validateSubmission('trivia', { answers }, trivia.solution, trivia).valid, false);
});
