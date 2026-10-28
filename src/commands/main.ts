import { runCli } from './cli.ts';

// Entry point of the operator CLI: `npm run chms -- <command> [options]` (see cli.ts).
process.exitCode = await runCli(process.argv.slice(2), process.env, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
