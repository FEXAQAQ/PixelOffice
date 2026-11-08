const fs=require('fs');
const path=require('path');
const PROVIDERS=['claude','codex'];
function createSettings(file, fallback='claude') {
  let provider=fallback;
  if(!PROVIDERS.includes(provider))throw Error('AI_PROVIDER 必須為 claude 或 codex');
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!PROVIDERS.includes(saved.provider))throw Error('AI 平台設定不合法');
    provider=saved.provider;
  } catch(error) {if(error.code!=='ENOENT')throw error;}
  return {
    get:()=>provider,
    set(value) {
      if(!PROVIDERS.includes(value))throw Error('AI 平台必須為 claude 或 codex');
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const temp=file+'.tmp';
      fs.writeFileSync(temp,JSON.stringify({provider:value},null,2)+'\n');
      fs.renameSync(temp,file);provider=value;
    }
  };
}
module.exports={createSettings,PROVIDERS};
