import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=await mkdtemp(path.join(tmpdir(),'tk-order-'));
try {
 await build({entryPoints:['src/lib/boardOrder.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'order.mjs')});
 const {moveTask,reorderLanes}=await import(pathToFileURL(path.join(dir,'order.mjs')));
 const lanes=[{id:'a',status:'todo',sortOrder:0},{id:'b',status:'doing',sortOrder:1},{id:'empty',status:'done',sortOrder:2}];
 const mk=(id,lane,sort,projectId='p')=>({id,projectId,swimlaneId:lane,status:lane==='a'?'todo':'doing',sortOrder:sort,createdAt:sort,archived:false,title:id});
 const original=[mk('1','a',0),mk('2','a',1),mk('3','a',2),mk('4','b',0),mk('5','b',1),mk('other','a',0,'other')];
 const ids=(ts,lane)=>ts.filter(t=>t.projectId==='p'&&t.swimlaneId===lane).sort((a,b)=>a.sortOrder-b.sortOrder).map(t=>t.id);
 let ts=moveTask(original,'p','1',lanes[0],2,100);assert.deepEqual(ids(ts,'a'),['2','3','1']);
 ts=moveTask(ts,'p','1',lanes[0],0,101);assert.deepEqual(ids(ts,'a'),['1','2','3']);
 ts=moveTask(ts,'p','2',lanes[1],1,102);assert.deepEqual(ids(ts,'b'),['4','2','5']);assert.deepEqual(ids(ts,'a'),['1','3']);assert.equal(ts.find(t=>t.id==='2').status,'doing');
 ts=moveTask(ts,'p','2',lanes[2],0,103);assert.deepEqual(ids(ts,'empty'),['2']);assert.equal(ts.find(t=>t.id==='2').status,'done');
 assert.strictEqual(ts.find(t=>t.id==='other'),original.find(t=>t.id==='other'));
 assert.deepEqual(ids(original,'a'),['1','2','3']);assert.equal(new Set(ts.map(t=>t.id)).size,ts.length);
 assert.deepEqual(ids(JSON.parse(JSON.stringify(ts)),'b'),['4','5']);
 assert.deepEqual(reorderLanes(lanes,'a','empty').map(l=>l.id),['b','empty','a']);
 assert.deepEqual(reorderLanes(lanes,'empty','a').map(l=>l.sortOrder),[0,1,2]);
 assert.strictEqual(moveTask(original,'wrong-project','1',lanes[1],0),original);
 console.log('PASS: within-lane up/down, cross-lane insertion, empty lane, status, isolation, immutability, serialization, lane ordering.');
} finally {await rm(dir,{recursive:true,force:true});}
