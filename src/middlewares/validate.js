// Usage: router.post('/x', validate(someZodSchema), handler)
// Replaces req.body with the parsed (cleaned, defaulted) data. ZodError goes to errorHandler -> 400.
export const validate = (schema) => (req, res, next) => {
  req.body = schema.parse(req.body);
  next();
};
