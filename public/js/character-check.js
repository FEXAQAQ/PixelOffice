(async () => {
  const paths = {body:'CharacterModel/Character%20Model.png',hair:'Hair/Hairs.png',outfit5:'Outfits/Outfit5.png',outfit6:'Outfits/Outfit6.png'}, images = {};
  try {
    await Promise.all(Object.entries(paths).map(([name,path]) => new Promise((resolve,reject) => {
      const image = new Image(); image.onload = () => {images[name]=image;resolve();}; image.onerror=reject; image.src='/assets/MetroCity/'+path;
    })));
    for(let n=0;n<=8;n++) {
      const look=OfficeEngine.appearance(n,n===0), card=document.createElement('section'), title=document.createElement('h2'), canvas=document.createElement('canvas');
      card.className='card'; title.textContent=(n===0?'PM':'工程師外觀 '+n)+' · Outfit'+look.outfit;
      canvas.width=384;canvas.height=256;canvas.setAttribute('aria-label',title.textContent+'，全部24影格');
      const c=canvas.getContext('2d');c.imageSmoothingEnabled=false;
      for(let dir=0;dir<4;dir++)for(let step=0;step<6;step++) {
        const x=step*64,y=dir*64,frame=dir*6+step;
        c.fillStyle=(dir+step)%2?'#75836b':'#839077';c.fillRect(x,y,64,64);
        c.drawImage(images.body,frame*32,look.skin*32,32,32,x,y,64,64);
        c.drawImage(images['outfit'+look.outfit],frame*32,0,32,32,x,y,64,64);
        c.drawImage(images.hair,frame*32,look.hair*32,32,32,x,y,64,64);
      }
      card.append(title,canvas);document.getElementById('gallery').append(card);
    }
    document.getElementById('status').textContent='9 組搭配 · 216 個影格已載入';
  } catch (_) {document.getElementById('status').textContent='素材載入失敗，請檢查靜態路徑。';}
})();
