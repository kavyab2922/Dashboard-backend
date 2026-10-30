const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isLeavePolicyQuestion,
  retrieveDocuments,
} = require('./chatbotKnowledgeService');

test('classifies leave policy questions as document policy intent', () => {
  for (const question of [
    'leave policy',
    'What is our leave policy?',
    'How many casual leaves do employees get?',
    'What is the maternity leave policy?',
    'Can I carry forward my leaves?',
  ]) {
    assert.equal(isLeavePolicyQuestion(question), true, question);
  }
});

test('does not classify live or workflow leave questions as policy intent', () => {
  assert.equal(isLeavePolicyQuestion('How do I apply for leave?'), false);
  assert.equal(isLeavePolicyQuestion('Who is on leave today?'), false);
  assert.equal(isLeavePolicyQuestion('How many leaves do I have left?'), false);
});

test('ranks the uploaded leave policy document for policy questions', () => {
  const documents = [
    {
      file_name: 'Other HR Guide.pdf',
      extracted_text: 'Company policies are available from the HR portal.',
    },
    {
      file_name: 'Simplify3x Employee Leave Policy.pdf',
      extracted_text: 'Employee Leave Policy. Employees are eligible for 24 leaves in a calendar year: 18 Casual Leaves and 6 Sick Leaves. Up to 10 CLs can be carried forward.',
    },
  ];

  const results = retrieveDocuments('leave policy', documents, { policy: true });
  assert.equal(results[0].file_name, 'Simplify3x Employee Leave Policy.pdf');
  assert.match(results[0].chunk, /24 leaves|Casual Leaves/i);
});
