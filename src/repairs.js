'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const {execFile}=require('child_process'),{promisify}=require('util');
const {hash,hashFile}=require('./io'),{canonical}=require('./catalog');
const {resolveGame}=require('./discovery'),{vortexState,dependencyLayout}=require('./scanner');
const {assertManualScope,normalizeScope,affected}=require('./ownership');
const run=promisify(execFile);
async function gameClosed() {
  if(process.platform!=='win32')throw Error('Installation repairs are available on Windows only.');
  const {stdout}=await run('tasklist.exe',['/FI','IMAGENAME eq KingdomCome.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:5000});
  return !/^"KingdomCome\.exe"/im.test(stdout);
}
function makeOrder(report,bytes) {
  if(hash(bytes)!==report.order.hash)throw Error('Load order changed after the scan. Scan again.');
  const text=bytes.toString('utf8'),bom=text.startsWith('\uFEFF')?'\uFEFF':'',newline=text.includes('\r\n')?'\r\n':'\n';
  const rows=text.replace(/^\uFEFF/,'').split(/\r?\n/),entries=[],seen=new Set(),positions=[];
  const mods=report.mods;
  for(let i=0;i<rows.length;i++) {
    const n=rows[i].trim();if(!n||/^(#|;|\/\/)/.test(n))continue;
    positions.push(i);const m=mods.find(m=>m.loadName.toLowerCase()===n.toLowerCase()),correct=m?m.loadName:n;
    if(!seen.has(correct.toLowerCase())){seen.add(correct.toLowerCase());entries.push(correct);}
  }
  for(const dep of report.dependencies.filter(d=>d.requiredBy.length))for(const p of dep.providers) {
    const mod=mods.find(m=>m.root===p.root);if(!mod||!seen.has(mod.loadName.toLowerCase())&&dep.providers.length>1)continue;
    if(!seen.has(mod.loadName.toLowerCase())){entries.push(mod.loadName);seen.add(mod.loadName.toLowerCase());}
  }
  const edges=[];
  for(const r of report.requirements.filter(r=>r.active&&r.kind!=='optional')) {
    const consumer=mods.find(m=>m.id===r.consumer||(canonical(m.id)||m.id)===r.consumer),provider=mods.find(m=>(canonical(m.id)||m.id).toLowerCase()===r.target.toLowerCase());
    if(consumer&&provider&&consumer!==provider&&entries.includes(consumer.loadName)&&entries.includes(provider.loadName))edges.push([provider.loadName,consumer.loadName]);
  }
  const sorted=[],remaining=[...entries];
  while(remaining.length) {
    const next=remaining.find(n=>!edges.some(([p,c])=>c===n&&remaining.includes(p)));
    if(!next)throw Error('Dependency cycle detected. Resolve it with the mod authors before changing load order.');
    sorted.push(next);remaining.splice(remaining.indexOf(next),1);
  }
  positions.forEach((i,j)=>{rows[i]=sorted[j]||'';});
  const extra=sorted.slice(positions.length);if(extra.length){if(rows[rows.length-1]==='')rows.pop();rows.push(...extra,'');}
  return Buffer.from(bom+rows.join(newline));
}
async function previewOrder(report) {
  if(!report.order.exists)throw Error('No mod_order.txt exists. Creating a restrictive load order automatically could disable other mods. Use the game/Vortex load-order controls.');
  const bytes=await fs.readFile(report.order.path),after=makeOrder(report,bytes);
  return {kind:'order',root:report.game.root,target:report.order.path,before:hash(bytes),after:hash(after),
    beforeText:bytes.toString('utf8'),afterText:after.toString('utf8'),changed:!bytes.equals(after),
    vortex:report.vortex.detected,snapshots:report.snapshots};
}
async function ensurePlainPath(root,target,{fileMayNotExist=false}={}) {
  const base=path.resolve(root),resolved=path.resolve(target);
  if(resolved!==base&&!resolved.startsWith(base+path.sep))throw Error('Target escapes the declared folder.');
  const segments=path.relative(base,resolved).split(path.sep).filter(Boolean);let current=base;
  const baseStat=await fs.lstat(base);if(baseStat.isSymbolicLink())throw Error('Repair root is linked. Use the manager that owns it.');
  for(const segment of segments) {
    current=path.join(current,segment);const stat=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT'&&fileMayNotExist)return null;throw e;});
    if(!stat)continue;
    if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw Error('Repair target is linked or shared: '+current);
  }
}
async function freshGate(game,snapshots,closed=gameClosed,layout=null,scope=null) {
  const current=await resolveGame(path.join(game.bin,'KingdomCome.exe'));
  if(current.root!==game.root||current.bin!==game.bin)throw Error('Selected installation changed. Scan again.');
  if(game.whHash&&await hashFile(path.join(current.bin,'WHGame.dll'))!==game.whHash)throw Error('Game build changed. Scan again before repair or undo.');
  if(!await closed())throw Error('Close KCD2 before repairing files.');
  if(layout){
    if(layout.incomplete)throw Error('Dependency layout inspection was incomplete. Resolve its findings and scan again before repair.');
    if((await dependencyLayout(game)).hash!==layout.hash)throw Error('Dependency layout changed after the scan. Scan again.');
  }
  const declared=scope?normalizeScope(game,scope):null;
  for(const [file,sha] of Object.entries(snapshots))if((!declared||affected(declared,file))&&await hashFile(file)!==sha)throw Error('Files changed after the scan. Scan again: '+file);
  if(declared){await assertManualScope(game,declared);return;}
  const vortex=await vortexState(game);
  if(vortex.detected)throw Error('Vortex deployment detected. Reinstall/enable/deploy dependencies and adjust load order in Vortex. Direct repair is disabled to preserve managed files.');
}
async function locked(store,game,fn) {
  await fs.mkdir(store,{recursive:true});
  const shared=path.join(game.root,'_mod_audit_backup','elfis-combat-setup-lock');
  await ensurePlainPath(game.root,shared,{fileMayNotExist:true});
  await fs.mkdir(shared,{recursive:true});
  const lock=path.join(shared,hash(Buffer.from(game.root.toLowerCase()))+'.lock');
  const handle=await fs.open(lock,'wx').catch(()=>{throw Error('Another repair is active. If the app crashed, inspect its repair record before removing the lock.');});
  try{await handle.writeFile(JSON.stringify({pid:process.pid,time:new Date().toISOString(),root:game.root}));return await fn();}
  finally{await handle.close();await fs.unlink(lock);}
}
async function applyOrder(report,preview,store,{closed=gameClosed}={}) {
  return locked(store,report.game,async()=>{
    await freshGate(report.game,preview.snapshots,closed,report.layout);
    if(preview.target!==report.order.path||preview.before!==report.order.hash)throw Error('Repair preview does not match this scan.');
    await ensurePlainPath(report.game.mods,preview.target);
    const bytes=await fs.readFile(preview.target),after=makeOrder(report,bytes);
    if(hash(after)!==preview.after||hash(bytes)!==preview.before)throw Error('Repair preview changed.');
    if(bytes.equals(after))throw Error('No load-order changes are needed.');
    const dir=path.join(store,crypto.randomUUID());await fs.mkdir(dir);
    const backup=path.join(dir,'mod_order.before.txt');await fs.writeFile(backup,bytes,{flag:'wx'});
    const temp=path.join(path.dirname(preview.target),'.dependency-checker-'+crypto.randomUUID()+'.tmp');
    const receipt={kind:'order',game:report.game,target:preview.target,before:hash(bytes),after:hash(after),backup,time:new Date().toISOString(),state:'prepared'};
    const receiptPath=path.join(dir,'receipt.json');await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));
    try {
      await fs.writeFile(temp,after,{flag:'wx'});
      // Refresh immediately before replacement, including link ownership.
      await freshGate(report.game,preview.snapshots,closed,report.layout);await ensurePlainPath(report.game.mods,preview.target);
      await fs.rename(temp,preview.target);
      if(await hashFile(preview.target)!==receipt.after)throw Error('Repair readback differs.');
      receipt.state='applied';await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));return {receipt:receiptPath,changed:[preview.target]};
    }catch(e){receipt.state='failed';receipt.error=e.message;await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));throw e;}
    finally{await fs.unlink(temp).catch(()=>{});}
  });
}
async function undoOrder(receiptPath,store,{closed=gameClosed}={}) {
  const rp=path.resolve(receiptPath),base=path.resolve(store);
  if(!rp.startsWith(base+path.sep)||path.basename(rp)!=='receipt.json')throw Error('Unknown repair receipt.');
  const receipt=JSON.parse(await fs.readFile(rp,'utf8'));
  if(receipt.kind!=='order'||receipt.state!=='applied')throw Error('This receipt has no reversible load-order repair.');
  if(path.resolve(receipt.backup)!==path.join(path.dirname(rp),'mod_order.before.txt'))throw Error('Unexpected backup path.');
  await ensurePlainPath(base,receipt.backup);
  return locked(store,receipt.game,async()=>{
    const expected=path.join(receipt.game.mods,'mod_order.txt');if(receipt.target!==expected)throw Error('Unexpected rollback target.');
    await freshGate(receipt.game,{[expected]:receipt.after},closed);await ensurePlainPath(receipt.game.mods,expected);
    const bytes=await fs.readFile(receipt.backup);if(hash(bytes)!==receipt.before)throw Error('Rollback backup changed.');
    const temp=path.join(path.dirname(expected),'.dependency-checker-undo-'+crypto.randomUUID()+'.tmp');
    try{await fs.writeFile(temp,bytes,{flag:'wx'});await freshGate(receipt.game,{[expected]:receipt.after},closed);await ensurePlainPath(receipt.game.mods,expected);await fs.rename(temp,expected);if(await hashFile(expected)!==receipt.before)throw Error('Undo verification failed');}
    finally{await fs.unlink(temp).catch(()=>{});}
    receipt.state='undone';await fs.writeFile(rp,JSON.stringify(receipt,null,2));return {changed:[expected]};
  });
}
module.exports={previewOrder,makeOrder,applyOrder,undoOrder,gameClosed,ensurePlainPath,freshGate,locked,assertManualScope};
