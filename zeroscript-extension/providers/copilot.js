// SPDX-License-Identifier: GPL-3.0-or-later
// providers/copilot.js - Copilot (copilot.microsoft.com) provider.
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};
  const S = {
    chatItem: 'div[data-testid*="message"], div[class*="message"], [role="article"], div[class*="chat"]',
    input: 'textarea[placeholder*="Ask"], textarea[data-testid*="input"], div[contenteditable="true"],textarea',
    sendBtn: 'button[aria-label*="Send"], button[data-testid*="send"], button[type="submit"]',
    stopBtn: 'button[aria-label*="Stop"], button[data-testid*="stop"]',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"]',
    reasoning: '[class*="thinking"],[data-testid*="reasoning"]',
  };
  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long)","context.{0,20}(limit|exceeded)","token.{0,10}limit"].join("|"),"i"),
    tooLong: /conversation .{0,20}(too long)/i,
    busy: /server is busy|try again later|rate limit/i,
  };
  const timings = { GEN_IDLE_MS: 1500, REASON_IDLE_MS: 12000, WARMUP_MS: 45000, REASON_NOREPLY_MS: 90000, STABLE_MS: 9000, RESPONSE_TIMEOUT_MS: 300000 };
  const allItems = () => [...document.querySelectorAll(S.chatItem)].filter(e=> !e.closest('#zs-root') && (e.textContent||'').trim().length>5);
  const isAssistantItem = (it) => !!it && (it.matches('[data-author="bot"]')|| !!it.querySelector('[class*="assistant"]'));
  const isUserItem = (it) => !!it && !isAssistantItem(it);
  function itemText(it){ if(!it) return ""; const c=it.cloneNode(true); c.querySelectorAll('.zs-chip').forEach(n=>n.remove()); return c.textContent||""; }
  function classifyText(it,ex){ return itemText(it); }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const a=assistantItems(); return a.length?a[a.length-1]:null; };
  const _idMap=new WeakMap(); let _seq=0; function lastAssistantId(){ const it=lastAssistant(); if(!it) return null; let id=_idMap.get(it); if(!id){id=++_seq; _idMap.set(it,id);} return id; }
  const chatIsEmpty=()=> true;
  const getEditor=()=>{ const els=[...document.querySelectorAll(S.input)].filter(e=>!e.closest('#zs-root') && e.offsetParent!==null); return els.find(e=>e.tagName==='TEXTAREA')||els[0]||document.querySelector('textarea')||null; };
  const editorText=()=>{ const e=getEditor(); if(!e) return ""; return e.value!=null?e.value:e.textContent||""; };
  let _locked=false; function setInputLock(on){ _locked=on; const e=getEditor(); if(!e) return; if(on) e.setAttribute('readonly',''); else e.removeAttribute('readonly'); }
  const composerFrame=()=> { const e=getEditor(); return e?e.parentElement:null; };
  function barMount(){ const e=getEditor(); if(!e) return null; let box=e.parentElement; while(box && box!==document.body){ if(box.contains(e)) break; box=box.parentElement; } if(!box) box=e.parentElement; let before=box.firstElementChild; if(before&&before.id==='zs-bar') before=before.nextElementSibling; return {parent:box, before, inside:true}; }
  function isStopBtn(b){ if(!b) return false; return /stop/i.test(b.getAttribute('aria-label')||'')|| !!b.querySelector('rect'); }
  let _max=-1,_at=0,_item=null; function sample(){ const it=lastAssistant(); const len=(it?it.textContent.length:0); const now=Date.now(); if(it!==_item||len<_max-400){_item=it;_max=len;_at=now;return;} if(len>_max){_max=len;_at=now;} }
  const grewWithin=(ms)=> _max>1 && Date.now()-_at<ms;
  function isGenerating(){ if(document.querySelector('button[aria-label*="Stop"]')) return true; const b=document.querySelector(S.stopBtn); if(isStopBtn(b)) return true; sample(); return grewWithin(timings.GEN_IDLE_MS); }
  const isBusyNow=isGenerating; const isHardGenerating=()=> !!document.querySelector(S.stopBtn) && isStopBtn(document.querySelector(S.stopBtn));
  function snapshot(){ try{ const it=lastAssistant(); return {rp: it?(it.textContent||'').length:0}; }catch{ return {}; } }
  function findContinueBtn(){ for(const b of document.querySelectorAll('button')){ if(b.offsetParent===null) continue; if(/continue/i.test((b.innerText||'').trim())) return b; } return null; }
  const clickContinueBtn=()=>{ const b=findContinueBtn(); if(!b) return false; try{b.click(); return true;}catch{return false;} };
  function readAssistant(){ const it=lastAssistant(); if(!it) return {present:false, reply:"",thinking:"",item:null}; return {present:true, reply: it.textContent.trim(), thinking:"", item:it}; }
  async function waitFor(p,t){ const t0=Date.now(); while(Date.now()-t0<t){ if(p()) return true; await sleep(120);} return false; }
  function setTextareaValue(el,v){ const proto=window.HTMLTextAreaElement&&window.HTMLTextAreaElement.prototype; const s=proto&&Object.getOwnPropertyDescriptor(proto,'value'); if(s&&s.set) s.set.call(el,v); else el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
  async function typeAndSend(text,images){ const ed=getEditor(); if(!ed) throw new Error('Copilot input not found'); ed.focus(); if(ed.tagName==='TEXTAREA'){ setTextareaValue(ed,text); } else { document.execCommand('selectAll',false,null); document.execCommand('insertText',false,text); } await waitFor(()=>{ const b=document.querySelector(S.sendBtn); return b && b.getAttribute('aria-disabled')!=='true'; },800); const b=document.querySelector(S.sendBtn); if(b) b.click(); else ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); }
  const stopGeneration=()=>{ const b=document.querySelector(S.stopBtn); if(isStopBtn(b)) try{b.click();}catch{} };
  function scanError(){ try{ for(const el of document.querySelectorAll(S.errorSurfaces)){ if(el.offsetParent===null) continue; const t=(el.innerText||'').trim(); if(t.length>8&&t.length<600&&RE.contextLimit.test(t)) return t.slice(0,240); } }catch{} if(!getEditor()) return "Input disappeared"; return null; }
  const isTooLongMsg=(t)=>RE.tooLong.test(t); const isBusyMsg=(t)=>RE.busy.test(t);
  async function attachImages(images){ return false; }
  const clearAttachments=()=>{};
  const conversationKey=()=> location.pathname;
  function installSendHooks(h){ document.addEventListener("keydown",e=>{ if(e.key!=="Enter"||e.shiftKey) return; const ed=getEditor(); if(!ed||!ed.contains(e.target)) return; if(editorText().trim()==="") return; if(h.isBlocked()) return; if(!h.isStarted()){ if(!chatIsEmpty()) return; h.onBlockedAttempt(); return; } h.onUserMessage(assistantCount()); },true); document.addEventListener("click",e=>{ const b=e.target&&e.target.closest&&e.target.closest('button'); if(!b) return; if(isStopBtn(b)){h.onNativeStop(); return;} if(!b.matches(S.sendBtn)) return; if(h.isBlocked()) return; h.onUserMessage(assistantCount()); },true); }
  function findToolBlockSpot(item,chip){ const P=ZSParse; const hasStart=t=>P.LUA_START_RE.test(t)||t.includes("###mcp_tool###"); const isJson=t=>/\{\s*"(?:command|tool)"\s*:/.test(t); for(const c of [...item.querySelectorAll('pre,code')]){ const txt=c.textContent||""; if(hasStart(txt)||isJson(txt)){ c.classList.add("zs-tool-hide"); return {parent:c.parentElement, ref:c}; } } return null; }
  return { id:"copilot", displayName:"Copilot", get supportsVision(){return false;}, timings, thinkingSel: S.reasoning, init({diag:d}={}){ if(d) diag=d; try{document.documentElement.setAttribute("data-zs-copilot-ver","1");}catch{} }, allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant, streamLen:(it)=> (it?it.textContent.length:0), snapshot, getEditor, editorText, chatIsEmpty, isFreshChat:()=> !!getEditor(), composerFrame, barMount, setInputLock, typeAndSend, stopGeneration, isGenerating, isBusyNow, isHardGenerating, genDebug:()=>({gen:isGenerating()}), enforceComposer:()=>({ready:!!getEditor()}), ensureComposerReady:async()=>({ready:!!getEditor()}), turnHalted:()=>false, findContinueBtn, clickContinueBtn, scanError, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey:()=> location.pathname+location.search, installSendHooks, findToolBlockSpot };
})();
