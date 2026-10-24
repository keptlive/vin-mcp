import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('HTTP MCP initializes, lists tools, calls a local tool and terminates', {timeout:20000}, async t => {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'vin-mcp-transport-'));
  for (const name of ['server.mjs','lib','public','package.json']) await fs.cp(path.join(root,name),path.join(temp,name),{recursive:true});
  await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const child=spawn(process.execPath,[path.join(temp,'server.mjs'),'--http','--port',String(port)],{
    cwd:temp,env:{...process.env,ADMIN_KEY:'test-only-admin',JWT_SECRET:'test-only-jwt'},stdio:['ignore','ignore','pipe']});
  t.after(async()=>{child.kill();if(child.exitCode===null)await once(child,'exit');await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Server startup timeout')),8000);
    child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited'));});
    child.stderr.on('data',data=>{if(data.toString().includes('listening on port')){clearTimeout(timer);resolve();}});
  });
  const client=new Client({name:'transport-regression',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  t.after(()=>client.close());
  await client.connect(transport);
  assert.ok(transport.sessionId);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='validate_vin'));
  const result=await client.callTool({name:'validate_vin',arguments:{vin:'1HGCM82633A004352'}});
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).valid,true);
  await transport.terminateSession();
});
