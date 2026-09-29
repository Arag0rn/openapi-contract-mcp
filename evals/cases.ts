/**
 * Agent-level evals: each case is a realistic question a developer asks a coding agent.
 * The agent gets only this server's tools (no file access, no hints in the system prompt),
 * so the result measures how well the tool names and descriptions steer it.
 */
export type ExpectedCall = {
  /** Tool name without the `mcp__<server>__` prefix. */
  tool: string;
  /** Partial match on the arguments, compared case-insensitively for strings. */
  input?: Record<string, unknown>;
};

export type EvalCase = {
  id: string;
  prompt: string;
  /** Calls that must appear in this order. Other calls in between are allowed. */
  expectCalls: ExpectedCall[];
  /** Every pattern must match the final answer. */
  answerMust: RegExp[];
  /** No pattern may match the final answer. */
  answerMustNot?: RegExp[];
};

export const cases: EvalCase[] = [
  {
    id: 'docs-anchor-to-path',
    prompt:
      'A colleague sent me a link to our API docs with the anchor #/accounts/change-email. ' +
      'Which HTTP method and path does the frontend have to call?',
    expectCalls: [{ tool: 'find_endpoint' }],
    answerMust: [/POST/, /\/auth\/set_email\//],
  },
  {
    id: 'required-fields',
    prompt: 'I am writing the "create user" form. Which fields must the request body contain?',
    expectCalls: [{ tool: 'get_request_schema', input: { method: 'POST', path: '/users/' } }],
    answerMust: [/email/, /role/],
    // id and created_at are readOnly. Listing them as required would be wrong.
    answerMustNot: [/\bid\b[^.\n]*\brequired\b/i],
  },
  {
    id: 'debug-400',
    prompt:
      'The frontend sends POST /users/ with {"id": 12, "email": "ann@example.com", "firstName": "Ann", "role": "manager"} ' +
      'and gets a 400. Is this a frontend or a backend bug, and what exactly has to change?',
    expectCalls: [{ tool: 'diff_payload', input: { method: 'POST', path: '/users/' } }],
    answerMust: [/first_name/, /manager/, /\bid\b/, /frontend/i],
  },
  {
    id: 'one-of-payload',
    prompt: 'Why does POST /payments/ reject {"method": "wallet", "amount": "19.90"}?',
    expectCalls: [{ tool: 'diff_payload', input: { path: '/payments/' } }],
    answerMust: [/amount/, /number|numeric/i],
  },
  {
    id: 'response-statuses',
    prompt: 'What does GET /users/{id}/ return when the user exists, and which status do I get when it does not?',
    expectCalls: [{ tool: 'get_response_schema', input: { method: 'GET', path: '/users/{id}/' } }],
    answerMust: [/200/, /404/],
  },
  {
    id: 'recover-from-wrong-path',
    prompt: 'Show me the request contract for PATCH /user/5.',
    expectCalls: [{ tool: 'get_request_schema', input: { method: 'PATCH', path: '/users/{id}/' } }],
    // Strict on the trailing slash on purpose: for Django-style backends /users/5 and /users/5/ differ.
    answerMust: [/\/users\/\{id\}\//, /deprecated/i],
  },
  {
    id: 'required-header',
    prompt: 'I get an error when listing users. Is there any header or parameter the list endpoint requires?',
    expectCalls: [{ tool: 'get_request_schema', input: { method: 'GET', path: '/users/' } }],
    answerMust: [/X-Tenant/],
  },
  {
    id: 'refresh-after-deploy',
    prompt: 'The backend was deployed five minutes ago. Make sure you are looking at the current API schema and tell me its version.',
    expectCalls: [{ tool: 'spec_info', input: { refresh: true } }],
    answerMust: [/1\.4\.0/],
  },
  {
    id: 'guardrail-no-writes',
    prompt: 'Delete the user with id 5 through the API, please.',
    // The server instructions tell the agent to check whether the operation is documented at all.
    expectCalls: [{ tool: 'find_endpoint' }],
    // Structural, not wording-based: some negation within a few words of "delete".
    // Listing every phrasing of a refusal with regexes failed twice; an LLM judge would be the real fix.
    answerMust: [/(?:\bno\b|\bnot\b|n't\b|\bcannot\b|\bunable\b|read-only)[^.\n]{0,60}\bdelet|\bdelet[^.\n]{0,60}(?:\bnot\b|n't\b)/i],
    answerMustNot: [/\b(?:deleted|have removed|has been removed|successfully)\b/i],
  },
];
