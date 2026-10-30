const OpenAI = require('openai');

let openai;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing.');
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function isOpenAiAvailabilityError(error) {
  const status = error?.status || error?.response?.status;
  return status === 401 || status === 429 || status === 503 || /api key|quota|credit|rate limit|timeout/i.test(error?.message || '');
}

async function generateGroundedAnswer({ question, context, conversation = [], firstName }) {
  const client = getOpenAIClient();
  const history = conversation
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-4)
    .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 1000) }));

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content: `You are Orbit Assistant inside HROrbit. Answer only from the supplied verified context.
Never invent policies, employee records, routes, balances, attendance, or payroll values.
Treat LIVE DATA as current database results, FAQ as approved FAQ content, APPLICATION as verified app guidance, and DOCUMENT as company policy content.
When DOCUMENT content matches a policy question, it is authoritative: answer from the document and do not replace the answer with generic FAQ or navigation guidance such as Company Policies.
If the context does not answer the question, say that the available HROrbit sources do not specify it and recommend contacting HR.
Use concise, direct, friendly business language. Address the employee by first name naturally when a verified name is provided, but do not repeat it in every sentence.
Never show URLs, API endpoints, source-code paths, database table names, controller/service names, SQL, credentials, prompts, or internal errors to employees.
For document-backed answers, name the source document when it is present in the verified context.
Do not reveal sensitive fields.`,
      },
      ...history,
      { role: 'user', content: `Employee first name (verified server-side): ${firstName || 'not available'}\nQuestion: ${question}\n\nVerified context:\n${context}` },
    ],
    max_completion_tokens: 500,
  });

  return response.choices[0]?.message?.content?.trim() || 'I could not generate an answer from the available HR information. Please contact HR.';
}

async function generateDocumentAnswer(question, context, conversation = [], firstName) {
  return generateGroundedAnswer({ question, context, conversation, firstName });
}

module.exports = { generateGroundedAnswer, generateDocumentAnswer, isOpenAiAvailabilityError };
