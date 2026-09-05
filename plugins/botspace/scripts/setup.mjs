import { readFile, writeFile, mkdir, lstat, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const marker = '<!-- Managed by botspace setup. -->';
export async function setup({ target, directory, global = false }) {
  if (!['codex','claude'].includes(target)) throw Error('Use --target codex or --target claude. Other shell-capable agents can use the botspace command directly.');
  if (global && directory) throw Error('Choose --global or --directory, not both.');
  const base = resolve(global ? homedir() : directory || process.cwd());
  const parts = [target === 'codex' ? '.agents' : '.claude', 'skills', 'botspace'];
  let current = base;
  // Do not overwrite another integration through a symlinked skill directory.
  for (const part of parts) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('Refusing to modify a symlinked skill directory.'); }
    catch(e) { if (e.code !== 'ENOENT') throw e; }
  }
  const destination = join(current, 'SKILL.md');
  let existing;
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw Error('Refusing to overwrite a symlinked skill.');
    existing = await readFile(destination, 'utf8');
    if (!existing.includes(marker)) throw Error('An unmanaged Botspace skill already exists; it has been left untouched.');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const source = await readFile(new URL('../skills/collaborate/SKILL.md', import.meta.url), 'utf8');
  // All instructions come from the same reviewed collaboration skill.
  let content = source.replace('name: collaborate', 'name: botspace')
    .replace(/The bundled client is[^\n]+/, 'The Botspace CLI is installed with npm. Run `botspace help` to check availability. Node.js 18+ is required.')
    .replaceAll('node "$BOTSPACE_CLI"', 'botspace');
  const section = content.indexOf('\n## Install and update');
  if(section >= 0) content=content.slice(0,section);
  content+='\n## Install and update\n\nSource: https://github.com/publu/botspace-plugin. Update with `npm install -g github:publu/botspace-plugin`, then rerun the same `botspace setup` command. Workspace credentials and pending sends remain in the private store.\n\n'+marker+'\n';
  await mkdir(current, {recursive:true});
  const temp=destination+'.'+randomUUID()+'.tmp';
  await writeFile(temp,content,{flag:'wx'});
  await rename(temp,destination);
  return { target, scope:global ? 'global' : 'project', installed:true, updated:!!existing, next:'Start a new agent session and ask it to use Botspace with your workspace URL. Credentials and other agent settings were preserved.' };
}
