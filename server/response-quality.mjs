import { addressTitle } from './preferences.mjs';
export function emptyAnswer(text) {
 return !String(text).replace(/^\s*(?:\d+[.)]|[-*+]\s?|#{1,6}|>)\s*$/gm,'').replace(/[\s\u200b*_`#.-]/g,'');
}
export function limitAddress(text,p,previous='',userText='') {
 const title=addressTitle(p);
 let out=String(text);
 if (title && (p.language==='ar' || (p.language==='auto' && /[\u0600-\u06ff]/.test(userText))) && !/^[A-Za-z]/.test(userText.trim())) {
  const englishTitles=/\s*,?\s*\b(Master|Lord|Sir)\b/gi;
  out=out.replace(englishTitles,'').replace(/ {2,}/g,' ').replace(/[،,]\s*([.!?])/g,'$1').replace(/[،,]\s*$/g,'').replace(/\s+([،.!?])/g,'$1');
 }
 if(!title)return out;
 const escaped=title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const pattern=new RegExp('\\b'+escaped+'\\b','gi');
 let count=(previous.match(pattern)??[]).length;
 return out.split(/(```[\s\S]*?```)/g).map(part=>part.startsWith('```')?part:part.replace(pattern,match=>count++===0?match:'').replace(/,\s*([.!?])/g,'$1').replace(/ {2,}/g,' ')).join('');
}
