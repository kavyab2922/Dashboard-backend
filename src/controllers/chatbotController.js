const { answerQuestion, approvedLeave } = require('../services/chatbotKnowledgeService');

function safeConversation(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-6)
    .map((item) => ({ role: item.role, content: String(item.content || item.text || '').slice(0, 1000) }));
}

const askChatbot = async (req, res) => {
  try {
    const { question, conversation } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ success: false, message: 'Please enter a question.' });
    }
    if (question.length > 500) {
      return res.status(400).json({ success: false, message: 'Question cannot exceed 500 characters.' });
    }

    const result = await answerQuestion({
      question: question.trim(),
      user: req.user,
      conversation: safeConversation(conversation),
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Chatbot question failed:', error.message);
    return res.status(503).json({ success: false, message: 'The HR assistant is temporarily unavailable. Please try again or contact HR.' });
  }
};

const getEmployeesOnLeave = async (req, res) => {
  try {
    const result = await approvedLeave('who is on leave today', req.user);
    return res.status(200).json({
      success: true,
      date: result.date,
      count: result.employees.length,
      employees: result.employees,
    });
  } catch (error) {
    console.error('Employees on leave fetch failed:', error.message);
    return res.status(503).json({ success: false, message: 'Unable to fetch employees on leave.' });
  }
};

module.exports = { askChatbot, getEmployeesOnLeave };
