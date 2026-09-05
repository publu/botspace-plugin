import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
test('native marketplaces install the same self-contained plugin and matching version',async()=>{
 const read=async path=>JSON.parse(await readFile(path,'utf8'));
 const codex=await read('.agents/plugins/marketplace.json');
 const claude=await read('.claude-plugin/marketplace.json');
 assert.equal(codex.plugins[0].source.path,claude.plugins[0].source);
 const root=resolve(claude.plugins[0].source);
 const cm=await read(root+'/.codex-plugin/plugin.json');
 const am=await read(root+'/.claude-plugin/plugin.json');
 assert.equal(cm.version,am.version);
 assert.equal(am.version,(await read('package.json')).version);
 assert.equal(am.name,cm.name);
 const skill=await readFile(root+'/skills/collaborate/SKILL.md','utf8');
 assert.match(skill,/\.\.\/\.\.\/scripts\/botspace\.mjs/);
 for(const name of ['botspace.mjs','client.mjs','setup.mjs']) assert.ok((await stat(root+'/scripts/'+name)).isFile());
});
