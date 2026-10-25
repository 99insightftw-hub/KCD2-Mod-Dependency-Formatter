'use strict';
const fs=require('fs/promises'),path=require('path');
const {safeRelative,hash,hashFile}=require('./io');
async function plain(file){for(let p=path.resolve(file);;){if((await fs.lstat(p)).isSymbolicLink())throw Error('Extracted folders cannot contain links or junctions.');const parent=path.dirname(p);if(parent===p)break;p=parent;}}
async function inspectFolder(folder,{read=false,check=()=>{}}={}){
 const root=path.resolve(folder);await plain(root);if(!(await fs.lstat(root)).isDirectory())throw Error('Choose an extracted dependency folder.');
 const contents=new Map(),rows=[],seen=new Set();let size=0,count=0;
 async function walk(dir,depth){check();if(depth>12)throw Error('Extracted folder nesting limit reached.');await plain(dir);
 for await(const entry of await fs.opendir(dir)){check();if(++count>3000)throw Error('Extracted folder file-count limit reached.');
 const file=path.join(dir,entry.name),name=safeRelative(path.relative(root,file)),key=name.toLowerCase();if(seen.has(key))throw Error('Duplicate extracted file path: '+name);seen.add(key);
 const stat=await fs.lstat(file);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw Error('Extracted folders cannot contain linked files.');
 if(stat.isDirectory()){await walk(file,depth+1);continue;}if(!stat.isFile())throw Error('Unsupported extracted file.');
 if(stat.size>80*1024*1024||(size+=stat.size)>256*1024*1024)throw Error('Extracted dependency size limit reached.');
 const row={name,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino};
 if(read){await plain(file);const handle=await fs.open(file,'r');try{const before=await handle.stat();if(before.ino!==stat.ino||before.size!==stat.size)throw Error('Extracted file changed.');const bytes=Buffer.alloc(stat.size);let at=0;while(at<bytes.length){check();const n=(await handle.read(bytes,at,bytes.length-at,at)).bytesRead;if(!n)throw Error('Extracted file changed.');at+=n;}const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error('Extracted file changed.');contents.set(name,bytes);row.sha256=hash(bytes);}finally{await handle.close();}}
 rows.push(row);
 }}await walk(root,0);rows.sort((a,b)=>a.name.localeCompare(b.name));return {contents,size,fingerprint:hash(JSON.stringify(rows))};
}
async function sourceHash(file,options){return (await fs.lstat(file)).isDirectory()?(await inspectFolder(file,{...options,read:true})).fingerprint:hashFile(file);}
module.exports={inspectFolder,sourceHash};
