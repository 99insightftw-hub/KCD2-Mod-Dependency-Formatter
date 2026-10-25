'use strict';
const fs=require('fs/promises');
const {exportGate}=require('./downloads');
async function saveReport(report,file,user=process.env.USERPROFILE||'') {
  if(!/\.json$/i.test(file))throw Error('Save the report as a new .json file.');
  await exportGate(report.game,file);
  const text=JSON.stringify(report,null,2),escapedUser=JSON.stringify(user).slice(1,-1);
  // Exclusive creation never overwrites a game, manager, or unrelated file.
  try{await fs.writeFile(file,escapedUser?text.split(escapedUser).join('%USERPROFILE%'):text,{flag:'wx'});}
  catch(e){if(e.code==='EEXIST')throw Error('Report file already exists. Choose a new filename; existing files are never overwritten.');throw e;}
  return file;
}
module.exports={saveReport};
