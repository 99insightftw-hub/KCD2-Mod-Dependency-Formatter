'use strict';
// Wait for exit as well as a result: no unresolved gate or surviving old job.
module.exports=function workerResult(job,{key='result',onProgress=()=>{}}={}) {
  return new Promise((resolve,reject)=>{
    let value,error,received=false;
    job.on('message',m=>{
      if(!m||typeof m!=='object'){error='Worker returned an invalid message.';return;}
      if(typeof m.progress==='string'){onProgress(m.progress);return;}
      if(received){error='Worker returned multiple results.';return;}
      received=true;
      if(typeof m.error==='string')error=m.error;
      else if(Object.hasOwn(m,key)&&m[key]!=null)value=m[key];
      else error='Worker returned no usable result.';
    });
    job.on('error',e=>{error=e.message;});
    job.on('exit',code=>{if(error)reject(Error(error));else if(code||!received)reject(Error('Worker stopped before completion ('+code+'). Retry the operation; check any incomplete export.'));else resolve(value);});
  });
};
