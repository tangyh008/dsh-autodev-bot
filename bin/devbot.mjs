#!/usr/bin/env node
// devbot — @local/dsh-autodev-bot 薄 CLI（跨平台：仅 Node API，无 shell 依赖）
// 用法：
//   node ./bin/devbot.mjs install --profile web
//   node ./bin/devbot.mjs init --project ./my-app
//   node ./bin/devbot.mjs doctor
import { execFile } from 'node:child_process';
import { mkdir, copyFile, access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: false }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[devbot] ${cmd} ${args.join(' ')} 失败：${error.message}`);
        if (stderr) console.error(stderr);
        resolve(1);
        return;
      }
      if (stdout) process.stdout.write(stdout);
      resolve(0);
    });
  });
}

async function cmdOnPath(cmd) {
  // 跨平台 PATH 查找：win 下补 .exe/.cmd/.bat，不经过 shell
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      try { await access(path.join(dir, name)); return path.join(dir, name); }
      catch { /* 继续找 */ }
    }
  }
  return null;
}

async function resolveDsh() {
  // 1) PATH 上的 dsh；2) DSH_CHECKOUT 源码的 apps/cli；3) 无则返回 null 走手动提示
  const onPath = await cmdOnPath('dsh');
  if (onPath) return { cmd: onPath, prefix: [] };
  const checkout = process.env.DSH_CHECKOUT
    ?? path.join(os.homedir(), 'softwareRepo', 'github', 'deepseek-harness');
  const binJs = path.join(checkout, 'apps', 'cli', 'lib', 'bin.js');
  try { await stat(binJs); return { cmd: process.execPath, prefix: [binJs] }; }
  catch { return null; }
}

async function cmdInstall() {
  const profile = arg('--profile', 'web');
  console.log(`[devbot] 安装 bundle 到 profile=${profile}（目录：${root}）`);
  const dsh = await resolveDsh();
  if (!dsh) {
    console.log(`[devbot] 未找到 dsh（PATH 无 dsh 且无 DSH_CHECKOUT），请手动执行：dsh plugin --profile ${profile} add ${root}`);
    console.log('[devbot] 源码运行 DSH 时可设：DSH_CHECKOUT=/path/to/deepseek-harness 再重跑 install');
    process.exitCode = 1;
    return;
  }
  const code = await run(dsh.cmd, [...dsh.prefix, 'plugin', '--profile', profile, 'add', root]);
  if (code !== 0) {
    console.log(`[devbot] 自动安装未成功，请手动执行：dsh plugin --profile ${profile} add ${root}`);
    process.exitCode = 1;
  } else {
    console.log(`[devbot] 安装成功：profile=${profile}`);
  }
}

async function cmdInit() {
  const project = path.resolve(arg('--project', './my-app'));
  for (const d of ['prd', 'issues', 'ard']) await mkdir(path.join(project, d), { recursive: true });
  const copies = [
    ['skills/prd-template.md', 'prd/TEMPLATE.md'],
    ['skills/issue-template.md', 'issues/TEMPLATE.md'],
    ['skills/design-template.md', 'issues/DESIGN-TEMPLATE.md'],
    ['skills/test-template.md', 'issues/TEST-TEMPLATE.md'],
    ['skills/ard-template.md', 'ard/TEMPLATE.md'],
  ];
  for (const [from, to] of copies) await copyFile(path.join(root, from), path.join(project, to));
  console.log(`[devbot] 已初始化：${project}/prd issues ard（含 5 份模板）`);
}

async function cmdDoctor() {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  console.log(`[devbot] node ${process.version} ${nodeOk ? 'OK' : '需要 >=22.13.0'}`);
  for (const f of ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
    try { await access(path.join(root, f)); console.log(`[devbot] ${f} OK`); }
    catch { console.log(`[devbot] ${f} 缺失`); process.exitCode = 1; }
  }
  const loopAgent = await run('loop-agent', ['doctor']);
  console.log(`[devbot] loop-agent ${loopAgent === 0 ? '可用（执行后端就绪）' : '不可用（将降级为纯 DSH 模式）'}`);
}

const cmd = process.argv[2];
if (cmd === 'install') await cmdInstall();
else if (cmd === 'init') await cmdInit();
else if (cmd === 'doctor') await cmdDoctor();
else {
  console.log('用法： devbot install --profile web | devbot init --project ./my-app | devbot doctor');
  process.exitCode = 2;
}
