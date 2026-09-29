/**
 * Runs the agent evals through Claude Code in headless mode, so no API key is needed:
 * it uses whatever account Claude Code is logged in with.
 *
 *   npm run build
 *   npx tsx evals/run.ts [--model haiku] [--repeat 3] [--case debug-400]
 *
 * Set CLAUDE_BIN if `claude` is not on PATH (e.g. the binary bundled with the VS Code extension).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { cases, type EvalCase, type ExpectedCall } from './cases.js';

const SERVER = 'contract';
const PREFIX = `mcp__${SERVER}__`;

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'haiku' },
    repeat: { type: 'string', default: '1' },
    case: { type: 'string' },
  },
});

type Call = { tool: string; input: Record<string, unknown> };
type RunResult = {
  caseId: string;
  attempt: number;
  calls: Call[];
  answer: string;
  trajectoryOk: boolean;
  answerOk: boolean;
  failures: string[];
  turns: number;
  costUsd: number;
  durationMs: number;
};

function runAgent(prompt: string, model: string): Promise<{ calls: Call[]; answer: string; turns: number; costUsd: number; durationMs: number }> {
  const bin = process.env.CLAUDE_BIN ?? 'claude';
  const child = spawn(
    bin,
    [
      '-p',
      prompt,
      '--model',
      model,
      '--mcp-config',
      'evals/mcp.eval.json',
      '--strict-mcp-config', // only this server, none of the user's own MCP servers
      '--tools',
      '', // no built-in tools: the agent cannot read the fixture file or grep around the server
      '--allowedTools',
      `mcp__${SERVER}`,
      '--setting-sources',
      '', // ignore user and project settings, CLAUDE.md and hooks, so runs are comparable
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const calls: Call[] = [];
  let answer = '';
  let turns = 0;
  let costUsd = 0;
  let durationMs = 0;
  let buffer = '';
  let stderr = '';

  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') calls.push({ tool: String(block.name).replace(PREFIX, ''), input: block.input ?? {} });
        }
      } else if (event.type === 'result') {
        answer = event.result ?? '';
        turns = event.num_turns ?? 0;
        costUsd = event.total_cost_usd ?? 0;
        durationMs = event.duration_ms ?? 0;
      }
    }
  });

  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`Could not start "${bin}": ${error.message}. Set CLAUDE_BIN.`)));
    child.on('close', (code) => {
      if (code !== 0 && !answer) reject(new Error(`claude exited with ${code}: ${stderr.slice(0, 500)}`));
      else resolve({ calls, answer, turns, costUsd, durationMs });
    });
  });
}

const matchesInput = (actual: Record<string, unknown>, expected: Record<string, unknown> = {}) =>
  Object.entries(expected).every(([key, value]) => {
    const got = actual[key];
    return typeof value === 'string' && typeof got === 'string' ? got.toLowerCase() === value.toLowerCase() : got === value;
  });

/** Expected calls must appear in order; the agent may make other calls in between. */
function checkTrajectory(calls: Call[], expected: ExpectedCall[]): string[] {
  let from = 0;
  for (const want of expected) {
    const index = calls.findIndex((call, i) => i >= from && call.tool === want.tool && matchesInput(call.input, want.input));
    if (index === -1) return [`expected call ${want.tool}${want.input ? ` ${JSON.stringify(want.input)}` : ''} not found`];
    from = index + 1;
  }
  return [];
}

function checkAnswer(answer: string, c: EvalCase): string[] {
  const failures = c.answerMust.filter((re) => !re.test(answer)).map((re) => `answer lacks ${re}`);
  for (const re of c.answerMustNot ?? []) if (re.test(answer)) failures.push(`answer contains ${re}`);
  return failures;
}

const selected = args.case ? cases.filter((c) => c.id === args.case) : cases;
if (selected.length === 0) throw new Error(`No case "${args.case}". Known: ${cases.map((c) => c.id).join(', ')}`);
const repeat = Number(args.repeat);
const results: RunResult[] = [];

for (const c of selected) {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const run = await runAgent(c.prompt, args.model!);
    const trajectory = checkTrajectory(run.calls, c.expectCalls);
    const answer = checkAnswer(run.answer, c);
    const result: RunResult = {
      caseId: c.id,
      attempt,
      ...run,
      trajectoryOk: trajectory.length === 0,
      answerOk: answer.length === 0,
      failures: [...trajectory, ...answer],
    };
    results.push(result);
    const mark = result.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${mark}  ${c.id.padEnd(26)} #${attempt}  ${run.calls.map((call) => call.tool).join(' > ') || '(no tools)'}` +
        (result.failures.length ? `\n      ${result.failures.join('\n      ')}` : ''),
    );
  }
}

const passed = results.filter((r) => r.failures.length === 0).length;
const summary = {
  model: args.model,
  date: new Date().toISOString(),
  runs: results.length,
  passed,
  trajectoryPassRate: results.filter((r) => r.trajectoryOk).length / results.length,
  answerPassRate: results.filter((r) => r.answerOk).length / results.length,
  avgToolCalls: results.reduce((sum, r) => sum + r.calls.length, 0) / results.length,
  totalCostUsd: Number(results.reduce((sum, r) => sum + r.costUsd, 0).toFixed(4)),
};

await mkdir('evals/results', { recursive: true });
await writeFile(`evals/results/${summary.model}-latest.json`, JSON.stringify({ summary, results }, null, 2));
console.log(`\n${passed}/${results.length} passed · trajectory ${(summary.trajectoryPassRate * 100).toFixed(0)}% · answer ${(summary.answerPassRate * 100).toFixed(0)}% · avg ${summary.avgToolCalls.toFixed(1)} tool calls · $${summary.totalCostUsd}`);
