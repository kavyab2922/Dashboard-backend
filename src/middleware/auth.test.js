const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-secret';
const { requireAdmin, requireAdminUnlessReadOnly } = require('./auth');

function run(middleware, user, body = {}) {
  let result = 'next';
  const res = { status(code) { this.code = code; return this; }, json(payload) { result = `${this.code} ${payload.message}`; } };
  middleware({ user, body }, res, () => {});
  return result;
}

const admin = { access_role: 'HR Admin' };
const employee = { access_role: 'Employee', role: 'Employee' };

test('HR admins can create, edit and delete content', () => {
  assert.equal(run(requireAdmin, admin), 'next');
  assert.equal(run(requireAdmin, { role: 'admin' }), 'next');
  // A session issued before the email was added to HR_ADMIN_EMAILS still says Employee.
  assert.equal(run(requireAdmin, { access_role: 'Employee', email: 'Srinagaraj.P@simplify3x.com' }), 'next');
});

test('employees are refused with 403', () => {
  assert.equal(run(requireAdmin, employee), '403 Only HR admins can make this change.');
  assert.equal(run(requireAdmin, undefined), '403 Only HR admins can make this change.');
});

test('employees may only mark announcements read or unread', () => {
  assert.equal(run(requireAdminUnlessReadOnly, employee, { read: true }), 'next');
  assert.equal(run(requireAdminUnlessReadOnly, employee, { read: true, title: 'Hacked' }), '403 Only HR admins can make this change.');
  assert.equal(run(requireAdminUnlessReadOnly, employee, {}), '403 Only HR admins can make this change.');
  assert.equal(run(requireAdminUnlessReadOnly, admin, { title: 'Edited' }), 'next');
});
