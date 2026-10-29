import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=await mkdtemp(path.join(tmpdir(),'tk-manual-order-'));
try {
 await build({entryPoints:['src/lib/manualOrder.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'order.mjs')});
 const {compareManualOrder,frontSortOrder,reorderManual}=await import(pathToFileURL(path.join(dir,'order.mjs')));
 const mk=(id,sortOrder,updatedAt,extra={})=>({id,sortOrder,updatedAt,...extra});
 const ids=items=>[...items].sort(compareManualOrder).map(i=>i.id);
 const list=[mk('a',0,10),mk('b',1,20),mk('c',2,30)];

 // 展示顺序 = sortOrder 升序；同序号按更新时间新的在前
 assert.deepEqual(ids(list),['a','b','c']);
 assert.deepEqual(ids([mk('x',0,1),mk('y',0,9)]),['y','x']);

 // 新建排最前：最小序号 - 1
 assert.equal(frontSortOrder(list),-1);
 assert.equal(frontSortOrder([]),0);
 assert.deepEqual(ids([...list,mk('new',frontSortOrder(list),40)]),['new','a','b','c']);

 // 拖拽：可见项在原有槽位间重排，未显示的项（h1/h2）序号与时间戳都不动
 const mixed=[mk('h1',1,100,{archived:false}),mk('a',0,10,{archived:false}),mk('h2',3,100,{archived:true}),mk('b',2,20,{archived:false})];
 const moved=reorderManual(mixed,['b','a'],999);
 assert.deepEqual(ids(moved),['b','h1','a','h2']);
 assert.equal(moved.find(r=>r.id==='b').sortOrder,0);
 assert.equal(moved.find(r=>r.id==='a').sortOrder,2);
 assert.equal(moved.find(r=>r.id==='b').updatedAt,999);
 assert.strictEqual(moved.find(r=>r.id==='h1'),mixed.find(r=>r.id==='h1'));
 assert.strictEqual(moved.find(r=>r.id==='h2'),mixed.find(r=>r.id==='h2'));

 // 顺序未变 / 只拖单项 / 未知 id 都不改数据；不修改入参
 assert.strictEqual(reorderManual(list,['a','b','c']),list);
 assert.strictEqual(reorderManual(list,['b']),list);
 assert.deepEqual(ids(reorderManual(list,['unknown','a','b','c'])),['a','b','c']);
 assert.deepEqual(ids(list),['a','b','c']);
 assert.equal(new Set(moved.map(i=>i.id)).size,moved.length);

 // 同序号（MCP / 局域网新建、旧数据归一后都是 0）时拖拽必须真正生效：
 // 原槽位全相同 → 重新分配唯一序号；顺序未变的拖拽仍然不改数据。
 const dup=[mk('d1',0,10),mk('d2',0,20),mk('d3',0,30)];
 assert.deepEqual(ids(dup),['d3','d2','d1']);
 const dupMoved=reorderManual(dup,['d3','d1','d2'],999);
 assert.deepEqual(ids(dupMoved),['d3','d1','d2'],'重复槽位下拖拽应生效');
 assert.equal(new Set(dupMoved.map(i=>i.sortOrder)).size,3,'重复槽位应被分配成唯一序号');
 assert.strictEqual(reorderManual(dup,['d3','d2','d1']),dup,'顺序未变的拖拽不应改写');
 // 隐藏项保持引用不变
 const dupHidden=[mk('d1',0,10,{archived:false}),mk('d2',0,20,{archived:false}),mk('hd',0,30,{archived:true})];
 const dupHiddenMoved=reorderManual(dupHidden,['d2','d1'],999);
 assert.strictEqual(dupHiddenMoved.find(i=>i.id==='hd'),dupHidden.find(i=>i.id==='hd'));
 assert.deepEqual(ids(dupHiddenMoved.filter(i=>!i.archived)),['d2','d1']);
 console.log('PASS: 手工排序升序、同序号兜底、重复槽位拖拽生效、新增置顶、槽位重排（隐藏项不动）、幂等与不可变。');
} finally {await rm(dir,{recursive:true,force:true});}
