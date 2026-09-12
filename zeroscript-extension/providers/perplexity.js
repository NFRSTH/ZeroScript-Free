// SPDX-License-Identifier: GPL-3.0-or-later
// providers/perplexity.js - Perplexity AI (perplexity.ai / www.perplexity.ai) provider.
// Generic ZSProvider implementation - bar mounts inside composer, generic turn detection.
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};
  const S = {
    chatItem: 'div[data-testid*="message"], div[class*="message"], main div[class*="answer"], [role="article"]',
    input: 'textarea[placeholder*="Ask anything"], textarea, [contenteditable="true"][data-lexical-editor], [data-testid*="input"]',
    sendBtn: 'button[aria-label*="Send"], button[data-testid*="send"], button:has(svg[class*="send"])',
    stopBtn: 'button[aria-label*="Stop"], button[data-testid*="stop"], button:has(svg[class*="stop"])',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"]',
    reasoning: '[data-testid*="thinking"],[class*="thinking"]',
  };
  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long|trop long)","context.{0,20}(limit|exceeded)","token.{0,10}limit","maximum.{0,20}context"].join("|"),"i"),
    tooLong: /conversation .{0,20}(too long|trop longue)/i,
    busy: /server is busy|try again later|rate limit|too many requests/i,
  };
  const timings = { GEN_IDLE_MS: 1500, REASON_IDLE_MS: 12000, WARMUP_MS: 45000, REASON_NOREPLY_MS: 90000, STABLE_MS: 9000, RESPONSE_TIMEOUT_MS: 300000 };
  const allItems = () => {
    let items = [...document.querySelectorAll(S.chatItem)];
    if (items.length < 2) items = [...document.querySelectorAll('main div')].filter(e=> (e.textContent||'').trim().length>20 && e.children.length<5);
    return items.filter(e=> !e.closest('#zs-root'));
  };
  const isAssistantItem = (it) => !!it && (it.matches('[data-testid*="assistant"],[class*="assistant"],[class*="answer"]') || !!it.querySelector('[class*="answer"]'));
  const isUserItem = (it) => !!it && !isAssistantItem(it);
  function itemText(it){ if(!it) return ""; const c=it.cloneNode(true); c.querySelectorAll('.zs-chip').forEach(n=>n.remove()); return c.textContent||""; }
  function classifyText(it, ex){ if(!it) return ""; let t=itemText(it); if(ex) { const el=it.querySelector(ex); if(el) t=t.replace(el.textContent,''); } return t; }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const a=assistantItems(); return a.length?a[a.length-1]:null; };
  const _idMap=new WeakMap(); let _seq=0; function lastAssistantId(){ const it=lastAssistant(); if(!it) return null; let id=_idMap.get(it); if(!id){id=++_seq; _idMap.set(it,id);} return id; }
  const chatIsEmpty=()=> allItems().length===0;
  const getEditor=()=>{ const els=[...document.querySelectorAll(S.input)].filter(e=>!e.closest('#zs-root') && e.offsetParent!==null); return els.find(e=>e.tagName==='TEXTAREA')||els[0]||document.querySelector('textarea')||null; };
  const editorText=()=>{ const e=getEditor(); if(!e) return ""; return e.value!=null?e.value:e.textContent||""; };
  let _locked=false; function setInputLock(on){ _locked=on; const e=getEditor(); if(!e) return; if(on){ e.setAttribute('readonly',''); e.setAttribute('placeholder','⏳ Agent working…'); } else { e.removeAttribute('readonly'); } }
  const composerFrame=()=> { const e=getEditor(); return e?e.parentElement:null; };
  function barMount(){ const e=getEditor(); if(!e) return null; let box=e.parentElement; while(box && box!==document.body){ if(box.contains(e)) break; box=box.parentElement; } if(!box||box===document.body) box=e.parentElement; let before=box.firstElementChild; if(before&&before.id==='zs-bar') before=before.nextElementSibling; return {parent:box, before, inside:true}; }
  function isStopBtn(b){ if(!b) return false; if(b.querySelector('rect')) return true; const p=b.querySelector('path'); if(p) return /^\s*M\s*[0-3][\s.]/.test(p.getAttribute('d')||''); return /stop/i.test(b.getAttribute('aria-label')||''); }
  let _max=-1,_at=0,_item=null; function sample(){ const it=lastAssistant(); const len=(it?it.textContent.length:0); const now=Date.now(); if(it!==_item||len<_max-400){_item=it;_max=len;_at=now;return;} if(len>_max){_max=len;_at=now;} }
  const grewWithin=(ms)=> _max>1 && Date.now()-_at<ms;
  function isGenerating(){ if(document.querySelector('[data-testid*="stop"],button[aria-label*="Stop"]')) return true; const b=document.querySelector(S.stopBtn); if(isStopBtn(b)) return true; sample(); return grewWithin(timings.GEN_IDLE_MS); }
  const isBusyNow=isGenerating; const isHardGenerating=()=> !!document.querySelector(S.stopBtn) && isStopBtn(document.querySelector(S.stopBtn));
  function snapshot(){ try{ const it=lastAssistant(); return {rp: it?(it.textContent||'').length:0}; }catch{ return {}; } }
  function findContinueBtn(){ for(const b of document.querySelectorAll('button')){ if(b.offsetParent===null) continue; if(/continue/i.test((b.innerText||'').trim())) return b; } return null; }
  const clickContinueBtn=()=>{ const b=findContinueBtn(); if(!b) return false; try{b.click(); return true;}catch{return false;} };
  function readAssistant(){ const it=lastAssistant(); if(!it) return {present:false, reply:"",thinking:"",item:null}; return {present:true, reply: it.textContent.trim(), thinking:"", item:it}; }
  async function waitFor(p,t){ const t0=Date.now(); while(Date.now()-t0<t){ if(p()) return true; await sleep(120);} return false; }
  function setTextareaValue(el,v){ const proto=window.HTMLTextAreaElement&&window.HTMLTextAreaElement.prototype; const s=proto&&Object.getOwnPropertyDescriptor(proto,'value'); if(s&&s.set) s.set.call(el,v); else el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
  async function typeAndSend(text,images){ const ed=getEditor(); if(!ed) throw new Error('Perplexity input not found'); ed.focus(); setTextareaValue(ed,text); await waitFor(()=>{ const b=document.querySelector(S.sendBtn); return b && b.getAttribute('aria-disabled')!=='true'; },800); const b=document.querySelector(S.sendBtn); if(b && !isStopBtn(b)) b.click(); else ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); }
  const stopGeneration=()=>{ const b=document.querySelector(S.stopBtn); if(isStopBtn(b)) try{b.click();}catch{} };
  function scanError(){ try{ for(const el of document.querySelectorAll(S.errorSurfaces)){ if(el.offsetParent===null) continue; const t=(el.innerText||'').trim(); if(t.length>8&&t.length<600&&RE.contextLimit.test(t)) return t.slice(0,240); } }catch{} if(!getEditor()) return "Input disappeared"; return null; }
  const isTooLongMsg=(t)=>RE.tooLong.test(t); const isBusyMsg=(t)=>RE.busy.test(t);
  async function attachImages(images){ return false; }
  const clearAttachments=()=>{};
  const conversationKey=()=> location.pathname + location.search;
  function installSendHooks(h){ document.addEventListener("keydown",e=>{ if(e.key!=="Enter"||e.shiftKey) return; const ed=getEditor(); if(!ed||!ed.contains(e.target)) return; if(editorText().trim()==="") return; if(h.isBlocked()) return; if(!h.isStarted()){ if(!chatIsEmpty()) return; h.onBlockedAttempt(); return; } h.onUserMessage(assistantCount()); },true); document.addEventListener("click",e=>{ const t=e.target; const b=t&&t.closest&&t.closest('button'); if(!b) return; if(isStopBtn(b)){ h.onNativeStop(); return; } const sb=b.closest(S.sendBtn)|| (b.matches&&b.matches(S.sendBtn)?b:null); if(!sb && !b.matches(S.sendBtn)) return; if(h.isBlocked()) return; if(!h.isStarted()){ if(!chatIsEmpty()) return; h.onBlockedAttempt(); return; } h.onUserMessage(assistantCount()); },true); }
  function findToolBlockSpot(item,chip){ const P=ZSParse; const hasStart=t=>P.LUA_START_RE.test(t)||t.includes("###mcp_tool###"); const isJson=t=>/\{\s*"(?:command|tool)"\s*:/.test(t); const cs=[...item.querySelectorAll('pre,code,div')].filter(m=>!m.closest('.zs-chip')); for(const c of cs){ const txt=c.textContent||""; if(hasStart(txt)||isJson(txt)){ c.classList.add("zs-tool-hide"); return {parent:c.parentElement, ref:c}; } } return null; }
  return { id:"perplexity", displayName:"Perplexity", get supportsVision(){return false;}, timings, thinkingSel: S.reasoning, init({diag:d}={}){ if(d) diag=d; try{document.documentElement.setAttribute("data-zs-px-ver","2-perplexity-fix");}catch{} }, allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant, streamLen:(it)=> (it?it.textContent.length:0), snapshot, getEditor, editorText, chatIsEmpty, isFreshChat:()=> !!getEditor(), composerFrame, barMount, setInputLock, typeAndSend, stopGeneration, isGenerating, isBusyNow, isHardGenerating, genDebug:()=>({gen:isGenerating()}), enforceComposer:()=>({ready:!!getEditor()}), ensureComposerReady:async()=>({ready:!!getEditor()}), turnHalted:()=>false, findContinueBtn, clickContinueBtn, scanError, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot };
})();
