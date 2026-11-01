// A stable integer id for the signed-in user. Employees use their hcm.employees id;
// accounts without an employee row (session id like "keycloak:<email>") get a
// fixed hash of their identity, so per-user state such as read flags and game
// progress still works for them.
function viewerId(user) {
  const raw = Number(user?.id);
  if (Number.isInteger(raw) && raw > 0) return raw;
  const identity = String(user?.email || user?.official_email || user?.employee_code || user?.id || 'employee');
  let hash = 0;
  for (const char of identity) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 2147483647) || 1; // stays within a Postgres INTEGER
}

// The real hcm.employees id, or null when the account has no employee record.
function employeeRecordId(user) {
  const raw = Number(user?.id);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

module.exports = { viewerId, employeeRecordId };
