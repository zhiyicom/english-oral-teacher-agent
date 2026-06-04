import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cli = resolve('dist/cli.js');
const child = spawn(process.execPath, [cli], {
  env: { ...process.env, RUN_LIVE_LLM: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (d) => {
  out += d.toString();
  process.stderr.write(d);
});
child.stderr.on('data', (d) => {
  err += d.toString();
  process.stderr.write(d);
});
child.on('close', (code) => {
  process.stderr.write(`\n[child exit code: ${code}]\n`);
});

setTimeout(() => child.stdin.write('hi\n'), 500);
setTimeout(() => child.stdin.write('i am fine thanks\n'), 4000);
setTimeout(() => child.stdin.write('i played minecraft\n'), 8000);
setTimeout(() => child.stdin.write('i usually build castles and farms\n'), 12000);
setTimeout(() => child.stdin.write('creepers keep blowing them up\n'), 16000);
setTimeout(() => child.stdin.write('haha yes\n'), 20000);
setTimeout(() => child.stdin.write('exit\n'), 24000);
setTimeout(() => child.stdin.end(), 25000);
