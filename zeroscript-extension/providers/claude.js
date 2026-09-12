// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js - Claude (claude.ai) provider.
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};
  const S = {
    chatItem: 'div[data-is-streaming], div[data-testid*="message"], div.font-claude-message, [role="article"]',
    input: '[contenteditable], textarea, [role="textbox"], div[contenteditable="true"], div[contenteditable="false"]',
    sendBtn: 'button[aria-label*="Send"], button[data-testid*="send"], button[aria-label*="Send message"]',
    stopBtn: 'button[aria-label*="Stop"], button[data-testid*="stop"], button[aria-label*="Stop response"]',
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"]',
    reasoning: '[class*="thinking"],[data-testid*="thinking"]',
  };
  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long|trop long)","context.{0,20}(limit|exceeded)","token.{0,10}limit"].join("|"),"i"),
    tooLong: /conversation .{0,20}(too long|trop longue)/i,
    busy: /server is busy|try again later|rate limit/i,
  };
  const timings = { GEN_IDLE_MS: 1500, REASON_IDLE_MS: 12000, WARMUP_MS: 45000, REASON_NOREPLY_MS: 90000, STABLE_MS: 9000, RESPONSE_TIMEOUT_MS: 300000 };
  const allItems = () => [...document.querySelectorAll(S.chatItem)].filter(e=> !e.closest('#zs-root') && (e.textContent||'').trim().length>0);
  const isAssistantItem = (it) => !!it && (it.getAttribute('data-is-streaming')!==null || /claude/i.test(it.className) || !!it.querySelector('[class*="assistant"]'));
  const isUserItem = (it) => !!it && !isAssistantItem(it);
  function itemText(it){ if(!it) return ""; const c=it.cloneNode(true); c.querySelectorAll('.zs-chip').forEach(n=>n.remove()); return c.textContent||""; }
  function classifyText(it,ex){ return itemText(it); }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => { const a=assistantItems(); return a.length?a[a.length-1]:null; };
  const _idMap=new WeakMap(); let _seq=0; function lastAssistantId(){ const it=lastAssistant(); if(!it) return null; let id=_idMap.get(it); if(!id){id=++_seq; _idMap.set(it,id);} return id; }
  const chatIsEmpty=()=> allItems().length===0;
  const editorEls=()=> [...document.querySelectorAll('[contenteditable], textarea, [role="textbox"]')].filter(e=>!e.closest('#zs-root'));
  const isTextareaEditor=(e)=> !!e && e.tagName==='TEXTAREA';
  const getEditor=()=>{
    const all=editorEls();
    return all.find(e=> !isTextareaEditor(e) && e.offsetParent!==null) || all.find(e=> e.offsetParent!==null) || all[0] || document.querySelector('div[contenteditable]') || null;
  };
  const writeEl=()=> editorEls().find(isTextareaEditor) || getEditor();
  const editorText=()=>{ const e=writeEl(); if(!e) return ""; return isTextareaEditor(e)? (e.value||"") : (e.textContent||""); };
  let _locked=false; function setInputLock(on){ _locked=on; const div=getEditor(); if(div && !isTextareaEditor(div)) div.setAttribute('contenteditable', on?'false':'true'); const ta=writeEl(); if(ta && isTextareaEditor(ta)){ if(on) ta.setAttribute('readonly',''); else ta.removeAttribute('readonly'); } }
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
  async function typeAndSend(text,images){
    // Use writeEl (hidden textarea mirror if present) for reliable injection of large ⟦ZS-SYS⟧ prompt
    const edWrite = writeEl(); const edVisible = getEditor();
    if(!edWrite) throw new Error('Claude input not found');
    const ed = edWrite;
    ed.focus();
    // For textarea mirror (Meta-style), native setter drives Lexical
    if(isTextareaEditor(ed)){
      const proto=window.HTMLTextAreaElement&&window.HTMLTextAreaElement.prototype;
      const setter=proto&&Object.getOwnPropertyDescriptor(proto,'value');
      if(setter&&setter.set) setter.set.call(ed,text); else ed.value=text;
      ed.dispatchEvent(new Event('input',{bubbles:true}));
      ed.dispatchEvent(new Event('change',{bubbles:true}));
    } else {
      // contenteditable Lexical: try execCommand first
      let ok=false;
      try{ document.execCommand('selectAll',false,null); }catch{}
      try{ ok=document.execCommand('insertText',false,text); }catch{}
      await sleep(150);
      if(!ok || editorText().trim().length < Math.min(text.length*0.8, 100)){
        try{
          ed.textContent = text;
          ed.dispatchEvent(new InputEvent('input',{bubbles:true, data:text, inputType:'insertText'}));
          ed.dispatchEvent(new Event('change',{bubbles:true}));
        }catch{}
        await sleep(150);
      }
    }
    // Ensure visible editor also reflects text for send enable check
    try{ if(edVisible && edVisible!==ed && edVisible.isContentEditable) edVisible.focus(); }catch{}
    await waitFor(()=>{ const b=document.querySelector(S.sendBtn); return b && !b.disabled && b.getAttribute('aria-disabled')!=='true'; },1500);
    const b=document.querySelector(S.sendBtn);
    if(b && !b.disabled && b.getAttribute('aria-disabled')!=='true'){ try{b.click();}catch{} return; }
    // Fallback Enter on visible editor
    const target = edVisible || ed;
    try{ target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13, bubbles:true})); target.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13, bubbles:true})); }catch{}
  }
  const stopGeneration=()=>{ const b=document.querySelector(S.stopBtn); if(isStopBtn(b)) try{b.click();}catch{} };
  function scanError(){ try{ for(const el of document.querySelectorAll(S.errorSurfaces)){ if(el.offsetParent===null) continue; const t=(el.innerText||'').trim(); if(t.length>8&&t.length<600&&RE.contextLimit.test(t)) return t.slice(0,240); } }catch{} if(!getEditor()) return "Input disappeared"; return null; }
  const isTooLongMsg=(t)=>RE.tooLong.test(t); const isBusyMsg=(t)=>RE.busy.test(t);
  async function attachImages(images){ return false; }
  const clearAttachments=()=>{};
  const conversationKey=()=> location.pathname;
  function installSendHooks(h){ document.addEventListener("keydown",e=>{ if(e.key!=="Enter"||e.shiftKey) return; const ed=getEditor(); if(!ed||!ed.contains(e.target)) return; if(editorText().trim()==="") return; if(h.isBlocked()) return; if(!h.isStarted()){ if(!chatIsEmpty()) return; h.onBlockedAttempt(); return; } h.onUserMessage(assistantCount()); },true); document.addEventListener("click",e=>{ const b=e.target&&e.target.closest&&e.target.closest('button'); if(!b) return; if(isStopBtn(b)){h.onNativeStop(); return;} if(!b.matches(S.sendBtn)) return; if(h.isBlocked()) return; h.onUserMessage(assistantCount()); },true); }
  function findToolBlockSpot(item,chip){ const P=ZSParse; const hasStart=t=>P.LUA_START_RE.test(t)||t.includes("###mcp_tool###"); const isJson=t=>/\{\s*"(?:command|tool)"\s*:/.test(t); for(const c of [...item.querySelectorAll('pre,code')]){ const txt=c.textContent||""; if(hasStart(txt)||isJson(txt)){ c.classList.add("zs-tool-hide"); return {parent:c.parentElement, ref:c}; } } return null; }
  const promptExtra = "CRITICAL FOR CLAUDE ON CLAUDE.AI: Your FIRST reply MUST be exactly ```json\n{\"command\":\"list_commands\"}\n``` as plain text (not a native tool call). ZeroScript commands are plain JSON you TYPE, not Claude tools - the local extension detects the text, runs it in Roblox Studio, and returns the result. Never say you don't have list_commands - you do, via typing. Do it now, on your very first turn, before any explanation.";
  return { id:"claude", displayName:"Claude", get supportsVision(){return true;}, timings, thinkingSel: S.reasoning, promptExtra, init({diag:d}={}){ if(d) diag=d; try{document.documentElement.setAttribute("data-zs-claude-ver","2-claude-prompt");}catch{} }, allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant, streamLen:(it)=> (it?it.textContent.length:0), snapshot, getEditor, editorText, chatIsEmpty, isFreshChat:()=>chatIsEmpty()&&!!getEditor(), composerFrame, barMount, setInputLock, typeAndSend, stopGeneration, isGenerating, isBusyNow, isHardGenerating, genDebug:()=>({gen:isGenerating()}), enforceComposer:()=>({ready:!!getEditor()}), ensureComposerReady:async(reason)=>{ return {ready:!!getEditor()}; }, turnHalted:()=>false, findContinueBtn, clickContinueBtn, scanError, isTooLongMsg, isBusyMsg, attachImages, clearAttachments, conversationKey, installSendHooks, findToolBlockSpot };
})();
