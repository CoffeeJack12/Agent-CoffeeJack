// Drop approved assets in public/jack; all Jack identity instances use this factory.
export function jackBrand(kind='avatar',hero=false) {
 const node=document.createElement('span');
 node.className='jack-brand'+(hero?' jack-placeholder':'');node.dataset.jack=kind;
 node.setAttribute('role','img');node.setAttribute('aria-label','Jack');
 const monogram=document.createElement('span');monogram.textContent='J';node.append(monogram);
 const img=document.createElement('img');img.alt='';img.src='/jack/'+kind+'.png';img.hidden=true;
 img.onload=()=>{img.hidden=false;monogram.hidden=true;};img.onerror=()=>img.remove();node.append(img);return node;
}
export function mountBranding() {
 document.querySelectorAll('[data-jack-slot]').forEach(node=>node.replaceWith(jackBrand(node.dataset.jackSlot,node.hasAttribute('data-hero'))));
 const icon=new Image();icon.onload=()=>{document.querySelector('link[rel="icon"]').href='/jack/icon.png';};icon.src='/jack/icon.png';
}
