const test = require("node:test");
const assert = require("node:assert/strict");
const { validateArguments } = require("../lib/automationExecutor");

const FIELDS = [
  { key: "name", label: "Full name", required: true },
  { key: "email", label: "Email address", required: true },
  { key: "preferredTime", label: "Preferred date/time for a call", required: false },
];

test("validateArguments: passes with all required fields present and valid", () => {
  const { valid, errors, collected } = validateArguments(FIELDS, { name: "Ali Raza", email: "ali@example.com", preferredTime: "Tomorrow 3pm" });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
  assert.equal(collected.name, "Ali Raza");
  assert.equal(collected.email, "ali@example.com");
  assert.equal(collected.preferredTime, "Tomorrow 3pm");
});

test("validateArguments: missing required field fails, with an error for each missing one", () => {
  const { valid, errors } = validateArguments(FIELDS, { email: "ali@example.com" });
  assert.equal(valid, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].key, "name");
});

test("validateArguments: an optional field left empty is fine and simply omitted", () => {
  const { valid, collected } = validateArguments(FIELDS, { name: "Ali", email: "ali@example.com" });
  assert.equal(valid, true);
  assert.equal("preferredTime" in collected, false);
});

test("validateArguments: rejects a malformed email address on an email-named field", () => {
  const { valid, errors } = validateArguments(FIELDS, { name: "Ali", email: "not-an-email" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.key === "email"));
});

test("validateArguments: trims whitespace-only input and treats it as missing for a required field", () => {
  const { valid, errors } = validateArguments(FIELDS, { name: "   ", email: "ali@example.com" });
  assert.equal(valid, false);
  assert.equal(errors[0].key, "name");
});

test("validateArguments: rejects a field value over the length cap (abuse/DoS guard)", () => {
  const { valid, errors } = validateArguments(FIELDS, { name: "x".repeat(1000), email: "ali@example.com" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.key === "name"));
});

test("validateArguments: ignores keys in the submission that aren't in the automation's field list", () => {
  const { valid, collected } = validateArguments(FIELDS, { name: "Ali", email: "ali@example.com", injectedField: "malicious" });
  assert.equal(valid, true);
  assert.equal("injectedField" in collected, false);
});

test("validateArguments: non-string values are coerced to a trimmed string rather than crashing", () => {
  const { valid, collected } = validateArguments(FIELDS, { name: 12345, email: "ali@example.com" });
  assert.equal(valid, true);
  assert.equal(collected.name, "12345");
});

test("validateArguments: a completely missing/null submission fails every required field, not a crash", () => {
  const { valid, errors } = validateArguments(FIELDS, null);
  assert.equal(valid, false);
  assert.equal(errors.length, 2); // name + email
});

test("validateArguments: zero-field automation always passes trivially", () => {
  const { valid, errors, collected } = validateArguments([], {});
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(collected, {});
});
