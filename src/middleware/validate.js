// Plain-language wording for the most common rules, shown to users in the app's toast.
const MESSAGES = {
  'any.required': '{#label} is required',
  'string.empty': '{#label} is required',
  'string.max': '{#label} must be {#limit} characters or fewer',
  'string.uri': '{#label} must be a valid link',
  'string.uriCustomScheme': '{#label} must start with http:// or https://',
  'any.only': '{#label} must be one of: {#valids}',
  'object.min': 'Nothing to update',
};

const sentence = (message) => (/[.!?]$/.test(message) ? message : `${message}.`);

// Validates req[property] against a Joi schema and replaces it with the cleaned value
// (trimmed, defaults applied, unknown keys removed). Responds 400 with every problem found.
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      messages: MESSAGES,
      errors: { wrap: { label: false, array: false } },
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: sentence(detail.message),
      }));
      return res.status(400).json({
        success: false,
        message: errors.map((item) => item.message).join(' '),
        errors,
      });
    }

    // Express 5 exposes req.query as a getter, so only the body is replaced.
    if (property === 'body') req.body = value;
    return next();
  };
}

module.exports = validate;
