// Exercise the installed SEO archive, including its actual native RVF bindings.
import assert from 'node:assert/strict';
import {readFile,cp,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('..',import.meta.url));
const target=resolve(process.argv[2]??''),sourceSha=process.argv[3];
assert.ok(process.argv[2]);assert.match(sourceSha??'',/^[a-f0-9]{40}$/);
const installed=join(target,'node_modules/agenticow');
const meta=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
const source=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.equal(meta.version,'0.3.1');assert.deepEqual(meta.keywords,source.keywords);
await cp(join(root,'test'),join(installed,'test'),{recursive:true});
const tests=(await readdir(join(installed,'test'))).filter(x=>x.endsWith('.test.js')).sort().map(x=>join(installed,'test',x));
const tap=execFileSync(process.execPath,['--test','--test-reporter=tap',...tests],{cwd:target,encoding:'utf8',maxBuffer:8*1024*1024});
const count=key=>Number(tap.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]);
assert.ok(count('tests')>0);assert.equal(count('pass'),count('tests'));
for(const key of ['fail','cancelled','skipped','todo'])assert.equal(count(key),0);
const cli=join(target,'metadata-cli-proof.mjs');
await writeFile(cli,`import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {open,AgenticMemory} from 'agenticow';const dir=mkdtempSync(join(tmpdir(),'agenticow-seo-'));try{const base=open(join(dir,'base.rvf'),{dimension:2,metric:'l2'});base.ingest([{id:1,vector:[1,0],text:'baseline'}]);const branch=base.branch('candidate');branch.ingest([{id:1,vector:[1,0],text:'candidate'}]);assert.equal(base.query([1,0],1,{forceExact:true})[0].text,'baseline');const checkpoint=base.checkpoint('baseline');branch.promote(base);assert.equal(base.query([1,0],1,{forceExact:true})[0].text,'candidate');base.rollback(checkpoint.id);base.save(join(dir,'memory.json'));branch.close();base.close();const reopened=AgenticMemory.load(join(dir,'memory.json'));assert.equal(reopened.query([1,0],1,{forceExact:true})[0].text,'baseline');reopened.close();const help=execFileSync(process.execPath,[${JSON.stringify(join(installed,'bin/agenticow.js'))},'--help'],{encoding:'utf8'});assert.match(help,/agenticow/i);}finally{rmSync(dir,{recursive:true,force:true});}`);
execFileSync(process.execPath,[cli],{cwd:target,encoding:'utf8',maxBuffer:2*1024*1024});
console.log(JSON.stringify({status:'passed',sourceSha,runtime:process.version,checks:[
  {name:'exact installed keyword metadata',tests:1,failed:0,skipped:0,todo:0},
  {name:'installed native RVF package regression suite',tests:count('tests'),failed:0,skipped:0,todo:0},
  {name:'public API branch isolation, promotion, persisted rollback and CLI',tests:5,failed:0,skipped:0,todo:0}
]}));
