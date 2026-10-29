const test = require('node:test');
const assert = require('node:assert/strict');
const schemas = require('./schemas');

const check = (schema, value) => schema.validate(value, { abortEarly: false, stripUnknown: true });
const fieldsWithErrors = (result) => (result.error ? result.error.details.map((detail) => detail.path.join('.')) : []);

// What the event editor sends when publishing.
const validEvent = {
  id: undefined,
  title: '  Coffee & Connect  ',
  description: 'Meet teammates across departments.',
  date: '2026-11-05',
  time: '11:30 AM',
  venue: 'Collaboration Lounge',
  category: 'Community',
  rsvp: '',
  color: 'mint',
  image: 'http://localhost:3000/uploads/123-cover.jpg',
  hosts: ['Ganesh R'],
};

test('event create accepts the editor payload and trims values', () => {
  const result = check(schemas.eventCreate, validEvent);
  assert.equal(result.error, undefined);
  assert.equal(result.value.title, 'Coffee & Connect');
});

test('event create strips fields the API does not use', () => {
  const result = check(schemas.eventCreate, { ...validEvent, relatedEvent: '5', hacked: true });
  assert.equal(result.error, undefined);
  assert.equal('hacked' in result.value, false);
});

test('event create reports every missing required field', () => {
  const result = check(schemas.eventCreate, { hosts: ['A'] });
  assert.deepEqual(fieldsWithErrors(result).sort(), ['date', 'description', 'time', 'title', 'venue']);
});

test('event create rejects blank and whitespace-only text', () => {
  const result = check(schemas.eventCreate, { ...validEvent, title: '   ', venue: '' });
  assert.deepEqual(fieldsWithErrors(result).sort(), ['title', 'venue']);
});

test('event hosts are required except for holidays', () => {
  assert.deepEqual(fieldsWithErrors(check(schemas.eventCreate, { ...validEvent, hosts: [] })), ['hosts']);
  assert.equal(check(schemas.eventCreate, { ...validEvent, category: 'Holiday', hosts: [] }).error, undefined);
});

test('event date must be a real YYYY-MM-DD date', () => {
  assert.deepEqual(fieldsWithErrors(check(schemas.eventCreate, { ...validEvent, date: '05/11/2026' })), ['date']);
  assert.deepEqual(fieldsWithErrors(check(schemas.eventCreate, { ...validEvent, date: '2026-02-30' })), ['date']);
});

test('event time must match the time picker format', () => {
  assert.equal(check(schemas.eventCreate, { ...validEvent, time: '9:05 pm' }).error, undefined);
  assert.equal(check(schemas.eventCreate, { ...validEvent, time: 'All Day' }).error, undefined);
  assert.deepEqual(fieldsWithErrors(check(schemas.eventCreate, { ...validEvent, time: '25:00' })), ['time']);
});

test('event RSVP must be an http(s) link when given', () => {
  assert.equal(check(schemas.eventCreate, { ...validEvent, rsvp: 'https://example.com/rsvp' }).error, undefined);
  assert.deepEqual(fieldsWithErrors(check(schemas.eventCreate, { ...validEvent, rsvp: 'javascript:alert(1)' })), ['rsvp']);
});

test('event category must be one of the editor options', () => {
  assert.deepEqual(fieldsWithErrors(check(schemas.eventCreate, { ...validEvent, category: 'Party' })), ['category']);
});

test('event update allows partial changes but not empty values', () => {
  assert.equal(check(schemas.eventUpdate, { title: 'New title' }).error, undefined);
  assert.deepEqual(fieldsWithErrors(check(schemas.eventUpdate, { venue: '' })), ['venue']);
  assert.ok(check(schemas.eventUpdate, {}).error);
});

test('announcement create needs a title and short description', () => {
  const ok = check(schemas.announcementCreate, { title: 'Holiday update', description: 'Office closed Friday.', details: '', category: 'HR Update', priority: 'Normal', date: '2026-11-01', relatedEvent: '', pinned: false, read: false });
  assert.equal(ok.error, undefined);
  assert.deepEqual(fieldsWithErrors(check(schemas.announcementCreate, { title: ' ', description: '' })).sort(), ['description', 'title']);
});

test('announcement priority must be Low, Normal or High', () => {
  assert.deepEqual(fieldsWithErrors(check(schemas.announcementCreate, { title: 'A', description: 'B', priority: 'Urgent' })), ['priority']);
});

test('announcement update accepts mark-as-read on its own', () => {
  assert.equal(check(schemas.announcementUpdate, { read: true }).error, undefined);
});

test('ids must be positive integers (calendar holidays are rejected)', () => {
  assert.equal(check(schemas.idParams, { id: '42' }).error, undefined);
  assert.ok(check(schemas.idParams, { id: 'holiday-12' }).error);
});
