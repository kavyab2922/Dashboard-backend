const { query } = require('../config/db');

const MOODS = new Set(['amazing', 'happy', 'calm', 'okay', 'sad', 'stressed']);
const VISIBILITIES = new Set(['private', 'colleagues', 'selected']);
const REACTIONS = new Set(['🎉', '👏', '❤️', '✨', '🥳']);
const SUPPORT_MESSAGES = new Set([
  "You've got this! One step at a time 💛",
  'Just a reminder that you\'re valued and appreciated 🌻',
  "I'm here if you need someone to talk to 🤝",
  'Want to take a quick break or grab a coffee? ☕',
  "It's okay to have difficult days. Be kind to yourself 🌈",
]);

function employeeId(req) {
  const id = Number(req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}

function publicEmployee(row, includeIdentity = true) {
  if (!includeIdentity) return { id: String(row.employee_id), name: 'A colleague', initials: '?' };
  const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A colleague';
  return {
    id: String(row.employee_id),
    name,
    initials: name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
    avatar: row.profile_picture_url || null,
    role: row.designation_name || null,
    team: row.department_name || null,
  };
}

async function moodVisibleTo(employee, moodId) {
  const result = await query(`
    SELECT 1 FROM hcm.mood_checkins m
    WHERE m.id = $1 AND (
      m.employee_id = $2 OR m.visibility = 'colleagues' OR
      (m.visibility = 'selected' AND EXISTS (
        SELECT 1 FROM hcm.mood_checkin_recipients r
        WHERE r.mood_checkin_id = m.id AND r.employee_id = $2
      ))
    )
  `, [moodId, employee]);
  return result.rowCount > 0;
}

function moodResponse(row, reactions = []) {
  const identityAllowed = row.identity_allowed !== false;
  return {
    id: String(row.id),
    mood: row.mood,
    visibility: row.visibility,
    sharedAt: row.created_at,
    employee: publicEmployee(row, identityAllowed),
    isPositive: ['amazing', 'happy'].includes(row.mood),
    isSupport: ['sad', 'stressed'].includes(row.mood),
    reactions,
  };
}

exports.getMoodState = async (req, res, next) => {
  try {
    const id = employeeId(req);
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    const own = await query(`
      SELECT m.id, m.mood, m.visibility, m.created_at
      FROM hcm.mood_checkins m
      WHERE m.employee_id = $1 AND m.checkin_date = CURRENT_DATE
      LIMIT 1
    `, [id]);
    const recipients = own.rows[0]?.visibility === 'selected'
      ? await query('SELECT employee_id FROM hcm.mood_checkin_recipients WHERE mood_checkin_id = $1', [own.rows[0].id])
      : { rows: [] };
    res.json({ success: true, data: { mood: own.rows[0] || null, selectedEmployeeIds: recipients.rows.map((row) => String(row.employee_id)) } });
  } catch (err) { next(err); }
};

exports.saveMood = async (req, res, next) => {
  const client = await require('../config/db').pool.connect();
  try {
    const id = employeeId(req);
    const mood = String(req.body?.mood || '').toLowerCase();
    const visibility = String(req.body?.visibility || 'private').toLowerCase();
    const selectedIds = Array.isArray(req.body?.selectedEmployeeIds) ? [...new Set(req.body.selectedEmployeeIds.map(Number).filter((value) => Number.isInteger(value) && value > 0))] : [];
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    if (!MOODS.has(mood) || !VISIBILITIES.has(visibility)) return res.status(400).json({ success: false, message: 'Invalid mood or sharing preference.' });
    if (visibility === 'selected' && selectedIds.length === 0) return res.status(400).json({ success: false, message: 'Choose at least one colleague or keep this mood private.' });
    if (selectedIds.includes(id)) return res.status(400).json({ success: false, message: 'You cannot select yourself as a recipient.' });
    await client.query('BEGIN');
    const saved = await client.query(`
      INSERT INTO hcm.mood_checkins (employee_id, mood, visibility, checkin_date)
      VALUES ($1, $2, $3, CURRENT_DATE)
      ON CONFLICT (employee_id, checkin_date) DO UPDATE SET mood = EXCLUDED.mood, visibility = EXCLUDED.visibility, updated_at = CURRENT_TIMESTAMP
      RETURNING id, mood, visibility, created_at
    `, [id, mood, visibility]);
    await client.query('DELETE FROM hcm.mood_checkin_recipients WHERE mood_checkin_id = $1', [saved.rows[0].id]);
    if (visibility === 'selected') {
      const valid = await client.query(`SELECT id FROM hcm.employees WHERE id = ANY($1::int[]) AND is_active = true AND is_deleted = false`, [selectedIds]);
      if (valid.rowCount !== selectedIds.length) throw Object.assign(new Error('One or more selected colleagues are unavailable.'), { statusCode: 400 });
      for (const recipientId of selectedIds) await client.query('INSERT INTO hcm.mood_checkin_recipients (mood_checkin_id, employee_id) VALUES ($1, $2)', [saved.rows[0].id, recipientId]);
    }
    await client.query('COMMIT');
    res.json({ success: true, data: { mood: saved.rows[0], selectedEmployeeIds: selectedIds.map(String) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
};

exports.getTeamMoods = async (req, res, next) => {
  try {
    const id = employeeId(req);
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    const moods = await query(`
      SELECT m.id, m.employee_id, m.mood, m.visibility, m.created_at, true AS identity_allowed,
             e.first_name, e.last_name, e.profile_picture_url, d.department_name, des.designation_name
      FROM hcm.mood_checkins m
      JOIN hcm.employees e ON e.id = m.employee_id
      LEFT JOIN hcm.departments d ON e.department_id = d.id
      LEFT JOIN hcm.designations des ON e.designation_id = des.id
      WHERE e.is_active = true AND e.is_deleted = false AND m.visibility <> 'private'
        AND (m.employee_id = $1 OR m.visibility = 'colleagues' OR EXISTS (
          SELECT 1 FROM hcm.mood_checkin_recipients r WHERE r.mood_checkin_id = m.id AND r.employee_id = $1
        ))
        AND m.checkin_date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY m.created_at DESC LIMIT 100
    `, [id]);
    const reactions = await query(`SELECT mood_checkin_id, reaction, COUNT(*)::int AS count FROM hcm.mood_reactions GROUP BY mood_checkin_id, reaction`);
    const grouped = reactions.rows.reduce((all, row) => ({ ...all, [row.mood_checkin_id]: [...(all[row.mood_checkin_id] || []), { reaction: row.reaction, count: row.count }] }), {});
    res.json({ success: true, data: moods.rows.map((row) => moodResponse(row, row.identity_allowed)).map((item) => ({ ...item, reactions: grouped[item.id] || [] })) });
  } catch (err) { next(err); }
};

exports.addReaction = async (req, res, next) => {
  try {
    const sender = employeeId(req); const moodId = Number(req.params.id); const reaction = String(req.body?.reaction || '');
    if (!sender || !REACTIONS.has(reaction) || !(await moodVisibleTo(sender, moodId))) return res.status(400).json({ success: false, message: 'That reaction is not available.' });
    const owner = await query('SELECT employee_id FROM hcm.mood_checkins WHERE id = $1', [moodId]);
    if (!owner.rows[0] || owner.rows[0].employee_id === sender) return res.status(400).json({ success: false, message: 'You cannot react to your own mood.' });
    const inserted = await query('INSERT INTO hcm.mood_reactions (mood_checkin_id, employee_id, reaction) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [moodId, sender, reaction]);
    if (inserted.rowCount) {
      await query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) VALUES ($1, 'A colleague reacted to your mood', $2, 'mood-reaction', 'Just now')`, [owner.rows[0].employee_id, `${reaction} Someone sent a reaction to your shared mood.`]);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.sendMessage = async (req, res, next) => {
  try {
    const sender = employeeId(req); const moodId = Number(req.params.id); const kind = req.body?.kind === 'support' ? 'support' : 'celebration';
    const message = cleanText(req.body?.message);
    if (!sender || !message || message.length > 500 || !(await moodVisibleTo(sender, moodId))) return res.status(400).json({ success: false, message: 'Enter a valid message for a shared mood.' });
    const owner = await query('SELECT employee_id, mood FROM hcm.mood_checkins WHERE id = $1', [moodId]);
    if (!owner.rows[0] || (kind === 'support' && !['sad', 'stressed'].includes(owner.rows[0].mood)) || (kind === 'celebration' && !['amazing', 'happy'].includes(owner.rows[0].mood))) return res.status(400).json({ success: false, message: 'That message type is not available for this mood.' });
    if (kind === 'support' && !SUPPORT_MESSAGES.has(message) && !req.body?.custom) return res.status(400).json({ success: false, message: 'Choose a supportive message or write your own.' });
    if (!owner.rows[0] || owner.rows[0].employee_id === sender) return res.status(400).json({ success: false, message: 'You cannot message your own mood.' });
    await query('INSERT INTO hcm.mood_messages (mood_checkin_id, sender_id, recipient_id, kind, message, offer_to_chat) VALUES ($1, $2, $3, $4, $5, $6)', [moodId, sender, owner.rows[0].employee_id, kind, message, Boolean(req.body?.offerToChat)]);
    await query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) VALUES ($1, $2, $3, $4, 'Just now')`, [owner.rows[0].employee_id, kind === 'support' ? 'Someone sent you some sunshine' : 'Someone is celebrating with you', kind === 'support' ? 'A private supportive message is waiting for you.' : 'A colleague sent a celebration message.', `mood-${kind}`]);
    res.status(201).json({ success: true });
  } catch (err) { next(err); }
};

exports.getMessages = async (req, res, next) => {
  try {
    const id = employeeId(req);
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    const messages = await query(`
      SELECT m.id, m.kind, m.message, m.offer_to_chat, m.chat_status, m.created_at,
             sender.first_name AS sender_first_name, sender.last_name AS sender_last_name,
             recipient.first_name AS recipient_first_name, recipient.last_name AS recipient_last_name
      FROM hcm.mood_messages m
      JOIN hcm.employees sender ON sender.id = m.sender_id
      JOIN hcm.employees recipient ON recipient.id = m.recipient_id
      WHERE m.recipient_id = $1 OR m.sender_id = $1
      ORDER BY m.created_at DESC LIMIT 100
    `, [id]);
    res.json({ success: true, data: messages.rows.map((row) => ({
      id: String(row.id), kind: row.kind, message: row.message,
      offerToChat: row.offer_to_chat, chatStatus: row.chat_status, createdAt: row.created_at,
      sender: `${row.sender_first_name || ''} ${row.sender_last_name || ''}`.trim(),
      recipient: `${row.recipient_first_name || ''} ${row.recipient_last_name || ''}`.trim(),
    })) });
  } catch (err) { next(err); }
};

exports.respondToChatOffer = async (req, res, next) => {
  try {
    const recipient = employeeId(req); const status = String(req.body?.status || '');
    if (!recipient || !['accepted', 'declined'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid chat response.' });
    const result = await query('UPDATE hcm.mood_messages SET chat_status = $1 WHERE id = $2 AND recipient_id = $3 RETURNING sender_id', [status, req.params.id, recipient]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Message not found.' });
    await query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) VALUES ($1, 'Chat offer updated', $2, 'mood-chat', 'Just now')`, [result.rows[0].sender_id, `Your offer to chat was ${status}.`]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
