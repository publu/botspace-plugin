import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runRuntime} from '../plugins/botspace/scripts/runtimes.mjs';

test('Kimi ACP resumes exact session, ignores replay, rejects write approval in read mode',async()=>{
 await mkdir('.cache',{recursive:true});const dir=resolve(await mkdtemp('.cache/kimi-acp-'));const oldPath=process.env.PATH;
 await writeFile(dir+'/kimi',`#!${process.execPath}
import {createInterface} from 'node:readline';
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));let prompt;
for await(const line of createInterface({input:process.stdin})){
 const e=JSON.parse(line);
 if(e.method==='initialize')send({id:e.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(e.method==='session/load'){
  if(e.params.sessionId!=='owned-kimi')process.exit(4);
  send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD REPLAY'}}}});
  send({id:e.id,result:{modes:{availableModes:[{id:'default'}]}}});
 }
 if(e.method==='session/set_mode')send({id:e.id,result:{}});
 if(e.method==='session/prompt'){
  prompt=e.id;
  send({id:99,method:'session/request_permission',params:{toolCall:{kind:'edit'},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});
 }
 if(e.id===99){
  if(e.result.outcome.optionId!=='no')process.exit(5);
  send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Current answer'}}}});
  send({id:prompt,result:{stopReason:'end_turn'}});
 }
}
`,{mode:0o700});
 process.env.PATH=dir+':'+oldPath;
 try {
  const r=await runRuntime({runtime:'kimi',session:'owned-kimi',directory:dir,mode:'read',prompt:'Test',signal:AbortSignal.timeout(5000)});
  assert.equal(r.text,'Current answer');assert.equal(r.session,'owned-kimi');
 } finally {process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});}
});
