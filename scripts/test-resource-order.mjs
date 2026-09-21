import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=await mkdtemp(path.join(tmpdir(),'tk-res-order-'));
try {
 await build({entryPoints:['src/lib/resourceOrder.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'order.mjs')});
 const {compareResources,frontSortOrder,reorderResources}=await import(pathToFileURL(path.join(dir,'order.mjs')));
 const mk=(id,sortOrder,updatedAt,projectId='p')=>({id,projectId,title:id,url:'',note:'',tags:[],createdAt:updatedAt,updatedAt,sortOrder});
 const ids=rs=>[...rs].sort(compareResources).map(r=>r.id);
 const list=[mk('a',0,10),mk('b',1,20),mk('c',2,30)];

 // 展示顺序 = sortOrder 升序
 assert.deepEqual(ids(list),['a','b','c']);
 // 同序号（旧数据/并发新建）按更新时间新的在前
 assert.deepEqual(ids([mk('x',0,1),mk('y',0,9)]),['y','x']);

 // 新建排最前：取最小序号 - 1
 assert.equal(frontSortOrder(list),-1);
 assert.equal(frontSortOrder([]),0);
 assert.deepEqual(ids([...list,mk('new',frontSortOrder(list),40)]),['new','a','b','c']);

 // 拖拽：可见项在原有槽位间重排，未显示的项（h1/h2）序号与时间戳都不动
 const mixed=[mk('h1',1,100,'other'),mk('a',0,10),mk('h2',3,100,'other'),mk('b',2,20)];
 const moved=reorderResources(mixed,['b','a'],999);
 assert.deepEqual(ids(moved),['b','h1','a','h2']);
 assert.equal(moved.find(r=>r.id==='b').sortOrder,0);
 assert.equal(moved.find(r=>r.id==='a').sortOrder,2);
 assert.equal(moved.find(r=>r.id==='b').updatedAt,999);
 assert.strictEqual(moved.find(r=>r.id==='h1'),mixed.find(r=>r.id==='h1'));
 assert.strictEqual(moved.find(r=>r.id==='h2'),mixed.find(r=>r.id==='h2'));

 // 顺序未变时不产生新对象（避免无意义写库）
 assert.strictEqual(reorderResources(list,['a','b','c']),list);

 // 只拖单项 / 未知 id 不炸
 assert.strictEqual(reorderResources(list,['b']),list);
 assert.deepEqual(ids(reorderResources(list,['unknown','a','b','c'])),['a','b','c']);

 // 不修改入参
 assert.deepEqual(ids(list),['a','b','c']);
 assert.equal(new Set(moved.map(r=>r.id)).size,moved.length);
 console.log('PASS: sortOrder 升序、同序号兜底、新建置顶、槽位重排（隐藏项不动）、幂等与不可变。');
} finally {await rm(dir,{recursive:true,force:true});}
