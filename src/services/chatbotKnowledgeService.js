const { query } = require('../config/db');
const { generateGroundedAnswer, isOpenAiAvailabilityError } = require('./chatbotAIService');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_CHARS = 18000;

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}

function dateRangeFromQuestion(question, now = new Date()) {
  const text = String(question).toLowerCase();
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  if (/\bnext week\b/.test(text)) {
    const day = base.getDay() || 7;
    base.setDate(base.getDate() - day + 8);
    const end = new Date(base);
    end.setDate(end.getDate() + 6);
    return { start: isoDate(base), end: isoDate(end) };
  }
  if (/\bthis week\b/.test(text)) {
    const day = base.getDay() || 7;
    const start = new Date(base);
    start.setDate(start.getDate() - day + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: isoDate(start), end: isoDate(end) };
  }
  const date = new Date(base);
  if (/\btomorrow\b/.test(text)) date.setTime(date.getTime() + DAY_MS);
  else if (/\byesterday\b/.test(text)) date.setTime(date.getTime() - DAY_MS);
  return { start: isoDate(date), end: isoDate(date) };
}

function dateFromQuestion(question, now = new Date()) {
  return dateRangeFromQuestion(question, now).start;
}

function isLiveLeaveQuestion(question) {
  return /\b(on leave|leave today|leave tomorrow|leave yesterday|employees? on leave|who.*leave|department.*leave|leave.*department|is .* leave)\b/i.test(question);
}

function isLeavePolicyQuestion(question) {
  const text = String(question);
  const hasLeaveTopic = /\b(leaves?|casual|sick|maternity|paternity|menstrual|time off|vacation|pto)\b/i.test(text);
  const hasPolicySignal = /\b(policy|policies|entitlement|eligible|eligibility|allowance|allowed|approval|approv|carry\s*forward|accru|how many|how much|rules?|days?\s+(?:of|do|can)|available)\b/i.test(text)
    || /\b(casual|sick|maternity|paternity|menstrual)\s+leaves?\b/i.test(text);
  return hasLeaveTopic && hasPolicySignal
    && !/\b(my|i|me)\b.*\b(balance|remaining|left|history|request|pending|approved)\b/i.test(text)
    && !/\b(who|which employees?|anyone|anybody|is .+ on)\b.*\bleave\b/i.test(text)
    && !/\b(apply|application|submit|request)\b.*\bleave\b/i.test(text);
}

function isLeaveFollowUp(question, conversation) {
  const text = String(question).trim().toLowerCase();
  const previous = Array.isArray(conversation) ? conversation.slice(-4).map((item) => item?.content || '').join(' ') : '';
  return (/^(what about|and|how about)\s+(today|tomorrow|yesterday|this week|next week)\??$/i.test(text)
    || /^(show|filter|only)\s+(only\s+)?my department\??$/i.test(text))
    && /leave|absent|approved/i.test(previous);
}

function isProfileQuestion(question) {
  return /\b(my|me|i)\b.*\b(manager|department|designation|employee code|employee id|joined|joining|join date|profile)\b/i.test(question)
    || /\bwho is my reporting manager\b/i.test(question);
}

function isPersonalLeaveQuestion(question) {
  return /\b(my|i|me)\b.*\b(leave|balance|pending|approved|history|remaining)\b/i.test(question)
    || /\b(leave balance|leave history|pending leave)\b/i.test(question);
}

function isAttendanceQuestion(question) {
  return /\b(my|i|me)\b.*\b(attendance|present|absent|check.?in|check.?out|work hours|regulari[sz]ed)\b/i.test(question);
}

function isPayrollGuidanceQuestion(question) {
  return /\b(payslip|payroll|salary|pay|compensation)\b/i.test(question);
}

function isGreeting(question) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening|what can you do)\b/i.test(question.trim());
}

function isThanks(question) {
  return /^(thanks|thank you|thx|ty|cheers|great thanks|perfect thanks)\b/i.test(question.trim());
}

function employeeFirstName(employee) {
  return String(employee?.first_name || '').trim().split(/\s+/)[0] || '';
}

function personalize(answer, employee, { greeting = false } = {}) {
  const firstName = employeeFirstName(employee);
  if (!firstName) return answer;
  if (greeting) return `Hi ${firstName}! ${answer}`;
  return `${firstName}, ${answer.charAt(0).toLowerCase()}${answer.slice(1)}`;
}

function docChunks(text, size = 1400, overlap = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    chunks.push(clean.slice(start, start + size));
    if (start + size >= clean.length) break;
  }
  return chunks;
}

function terms(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((word) => word.length > 2));
}

function retrieveDocuments(question, documents, { policy = false } = {}) {
  const wanted = terms(question);
  const ranked = [];
  const policyDocument = (document) => /simplify3x employee leave policy/i.test(String(document.file_name || ''));

  const policyDocuments = policy ? documents.filter(policyDocument) : [];
  const candidateDocuments = policyDocuments.length ? policyDocuments : documents;
  candidateDocuments.forEach((document) => docChunks(document.extracted_text).forEach((chunk, index) => {
    const haystack = terms(chunk);
    let score = 0;
    wanted.forEach((term) => { if (haystack.has(term)) score += 1; });
    if (policy && policyDocument(document)) score += 8;
    if (score > 0) ranked.push({ score, file_name: document.file_name, chunk_index: index, chunk });
  }));
  return ranked
    .sort((a, b) => b.score - a.score)
    .filter((item, index, items) => index === items.findIndex((candidate) => candidate.chunk === item.chunk && candidate.file_name === item.file_name))
    .slice(0, 8);
}

async function resolveEmployee(user) {
  const id = Number(user?.id);
  const email = String(user?.email || user?.official_email || '').trim().toLowerCase();
  const code = String(user?.employee_code || user?.employeeCode || '').trim();
  const organizationId = Number(user?.organization_id || user?.organizationId);
  const result = await query(`
    SELECT e.id, e.employee_code, e.first_name, e.last_name, e.organization_id, e.department_id,
           d.department_name, des.designation_name, e.join_date
    FROM hcm.employees e
    LEFT JOIN hcm.departments d ON d.id = e.department_id
    LEFT JOIN hcm.designations des ON des.id = e.designation_id
    WHERE (($1::int IS NOT NULL AND e.id = $1)
       OR ($2 <> '' AND (LOWER(e.official_email) = $2 OR LOWER(e.personal_email) = $2))
       OR ($3 <> '' AND LOWER(e.employee_code) = LOWER($3)))
      AND COALESCE(e.is_deleted, false) = false
      AND ($4::int IS NULL OR e.organization_id = $4)
    LIMIT 1`, [Number.isInteger(id) ? id : null, email, code, Number.isInteger(organizationId) ? organizationId : null]);
  return result.rows[0] || null;
}

async function approvedLeave(question, user) {
  const range = dateRangeFromQuestion(question);
  const employee = await resolveEmployee(user);
  if (!employee?.organization_id) return { date: range.start, range, employees: [], employee, department: null };
  const departmentMatch = String(question).match(/\b(?:in|from)\s+([a-z][a-z &-]{2,40})/i);
  const department = /\bmy department\b/i.test(question)
    ? employee.department_name
    : departmentMatch?.[1]?.trim();
  const result = await query(`
    SELECT DISTINCT ON (e.id) e.id AS employee_id, e.employee_code, e.first_name, e.last_name,
           lr.from_date::text, lr.to_date::text, d.department_name
    FROM hcm.leave_requests lr
    JOIN hcm.employees e ON e.id = lr.employee_id
    LEFT JOIN hcm.departments d ON d.id = e.department_id
    WHERE LOWER(TRIM(lr.status)) = 'approved'
      AND COALESCE(lr.is_deleted, false) = false
      AND COALESCE(e.is_deleted, false) = false
      AND COALESCE(e.is_active, true) = true
      AND lr.organization_id = e.organization_id
      AND e.organization_id = $4
      AND lr.to_date >= $1::date
      AND lr.from_date <= $2::date
      AND ($3::text IS NULL OR LOWER(d.department_name) LIKE LOWER('%' || $3 || '%'))
    ORDER BY e.id, lr.from_date`, [range.start, range.end, department || null, employee.organization_id]);
  return { date: range.start, range, employees: result.rows, employee, department };
}

async function personalLeave(question, user) {
  const employee = await resolveEmployee(user);
  if (!employee) return { employee: null, balances: [], requests: [] };
  const balance = await query(`
    SELECT b.year, b.opening_balance, b.closing_balance, lt.name AS leave_type
    FROM hcm.employee_leave_balance b
    JOIN hcm.leave_types lt ON lt.id = b.leave_type_id
    WHERE b.employee_id = $1 AND b.organization_id = $2 AND COALESCE(b.is_deleted, false) = false
    ORDER BY b.year DESC, lt.name`, [employee.id, employee.organization_id]);
  const requests = await query(`
    SELECT lr.from_date::text, lr.to_date::text, lr.status, lt.name AS leave_type
    FROM hcm.leave_requests lr
    LEFT JOIN hcm.leave_types lt ON lt.id = lr.leave_type_id
    WHERE lr.employee_id = $1 AND lr.organization_id = $2 AND COALESCE(lr.is_deleted, false) = false
    ORDER BY lr.from_date DESC LIMIT 20`, [employee.id, employee.organization_id]);
  return { employee, balances: balance.rows, requests: requests.rows };
}

async function employeeOnLeave(question, user) {
  const range = dateRangeFromQuestion(question);
  const employee = await resolveEmployee(user);
  if (!employee?.organization_id) return { range, employee: null, records: [] };
  const match = String(question).match(/(?:is|whether)\s+(.+?)\s+(?:on\s+)?leave/i);
  const name = match?.[1]?.replace(/\b(today|tomorrow|yesterday)\b/ig, '').trim();
  if (!name) return { range, employee, records: [] };
  const result = await query(`
    SELECT DISTINCT e.id AS employee_id, e.first_name, e.last_name, lr.from_date::text, lr.to_date::text
    FROM hcm.leave_requests lr
    JOIN hcm.employees e ON e.id = lr.employee_id
    WHERE LOWER(TRIM(lr.status)) = 'approved'
      AND COALESCE(lr.is_deleted, false) = false
      AND COALESCE(e.is_deleted, false) = false
      AND COALESCE(e.is_active, true) = true
      AND lr.organization_id = $3
      AND e.organization_id = $3
      AND lr.to_date >= $1::date AND lr.from_date <= $2::date
      AND LOWER(CONCAT_WS(' ', e.first_name, e.last_name)) LIKE LOWER('%' || $4 || '%')
    ORDER BY e.first_name, e.last_name, lr.from_date`, [range.start, range.end, employee.organization_id, name]);
  return { range, employee, records: result.rows };
}

async function profile(question, user) {
  const employee = await resolveEmployee(user);
  if (!employee) return null;
  const managerResult = await query(`
    SELECT m.first_name, m.last_name, m.employee_code
    FROM hcm.employees m
    JOIN hcm.employees e ON e.reporting_manager_id = m.id
    WHERE e.id = $1 AND m.organization_id = $2 AND COALESCE(m.is_deleted, false) = false
    LIMIT 1`, [employee.id, employee.organization_id]);
  return { employee, manager: managerResult.rows[0] || null };
}

async function attendance(question, user) {
  const employee = await resolveEmployee(user);
  if (!employee) return { employee: null, records: [] };
  const range = /\b(today|todays)\b/i.test(question)
    ? dateRangeFromQuestion('today')
    : /\b(this month|monthly|month)\b/i.test(question)
      ? (() => {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { start: isoDate(start), end: isoDate(end) };
      })()
      : { start: '1900-01-01', end: '2999-12-31' };
  const result = await query(`
    SELECT attendance_date::text, check_in_time, check_out_time, total_hours, status, reconciliation_status
    FROM hcm.organization_daily_attendance
    WHERE employee_id = $1 AND organization_id = $2 AND COALESCE(is_deleted, false) = false
      AND attendance_date BETWEEN $3::date AND $4::date
    ORDER BY attendance_date DESC LIMIT 31`, [employee.id, employee.organization_id, range.start, range.end]);
  return { employee, records: result.rows, range };
}

async function buildKnowledgeContext(question, { policy = false } = {}) {
  const faqResult = await query('SELECT category, question, answer FROM hcm.faqs ORDER BY id ASC');
  const docResult = await query('SELECT file_name, extracted_text FROM hcm.chatbot_documents ORDER BY uploaded_at DESC');
  const contextParts = [];
  const sources = new Set();
  const appTopics = [
    ['dashboard', 'APPLICATION: The HROrbit home screen provides welcome, summary, announcements, events, mood, learning, recognition and quick-link widgets.'],
    ['announcement', 'APPLICATION: Announcements are available in HROrbit; employees can read, search, and mark posts read.'],
    ['event', 'APPLICATION: Upcoming events are available in HROrbit; employees can use list or month views and RSVP when an event provides a link.'],
    ['quick link', 'APPLICATION: Quick Links provide HR-managed internal or external resources in HROrbit.'],
    ['notification', 'APPLICATION: Notifications are available from the top-bar bell; selecting one marks it read, and the app supports mark-all-as-read.'],
    ['profile', 'APPLICATION: The employee profile is available from the HROrbit menu; employees can edit permitted display details and their cover photo.'],
    ['setting', 'APPLICATION: Account settings are available from the HROrbit menu.'],
    ['learning', 'APPLICATION: Learning Hub is available in HROrbit for courses and resources.'],
    ['community', 'APPLICATION: Employee Community is available in HROrbit.'],
    ['kudos', 'APPLICATION: Kudos and recognition are available in HROrbit.'],
    ['game', 'APPLICATION: Daily Games are available in HROrbit, with game play and leaderboard features.'],
    ['hr request', 'APPLICATION: Quick Connect is available in HROrbit for contacting HR; no separate HR request workflow is exposed by the inspected application.'],
    ['payroll', 'APPLICATION: No payroll route is exposed by the inspected HROrbit frontend routes. Ask HR for payslip or salary access rather than guessing.'],
  ];
  appTopics.forEach(([term, content]) => {
    if (String(question).toLowerCase().includes(term)) contextParts.push(content);
  });
  const faqTerms = terms(question);
  const documentItems = retrieveDocuments(question, docResult.rows, { policy });
  const hasLeavePolicyDocument = documentItems.some((item) => /simplify3x employee leave policy/i.test(item.file_name));
  faqResult.rows.forEach((faq) => {
    const faqText = `${faq.question} ${faq.answer}`;
    const score = [...terms(faqText)].filter((term) => faqTerms.has(term)).length;
    if (score >= 1 && !(policy && hasLeavePolicyDocument)) {
      contextParts.push(`FAQ (${faq.category || 'HR'}): ${faq.question}\n${faq.answer}`);
      sources.add(`FAQ: ${faq.category || 'HR'}`);
    }
  });
  documentItems.forEach((item) => {
    contextParts.push(`DOCUMENT: ${item.file_name}\n${item.chunk}`);
    sources.add(item.file_name);
  });
  return { context: contextParts.join('\n\n').slice(0, MAX_CONTEXT_CHARS), sources: [...sources] };
}

function applicationAnswer(question) {
  const text = String(question).toLowerCase();
  const answers = [
    [/how do i access company polic|where.*company polic|open company polic/, 'Open Company Policies in HROrbit to browse the verified company policy documents.'],
    [/apply for leave|leave application/, 'Open the Leave Management module, choose the leave application option, select the leave type, enter the dates and required information, then submit the request.'],
    [/notification/, 'Open the notification bell in the top bar. Select a notification to mark it read, or use the mark-all-as-read action.'],
    [/saved (learning )?resources|learning hub/, 'You can find saved learning resources in the Learning Hub. Open Learning Hub and select Saved Resources to view your bookmarked items.'],
    [/update my profile|edit my profile/, 'Open your Profile from the HROrbit menu and edit the personal details you are allowed to change. Save the update when finished.'],
    [/attendance|check.?in|check.?out/, 'Open the Attendance section in HROrbit to view your available daily and monthly attendance information.'],
    [/raise.*hr request|contact hr|hr contact/, 'Open Quick Connect from the HROrbit menu to find the available HR contacts. The application does not currently expose a separate HR request form.'],
    [/download.*payslip|payroll|salary/, 'For a payslip or salary question, open the payroll area if it is available in your organization. If you do not see it, contact HR because the inspected employee application does not provide a payroll screen.'],
    [/daily games|game|leaderboard/, 'Open Daily Games from the HROrbit menu to play available games and view the leaderboard.'],
    [/community|discussion/, 'Open Employee Community from the HROrbit menu to read and participate in discussions.'],
  ];
  return answers.find(([pattern]) => pattern.test(text))?.[1] || null;
}

async function answerQuestion({ question, user, conversation = [] }) {
  const text = question.trim();
  const identity = await resolveEmployee(user);
  if (isGreeting(text)) return { intent: 'greeting', answer: personalize('How can I help you today?', identity, { greeting: true }), sources: [] };
  if (isThanks(text)) return { intent: 'thanks', answer: personalize('You’re welcome. I’m here if you need help with HROrbit or HR information.', identity), sources: [] };

  if (isLeaveFollowUp(text, conversation)) {
    const data = await approvedLeave(text, user);
    const lines = data.employees.map((item) => `${item.first_name || ''} ${item.last_name || ''}`.trim() + ` — ${item.from_date} to ${item.to_date}`);
    const dateLabel = data.range.start === data.range.end ? data.range.start : `${data.range.start} through ${data.range.end}`;
    const countOnly = /\bhow many\b|\bcount\b/i.test(text);
    const answer = countOnly
      ? `${data.employees.length} employee${data.employees.length === 1 ? '' : 's'} on approved leave during ${dateLabel}.`
      : (lines.length ? `Employees on approved leave during ${dateLabel}:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : `No employees are on approved leave during ${dateLabel}.`);
    return { intent: 'live_leave', answer: personalize(answer, data.employee || identity), sources: [], dataType: 'live' };
  }

  if (isLiveLeaveQuestion(text) && /\b(?:is|whether)\s+.+\s+leave\b/i.test(text)) {
    const data = await employeeOnLeave(text, user);
    const name = data.records[0] ? `${data.records[0].first_name} ${data.records[0].last_name}` : 'That employee';
    const answer = data.records.length ? `${name} is on approved leave during ${data.range.start}${data.range.start === data.range.end ? '' : ` through ${data.range.end}`}.` : `No approved leave record was found for the employee matching your question during ${data.range.start}.`;
    return { intent: 'employee_leave_check', answer: personalize(answer, data.employee || identity), sources: [], dataType: 'live' };
  }

  if (isLiveLeaveQuestion(text)) {
    const data = await approvedLeave(text, user);
    const lines = data.employees.map((item) => `${item.first_name || ''} ${item.last_name || ''}`.trim() + ` — ${item.from_date} to ${item.to_date}`);
    const dateLabel = data.range.start === data.range.end ? data.range.start : `${data.range.start} through ${data.range.end}`;
    const countOnly = /\bhow many\b|\bcount\b/i.test(text);
    const answer = countOnly
      ? `${data.employees.length} employee${data.employees.length === 1 ? '' : 's'} on approved leave during ${dateLabel}.`
      : (lines.length ? `Employees on approved leave during ${dateLabel}:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : `No employees are on approved leave during ${dateLabel}.`);
    return { intent: 'live_leave', answer: personalize(answer, data.employee || identity), sources: [], dataType: 'live' };
  }

  if (isPersonalLeaveQuestion(text)) {
    const data = await personalLeave(text, user);
    if (!data.employee) return { intent: 'personal_leave', answer: 'I could not match your authenticated account to an employee record. Please contact HR.', sources: [], dataType: 'live' };
    const wantsRequests = /pending|approved|history|request/i.test(text);
    const requestedType = text.match(/\b(casual|sick|annual|earned|maternity|paternity|menstrual)\s+leave\b/i)?.[1];
    const balances = requestedType
      ? data.balances.filter((item) => item.leave_type?.toLowerCase().includes(requestedType.toLowerCase()))
      : data.balances;
    const answer = wantsRequests
      ? (data.requests.length
        ? data.requests.map((item) => `${item.leave_type || 'Leave'}: ${item.from_date} to ${item.to_date} — ${item.status}`).join('\n')
        : 'No leave requests are available for your employee account.')
      : (balances.length
        ? balances.map((item) => `${item.leave_type}: ${item.closing_balance} remaining (${item.year})`).join('\n')
        : 'No matching leave balance records are available for your employee account.');
    return { intent: 'personal_leave', answer: personalize(answer, data.employee), sources: [], dataType: 'live' };
  }

  if (isProfileQuestion(text)) {
    const data = await profile(text, user);
    if (!data) return { intent: 'profile', answer: 'I could not match your authenticated account to an employee record. Please contact HR.', sources: [], dataType: 'live' };
    const e = data.employee;
    const manager = data.manager ? `${data.manager.first_name} ${data.manager.last_name}` : 'No reporting manager is recorded';
    let answer = '';
    if (/manager/i.test(text)) answer = `Your reporting manager is ${manager}.`;
    else if (/department/i.test(text)) answer = `Your department is ${e.department_name || 'not recorded'}.`;
    else if (/designation/i.test(text)) answer = `Your designation is ${e.designation_name || 'not recorded'}.`;
    else if (/employee code|employee id/i.test(text)) answer = `Your employee code is ${e.employee_code || 'not recorded'}.`;
    else if (/join|joined/i.test(text)) answer = `Your joining date is ${e.join_date || 'not recorded'}.`;
    else answer = 'You can review your personal details from the Profile section in HROrbit.';
    return { intent: 'profile', answer: personalize(answer, data.employee), sources: [], dataType: 'live' };
  }

  if (isAttendanceQuestion(text)) {
    const data = await attendance(text, user);
    if (!data.employee) return { intent: 'attendance', answer: 'I could not match your authenticated account to an employee record. Please contact HR.', sources: [], dataType: 'live' };
    const countMatch = text.match(/how many.*\b(days|times)\b/i);
    const presentCount = data.records.filter((item) => /present|working|worked|on time/i.test(item.status || '')).length;
    const absentCount = data.records.filter((item) => /absent|absence/i.test(item.status || '')).length;
    const answer = countMatch && /absent/i.test(text)
      ? `${absentCount} absent attendance record${absentCount === 1 ? '' : 's'} found for the requested period.`
      : countMatch && /present/i.test(text)
        ? `${presentCount} present attendance record${presentCount === 1 ? '' : 's'} found for the requested period.`
        : countMatch
          ? `${data.records.length} attendance record${data.records.length === 1 ? '' : 's'} found for the requested period.`
      : (data.records.length
        ? data.records.slice(0, 10).map((item) => `${item.attendance_date}: ${item.status || 'recorded'}${item.total_hours == null ? '' : `, ${item.total_hours} hours`}`).join('\n')
        : 'No attendance records are available for your employee account.');
    return { intent: 'attendance', answer: personalize(answer, data.employee), sources: [], dataType: 'live' };
  }

  const leavePolicyQuestion = isLeavePolicyQuestion(text);
  if (leavePolicyQuestion) {
    const knowledge = await buildKnowledgeContext(text, { policy: true });
    if (!knowledge.context) {
      const answer = 'I could not find verified leave-policy content. Please contact HR so I do not guess.';
      return { intent: 'leave_policy', answer: personalize(answer, identity), sources: [], dataType: 'grounded' };
    }
    try {
      const answer = await generateGroundedAnswer({ question: text, context: knowledge.context, conversation, firstName: employeeFirstName(identity) });
      return { intent: 'leave_policy', answer, sources: knowledge.sources, dataType: 'grounded' };
    } catch (error) {
      if (isOpenAiAvailabilityError(error)) {
        const answer = 'The AI service is temporarily unavailable. You can still contact HR for the verified leave policy.';
        return { intent: 'service_unavailable', answer: personalize(answer, identity), sources: [], dataType: 'grounded' };
      }
      throw error;
    }
  }

  const appAnswer = applicationAnswer(text);
  if (appAnswer) return { intent: 'application_guidance', answer: personalize(appAnswer, identity), sources: [], dataType: 'application' };

  const knowledge = await buildKnowledgeContext(text);
  if (!knowledge.context) {
    const answer = 'I could not find verified HROrbit or approved HR knowledge for that question. Please contact HR so I do not guess.';
    return { intent: isPayrollGuidanceQuestion(text) ? 'payroll_guidance' : 'unsupported', answer: personalize(answer, identity), sources: [], dataType: 'grounded' };
  }
  try {
    const answer = await generateGroundedAnswer({ question: text, context: knowledge.context, conversation, firstName: employeeFirstName(identity) });
    return { intent: 'grounded_knowledge', answer, sources: knowledge.sources, dataType: 'grounded' };
  } catch (error) {
    if (isOpenAiAvailabilityError(error)) {
      const answer = 'The AI service is temporarily unavailable. You can still use the HROrbit screens and contact HR for assistance.';
      return { intent: 'service_unavailable', answer: personalize(answer, identity), sources: [], dataType: 'grounded' };
    }
    throw error;
  }
}

module.exports = { answerQuestion, approvedLeave, resolveEmployee, dateFromQuestion, dateRangeFromQuestion, applicationAnswer, employeeOnLeave, profile, isLeavePolicyQuestion, retrieveDocuments, buildKnowledgeContext };
