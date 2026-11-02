const { query } = require('../config/db');

const MOODS = new Set(['amazing', 'happy', 'calm', 'okay', 'sad', 'stressed']);
const VISIBILITIES = new Set(['private', 'colleagues', 'selected']);
const REACTIONS = new Set(['🎉', '👏', '❤️', '✨', '🥳']);
const MOOD_TIMEZONE = process.env.MOOD_TIMEZONE || process.env.APP_TIMEZONE || 'Asia/Kolkata';

const SUPPORT_MESSAGES = new Set([
  "You've got this! One step at a time 💛",
  'Just a reminder that you\'re valued and appreciated 🌻',
  "I'm here if you need someone to talk to 🤝",
  'Want to take a quick break or grab a coffee? ☕',
  "It's okay to have difficult days. Be kind to yourself 🌈",
]);

async function employeeId(req) {
  const id = Number(req.user?.id);
  if (Number.isInteger(id) && id > 0) return id;

  const identities = [
    req.user?.employee_code,
    req.user?.employeeCode,
    req.user?.employee_id,
    req.user?.employeeId,
    req.user?.email,
    req.user?.official_email,
    req.user?.personal_email,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (identities.length === 0) return null;

  const result = await query(`
    SELECT id
    FROM hcm.employees
    WHERE LOWER(employee_code) = ANY($1::text[])
       OR LOWER(official_email) = ANY($1::text[])
       OR LOWER(personal_email) = ANY($1::text[])
    LIMIT 1
  `, [identities]);
  return result.rows[0]?.id || null;
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
  if (!Number.isInteger(Number(employee)) || !Number.isInteger(Number(moodId))) return false;
  const result = await query(`
    SELECT 1
    FROM hcm.mood_checkins m
    WHERE m.id = $1
      AND (
        m.employee_id = $2
        OR m.visibility = 'colleagues'
        OR (
          m.visibility = 'selected'
          AND EXISTS (
            SELECT 1
            FROM hcm.mood_checkin_recipients r
            WHERE r.mood_checkin_id = m.id
              AND r.employee_id = $2
          )
        )
      )
  `, [Number(moodId), Number(employee)]);
  return result.rowCount > 0;
}

async function moodOwner(moodId) {
  const result = await query(`
    SELECT id, employee_id, mood, visibility
    FROM hcm.mood_checkins
    WHERE id = $1
  `, [moodId]);
  return result.rows[0] || null;
}

function interactionNotificationDetail(actorName, action, moodId, message = '') {
  const suffix = message ? `: "${message}"` : '';
  return `${actorName} ${action} your Colleagues' Moments update (moment ${moodId})${suffix}`;
}

async function employeeName(employee) {
  const result = await query(`
    SELECT TRIM(CONCAT(first_name, ' ', last_name)) AS name
    FROM hcm.employees
    WHERE id = $1
  `, [employee]);
  return result.rows[0]?.name || 'A colleague';
}

function parseMoodId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function reactionSummary(rows) {
  const grouped = {};
  for (const row of rows) {
    const moodId = String(row.mood_checkin_id);
    grouped[moodId] ||= [];
    grouped[moodId].push({ reaction: row.reaction, count: Number(row.count), likedByViewer: Boolean(row.liked_by_viewer) });
  }
  return grouped;
}

function moodResponse(row, reactions = []) {
  const identityAllowed = row.identity_allowed !== false;
  return {
    id: String(row.id),
    mood: row.mood,
    visibility: row.visibility,
    sharedAt: row.submitted_at || row.created_at,
    employee: publicEmployee(row, identityAllowed),
    isPositive: ['amazing', 'happy'].includes(row.mood),
    isSupport: ['sad', 'stressed'].includes(row.mood),
    reactions,
  };
}

function calendarMetadata(row) {
  if (!row?.submitted_at) return { locked: false, submittedAt: null, checkinDate: null, lockedUntil: null, nextEligibleAt: null };
  const locked = row.checkin_date === row.current_local_date;
  const submittedAt = new Date(row.submitted_at);
  const nextEligibleAt = row.next_eligible_at ? new Date(row.next_eligible_at) : null;
  return {
    locked,
    submittedAt: submittedAt.toISOString(),
    checkinDate: row.checkin_date,
    lockedUntil: nextEligibleAt?.toISOString() || null,
    nextEligibleAt: nextEligibleAt?.toISOString() || null,
  };
}

function moodState(row, selectedEmployeeIds = []) {
  return { mood: row || null, selectedEmployeeIds, ...calendarMetadata(row) };
}

exports.getMoodState = async (req, res, next) => {
  try {
    const id = await employeeId(req);
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    const own = await query(`
      SELECT m.id, m.mood, m.visibility, m.submitted_at, m.checkin_date,
             ((CURRENT_TIMESTAMP AT TIME ZONE $2)::date) AS current_local_date,
             (((m.checkin_date + 1)::date) AT TIME ZONE $2) AS next_eligible_at
      FROM hcm.mood_checkins m
      WHERE m.employee_id = $1
      ORDER BY m.checkin_date DESC, m.submitted_at DESC NULLS LAST, m.id DESC
      LIMIT 1
    `, [id, MOOD_TIMEZONE]);
    const row = own.rows[0] || null;
    const recipients = row?.visibility === 'selected'
      ? await query('SELECT employee_id FROM hcm.mood_checkin_recipients WHERE mood_checkin_id = $1', [row.id])
      : { rows: [] };
    res.json({ success: true, data: moodState(row, recipients.rows.map((item) => String(item.employee_id))) });
  } catch (err) { next(err); }
};

exports.saveMood = async (req, res, next) => {
  const client = await require('../config/db').pool.connect();
  try {
    const id = await employeeId(req);
    const mood = String(req.body?.mood || '').toLowerCase();
    const visibility = String(req.body?.visibility || 'private').toLowerCase();
    const selectedIds = Array.isArray(req.body?.selectedEmployeeIds) ? [...new Set(req.body.selectedEmployeeIds.map(Number).filter((value) => Number.isInteger(value) && value > 0))] : [];
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    if (!MOODS.has(mood) || !VISIBILITIES.has(visibility)) return res.status(400).json({ success: false, message: 'Invalid mood or sharing preference.' });
    if (visibility === 'selected' && selectedIds.length === 0) return res.status(400).json({ success: false, message: 'Choose at least one colleague or keep this mood private.' });
    if (selectedIds.includes(id)) return res.status(400).json({ success: false, message: 'You cannot select yourself as a recipient.' });
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mood-checkin:${id}`]);
    const current = await client.query(`
      SELECT id, mood, visibility, submitted_at, checkin_date,
             ((CURRENT_TIMESTAMP AT TIME ZONE $2)::date) AS current_local_date,
             (((checkin_date + 1)::date) AT TIME ZONE $2) AS next_eligible_at
      FROM hcm.mood_checkins
      WHERE employee_id = $1
      ORDER BY checkin_date DESC, submitted_at DESC NULLS LAST, id DESC
      LIMIT 1 FOR UPDATE
    `, [id, MOOD_TIMEZONE]);
    const currentRow = current.rows[0];
    const currentLock = calendarMetadata(currentRow);
    if (currentLock.locked) {
      const currentRecipients = currentRow.visibility === 'selected'
        ? await client.query('SELECT employee_id FROM hcm.mood_checkin_recipients WHERE mood_checkin_id = $1', [currentRow.id])
        : { rows: [] };
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `You have already checked in today. You can check in again after the next calendar day begins.`,
        data: moodState(currentRow, currentRecipients.rows.map((item) => String(item.employee_id))),
      });
    }
    if (visibility === 'selected') {
      const valid = await client.query(`SELECT id FROM hcm.employees WHERE id = ANY($1::int[]) AND is_active = true AND is_deleted = false`, [selectedIds]);
      if (valid.rowCount !== selectedIds.length) throw Object.assign(new Error('One or more selected colleagues are unavailable.'), { statusCode: 400 });
    }
    const saved = await client.query(`
      INSERT INTO hcm.mood_checkins (employee_id, mood, visibility, checkin_date, submitted_at, locked_until, updated_at)
      VALUES ($1, $2, $3, (CURRENT_TIMESTAMP AT TIME ZONE $4)::date, CURRENT_TIMESTAMP, (((CURRENT_TIMESTAMP AT TIME ZONE $4)::date + 1) AT TIME ZONE $4), CURRENT_TIMESTAMP)
      ON CONFLICT (employee_id, checkin_date) DO UPDATE SET mood = EXCLUDED.mood, visibility = EXCLUDED.visibility, submitted_at = EXCLUDED.submitted_at, locked_until = EXCLUDED.locked_until, updated_at = EXCLUDED.updated_at
      RETURNING id, mood, visibility, submitted_at, checkin_date,
                ((CURRENT_TIMESTAMP AT TIME ZONE $4)::date) AS current_local_date,
                (((checkin_date + 1)::date) AT TIME ZONE $4) AS next_eligible_at,
                (((checkin_date + 1)::date) AT TIME ZONE $4) AS locked_until
    `, [id, mood, visibility, MOOD_TIMEZONE]);
    const savedRow = saved.rows[0];
    savedRow.current_local_date = savedRow.checkin_date;
    await client.query('DELETE FROM hcm.mood_checkin_recipients WHERE mood_checkin_id = $1', [savedRow.id]);
    if (visibility === 'selected') {
      for (const recipientId of selectedIds) await client.query('INSERT INTO hcm.mood_checkin_recipients (mood_checkin_id, employee_id) VALUES ($1, $2)', [savedRow.id, recipientId]);
    }
    await client.query('INSERT INTO hcm.mood_checkin_history (mood_checkin_id, employee_id, mood, visibility, selected_employee_ids, submitted_at, locked_until) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)', [savedRow.id, id, mood, visibility, JSON.stringify(selectedIds), savedRow.submitted_at, savedRow.locked_until]);
    await client.query('COMMIT');
    res.json({ success: true, data: moodState(savedRow, selectedIds.map(String)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
};

exports.getTeamMoods = async (req, res, next) => {
  try {
    const id = await employeeId(req);
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
        AND m.submitted_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
      ORDER BY m.submitted_at DESC LIMIT 100
    `, [id]);
    const reactions = await query(`
      SELECT mood_checkin_id, reaction, COUNT(*)::int AS count,
             BOOL_OR(employee_id = $1) AS liked_by_viewer
      FROM hcm.mood_reactions
      WHERE mood_checkin_id IN (SELECT id FROM hcm.mood_checkins WHERE employee_id = $1 OR visibility = 'colleagues' OR EXISTS (SELECT 1 FROM hcm.mood_checkin_recipients r WHERE r.mood_checkin_id = hcm.mood_checkins.id AND r.employee_id = $1))
      GROUP BY mood_checkin_id, reaction
    `, [id]);
    const grouped = reactionSummary(reactions.rows);
    const likes = await query(`
      SELECT mood_checkin_id, COUNT(*)::int AS like_count,
             BOOL_OR(employee_id = $1) AS liked_by_viewer
      FROM hcm.mood_reactions
      WHERE reaction = '❤️'
      GROUP BY mood_checkin_id
    `, [id]);
    const likeMap = Object.fromEntries(likes.rows.map((row) => [String(row.mood_checkin_id), row]));
    res.json({ success: true, data: moods.rows.map((row) => {
      const item = moodResponse(row, row.identity_allowed);
      const like = likeMap[item.id] || { like_count: 0, liked_by_viewer: false };
      return { ...item, reactions: grouped[item.id] || [], likeCount: Number(like.like_count), likedByViewer: Boolean(like.liked_by_viewer) };
    }) });
  } catch (err) { next(err); }
};

exports.addReaction = async (req, res, next) => {
  try {
    const sender = await employeeId(req);
    const moodId = parseMoodId(req.params.id);
    const reaction = String(req.body?.reaction || '');
    if (!sender || !moodId || !REACTIONS.has(reaction) || !(await moodVisibleTo(sender, moodId))) return res.status(400).json({ success: false, message: 'That reaction is not available.' });
    const owner = await moodOwner(moodId);
    if (!owner || owner.employee_id === sender) return res.status(400).json({ success: false, message: 'You cannot react to your own mood.' });
    const inserted = await query('INSERT INTO hcm.mood_reactions (mood_checkin_id, employee_id, reaction) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id', [moodId, sender, reaction]);
    if (inserted.rowCount && reaction !== '❤️') {
      const actor = await employeeName(sender);
      await query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) VALUES ($1, $2, $3, 'mood-reaction', 'Just now')`, [owner.employee_id, `${actor} reacted to your mood`, interactionNotificationDetail(actor, 'reacted to', moodId)]);
    }
    res.json({ success: true, data: { added: Boolean(inserted.rowCount) } });
  } catch (err) { next(err); }
};

exports.toggleLike = async (req, res, next) => {
  const client = await require('../config/db').pool.connect();
  try {
    const sender = await employeeId(req);
    const moodId = parseMoodId(req.params.id);
    if (!sender || !moodId || !(await moodVisibleTo(sender, moodId))) return res.status(400).json({ success: false, message: 'That moment is not available.' });
    const owner = await moodOwner(moodId);
    if (!owner || owner.employee_id === sender) return res.status(400).json({ success: false, message: 'You cannot like your own moment.' });
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM hcm.mood_reactions WHERE mood_checkin_id = $1 AND employee_id = $2 AND reaction = \'❤️\' FOR UPDATE', [moodId, sender]);
    let liked;
    if (existing.rowCount) {
      await client.query('DELETE FROM hcm.mood_reactions WHERE mood_checkin_id = $1 AND employee_id = $2 AND reaction = \'❤️\'', [moodId, sender]);
      liked = false;
    } else {
      const inserted = await client.query('INSERT INTO hcm.mood_reactions (mood_checkin_id, employee_id, reaction) VALUES ($1, $2, \'❤️\') ON CONFLICT DO NOTHING RETURNING id', [moodId, sender]);
      liked = Boolean(inserted.rowCount);
      if (inserted.rowCount) {
        const actor = await employeeName(sender);
        await client.query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) SELECT $1, $2, $3, 'mood-like', 'Just now' WHERE NOT EXISTS (SELECT 1 FROM hcm.notifications WHERE employee_id = $1 AND type = 'mood-like' AND detail = $3)`, [owner.employee_id, `${actor} liked your moment`, interactionNotificationDetail(actor, 'liked', moodId)]);
      }
    }
    const count = await client.query('SELECT COUNT(*)::int AS count FROM hcm.mood_reactions WHERE mood_checkin_id = $1 AND reaction = \'❤️\'', [moodId]);
    await client.query('COMMIT');
    res.json({ success: true, data: { liked, likeCount: count.rows[0].count } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
};

exports.sendMessage = async (req, res, next) => {
  const client = await require('../config/db').pool.connect();
  try {
    const sender = await employeeId(req); const moodId = parseMoodId(req.params.id); const owner = moodId ? await moodOwner(moodId) : null;
    const kind = req.body?.kind === 'support' ? 'support' : 'celebration';
    const message = cleanText(req.body?.message);
    if (!sender || !moodId || !message || !(await moodVisibleTo(sender, moodId))) return res.status(400).json({ success: false, message: 'Enter a valid message for a shared mood.' });
    if (!owner || (kind === 'support' && !['sad', 'stressed'].includes(owner.mood)) || (kind === 'celebration' && !['amazing', 'happy'].includes(owner.mood))) return res.status(400).json({ success: false, message: 'That message type is not available for this mood.' });
    if (kind === 'support' && !SUPPORT_MESSAGES.has(message) && !req.body?.custom) return res.status(400).json({ success: false, message: 'Choose a supportive message or write your own.' });
    if (owner.employee_id === sender) return res.status(400).json({ success: false, message: 'You cannot message your own mood.' });
    const actor = await employeeName(sender);
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO hcm.mood_messages (mood_checkin_id, sender_id, recipient_id, kind, message, offer_to_chat) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at', [moodId, sender, owner.employee_id, kind, message, Boolean(req.body?.offerToChat)]);
    await client.query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) VALUES ($1, $2, $3, $4, 'Just now')`, [owner.employee_id, `${actor} commented on your moment`, interactionNotificationDetail(actor, 'commented on', moodId, message), 'mood-comment']);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { id: String(inserted.rows[0].id), createdAt: inserted.rows[0].created_at } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
};

exports.getMessages = async (req, res, next) => {
  try {
    const id = await employeeId(req);
    if (!id) return res.status(403).json({ success: false, message: 'A local employee identity is required.' });
    const messages = await query(`
      SELECT m.id, m.mood_checkin_id, m.kind, m.message, m.offer_to_chat, m.chat_status, m.created_at,
             sender.id AS sender_id, sender.first_name AS sender_first_name, sender.last_name AS sender_last_name, sender.profile_picture_url AS sender_avatar,
             recipient.first_name AS recipient_first_name, recipient.last_name AS recipient_last_name
      FROM hcm.mood_messages m
      JOIN hcm.employees sender ON sender.id = m.sender_id
      JOIN hcm.employees recipient ON recipient.id = m.recipient_id
      WHERE m.recipient_id = $1 OR m.sender_id = $1
      ORDER BY m.created_at DESC LIMIT 100
    `, [id]);
    res.json({ success: true, data: messages.rows.map((row) => ({
      id: String(row.id), moodId: String(row.mood_checkin_id), kind: row.kind, message: row.message,
      offerToChat: row.offer_to_chat, chatStatus: row.chat_status, createdAt: row.created_at,
      sender: { id: String(row.sender_id), name: `${row.sender_first_name || ''} ${row.sender_last_name || ''}`.trim(), avatar: row.sender_avatar || null },
      recipient: `${row.recipient_first_name || ''} ${row.recipient_last_name || ''}`.trim(),
    })) });
  } catch (err) { next(err); }
};

exports.respondToChatOffer = async (req, res, next) => {
  try {
    const recipient = await employeeId(req); const status = String(req.body?.status || '');
    if (!recipient || !['accepted', 'declined'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid chat response.' });
    const result = await query('UPDATE hcm.mood_messages SET chat_status = $1 WHERE id = $2 AND recipient_id = $3 RETURNING sender_id', [status, req.params.id, recipient]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Message not found.' });
    await query(`INSERT INTO hcm.notifications (employee_id, title, detail, type, time) VALUES ($1, 'Chat offer updated', $2, 'mood-chat', 'Just now')`, [result.rows[0].sender_id, `Your offer to chat was ${status}.`]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
