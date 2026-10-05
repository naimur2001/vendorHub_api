// Usage: router.post('/x', validate(someZodSchema), handler)
// Replaces req.body with the parsed (cleaned, defaulted) data. ZodError goes to errorHandler -> 400.
export const validate = (schema) => (req, res, next) => {
  req.body = schema.parse(req.body);
  next();
};

// Express 5: req.query is read-only, so the parsed query is stored in req.validated.
export const validateQuery = (schema) => (req, res, next) => {
  req.validated = schema.parse(req.query);
  next();
};