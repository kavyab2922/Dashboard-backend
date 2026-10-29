const Joi = require('joi');

const MAX_IMAGE_LENGTH = 10 * 1024 * 1024; // a 7 MB photo as a base64 data URL

const isoDate = Joi.string()
  .trim()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((value, helpers) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value; // the pattern rule reports this one
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? helpers.error('any.invalid') : value;
  })
  .messages({
    'string.pattern.base': '{#label} must be a date in YYYY-MM-DD format.',
    'any.invalid': '{#label} must be a real calendar date.',
  });

// Matches the editor's time picker output ("9:30 AM") plus the holiday value "All Day".
const eventTime = Joi.string()
  .trim()
  .pattern(/^((1[0-2]|0?[1-9]):[0-5]\d\s?[AaPp][Mm]|All Day)$/)
  .messages({ 'string.pattern.base': '{#label} must look like 9:30 AM.' });

const EVENT_CATEGORIES = ['Company', 'Community', 'Learning', 'Wellbeing', 'Holiday'];
const PRIORITIES = ['Low', 'Normal', 'High'];

const eventHosts = Joi.array().items(Joi.string().trim().min(1).max(120)).max(20).unique().label('Hosts');
// Every event except a holiday needs at least one host (mirrors the controller rule).
const hostsForCategory = Joi.when('category', {
  is: 'Holiday',
  then: eventHosts,
  otherwise: eventHosts.min(1).messages({ 'array.min': 'Add at least one host.' }),
});

const eventFields = {
  title: Joi.string().trim().min(1).max(150).label('Event title'),
  description: Joi.string().trim().min(1).max(2000).label('Description'),
  date: isoDate.label('Date'),
  time: eventTime.label('Time'),
  venue: Joi.string().trim().min(1).max(200).label('Venue'),
  category: Joi.string().valid(...EVENT_CATEGORIES).label('Category'),
  rsvp: Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(500).allow('', null).label('RSVP URL'),
  color: Joi.string().trim().max(20).allow('', null).label('Color'),
  image: Joi.string().max(MAX_IMAGE_LENGTH).allow('', null).label('Event photo'),
};

const eventCreate = Joi.object({
  ...eventFields,
  title: eventFields.title.required(),
  description: eventFields.description.required(),
  date: eventFields.date.required(),
  time: eventFields.time.required(),
  venue: eventFields.venue.required(),
  category: eventFields.category.default('Community'),
  hosts: hostsForCategory.required(),
});

const eventUpdate = Joi.object({
  ...eventFields,
  hosts: hostsForCategory,
}).min(1);

// Holiday covers: an image to set, or '' to go back to the default.
const holidayCover = Joi.object({
  image: Joi.string().max(MAX_IMAGE_LENGTH).allow('').required().label('Cover photo'),
});

const announcementFields = {
  title: Joi.string().trim().min(1).max(200).label('Title'),
  description: Joi.string().trim().min(1).max(1000).label('Short description'),
  details: Joi.string().trim().max(10000).allow('', null).label('Full details'),
  category: Joi.string().trim().min(1).max(60).label('Category'),
  priority: Joi.string().valid(...PRIORITIES).label('Priority'),
  pinned: Joi.boolean().label('Pinned'),
  read: Joi.boolean().label('Read'),
  image: Joi.string().max(MAX_IMAGE_LENGTH).allow('', null).label('Image'),
  date: isoDate.allow('', null).label('Publication date'),
};

const announcementCreate = Joi.object({
  ...announcementFields,
  title: announcementFields.title.required(),
  description: announcementFields.description.required(),
});

const announcementUpdate = Joi.object(announcementFields).min(1);

// Database ids are integers; this also rejects calendar holidays ("holiday-12").
const idParams = Joi.object({
  id: Joi.number().integer().positive().required().label('Id')
    .messages({ 'number.base': 'This item cannot be changed here.' }),
});

// The directory has a few malformed emails; the controller skips those instead of
// failing the whole lookup, so items are only checked for type and length here.
const presenceLookup = Joi.object({
  emails: Joi.array().items(Joi.string().trim().max(320)).min(1).max(2000).required().label('Emails'),
});

module.exports = {
  holidayCover,
  presenceLookup,
  eventCreate,
  eventUpdate,
  announcementCreate,
  announcementUpdate,
  idParams,
};
