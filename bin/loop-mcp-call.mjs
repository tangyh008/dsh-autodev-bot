// loop-mcp-call.mjs — loop-agent MCP 薄客户端（验证“调而不搬”用）
// 只用 Node 内置模块走 stdio JSON-RPC，不 import loop-agent 任何源码，host-neutral。
// 用法：LOOP_AGENT_CLI=/path/to/loop-agent/bin/loop-agent.mjs node ./bin/loop-mcp-call.mjs tools/list
import { spawn } from 'node:child_process';
import path from 'node:path';

const LOOP_AGENT_CLI = process.env.LOOP_AGENT_CLI
if (!LOOP_AGENT_CLI) {
  console.error('需要 LOOP_AGENT_CLI 环境变量指向 loop-agent 的 bin/loop-agent.mjs')
  process.exit(1)
}

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

const child = spawn(process.execPath, [LOOP_AGENT_CLI, 'mcp', 'serve', '--stdio'], { shell: false, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        const tools = msg.result?.tools?.map((t) => t.name) ?? msg.result;
        console.log(JSON.stringify({ ok: true, tools }, null, 2));
        child.kill();
      }
    } catch { /* 分片行忽略 */ }
  }
});

child.stdout.on('end', () => process.exit(0));
child.on('error', (e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });

// MCP handshake：initialize → notifications/initialized → tools/list
child.stdin.write(JSON.stringify(rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'devbot-doctor', version: '0.1.0' } })) + '\n');
setTimeout(() => {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ ...rpc('tools/list', {}, 2) }) + '\n');
}, 300);
setTimeout(() => { console.error(JSON.stringify({ ok: false, error: 'timeout 等待 MCP tools/list' })); child.kill(); process.exit(1); }, 8000);
