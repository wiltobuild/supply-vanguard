// Mount inside an authenticated host. No credentials, demo identities or operational thresholds live here.
export function mountSupplies(root,{client,synthetic = false,makeKey = () => crypto.randomUUID()}) {
  const doc = root.ownerDocument;
  const el = (tag,text,attrs = {}) => {
    const node = doc.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,value);
    return node;
  };
  const button = (text,fn) => {const b = el('button',text,{type:'button'});b.addEventListener('click',fn);return b;};
  root.replaceChildren(); root.classList.add('supplies');
  const heading = el('h1','Supply replenishment');
  const notice = el('p',synthetic ? 'Synthetic test fixture — every record, quantity and threshold below is test-only.' :
    'Declared-unit counts, configured par levels, and assigned replenishment work. No external notifications are sent.',{class:'notice'});
  root.append(heading,notice);
  const status = el('p','Loading authorized supplies…',{role:'status','aria-live':'polite'});
  const error = el('p','',{role:'alert',class:'field-error'});
  const refresh = button('Refresh counts and queue',() => load());
  const pendingArea = el('section',null,{'aria-label':'Unconfirmed requests'});
  const binsArea = el('section',null,{'aria-labelledby':'supplies-bins-title'});
  const tasksArea = el('section',null,{'aria-labelledby':'supplies-tasks-title'});
  root.append(status,error,refresh,pendingArea,tasksArea,binsArea);
  const own = [heading,notice,status,error,refresh,pendingArea,tasksArea,binsArea];   // the only nodes this instance may remove from the shared root
  let bins = [],tasks = [],binCursor = null,taskCursor = null,canWrite = false,busy = false,disposed = false,generation = 0,stale = false;
  const pending = new Map(),drafts = new Map();
  const sayError = e => {
    const known = {stock_conflict:'Counts changed. Refresh, review the new count, and submit again.',
      task_conflict:'This task changed. Refresh and review its assignment.',policy_conflict:'The par level changed. Refresh before configuring it again.',
      replenishment_conflict:'Another update competed with this action. Refresh and review before submitting again.',
      idempotency_conflict:'This request no longer matches its earlier submission. Refresh and reconcile the result.',
      invalid_quantity:'Enter a nonnegative quantity with up to three decimal places in the displayed unit.',
      invalid_text:'Enter a reason of 1–500 characters.',invalid_version:'Refresh counts and queue before submitting again.',
      invalid_replenishment:'The update could not be applied. Check the quantity and refresh before submitting again.',
      forbidden:'Access denied. Reconnect through your host application.',unauthenticated:'Sign in again through your host application.'};
    error.textContent = known[e.message] || e.message;
  };
  const clearAccess = () => {bins=[];tasks=[];pending.clear();drafts.clear();pendingArea.replaceChildren();binsArea.replaceChildren();tasksArea.replaceChildren();canWrite=false;stale=true;};
  function renderPending() {
    pendingArea.replaceChildren();
    for(const [key,input] of pending) {
      const operation=key.split(':')[0];
      const panel=el('div',null,{'data-pending':key,class:'notice'});
      panel.append(el('p',`Unconfirmed ${operation} request for bin ${input.binId}. Its original quantities and reason are retained until confirmation.`));
      panel.append(button('Retry unchanged request',async()=>{
        if(busy)return;busy=true;refresh.disabled=true;error.textContent='';let saved=false;
        try{
          const result=await client.command(operation,input);if(disposed)return;saved=true;
          pending.delete(key);drafts.delete(key);renderPending();await load(true);
          if(disposed)return;   // destroyed (or replaced) while the refresh ran: touch nothing, least of all focus
          status.textContent=result.replayed?'Original saved result confirmed. Counts and queue refreshed.':'Saved. Counts and queue refreshed.';
          (binsArea.querySelector(`[id="supply-${input.binId}"]`)||refresh).focus();   // only this instance's own heading, never another mount's
        }catch(ex){if(disposed)return;
          if(!ex.uncertain&&!saved){pending.delete(key);renderPending();}
          if([401,403].includes(ex.status))clearAccess();sayError(ex);
          status.textContent=saved?'Saved, but refresh failed. Refresh before another action.':ex.uncertain?'Result unknown. Retry the unchanged request.':'Request rejected. Refresh and reconcile before another action.';
        }finally{busy=false;refresh.disabled=false;}
      }));
      pendingArea.append(panel);
    }
  }
  function rowHeading(area,text,id) {const h = el('h2',text,{id});area.replaceChildren(h);}
  function field(form,label,name,{value = '',numeric = false} = {}) {
    const wrap = el('label',label);
    const input = el('input',null,{name,required:'',value,...(numeric ? {inputmode:'decimal',pattern:'(0|[1-9][0-9]{0,11})([.][0-9]{1,3})?'} : {maxlength:'500'})});
    wrap.append(input);form.append(wrap);return input;
  }
  function form(card,label,operation,identity,build) {
    const details = el('details');details.append(el('summary',label));
    const f = el('form',null,{'aria-label':`${label}: ${identity.label}`});
    build(f);
    field(f,'Reason','reason');
    const submit = el('button',label,{type:'submit'});f.append(submit,el('p','Counts use the displayed SKU unit. No pack conversions.',{class:'hint'}));
    const formKey = `${operation}:${identity.taskId || identity.binId}`;
    const controls = () => [...f.querySelectorAll('input')];
    const lock = () => {controls().forEach(n => {n.disabled=true;});submit.textContent='Retry unchanged request';};
    const draft = pending.get(formKey) || drafts.get(formKey);
    if(draft) {details.open=true;controls().forEach(n=>{if(draft[n.name]!=null)n.value=draft[n.name];});}
    f.addEventListener('input',()=>drafts.set(formKey,Object.fromEntries(controls().map(n=>[n.name,n.value]))));
    if (pending.has(formKey)) lock();
    f.addEventListener('submit',async e => {
      e.preventDefault(); if (busy) return;
      if(pending.size&&!pending.has(formKey)){error.textContent='Confirm the unconfirmed request before starting another action.';return;}
      if(stale&&!pending.has(formKey)){error.textContent='Refresh counts and queue before starting another action.';return;}
      let input = pending.get(formKey);
      if (!input) {
        const values = Object.fromEntries(controls().map(n => [n.name,n.value.trim()]));
        input = {...identity,...values,idempotencyKey:makeKey(),source:'manual-replenishment'};
        delete input.label;
        pending.set(formKey,input);
      }
      busy=true;submit.disabled=true;refresh.disabled=true;error.textContent='';status.textContent='Saving…';lock();
      let saved = false;
      try {
        const result = await client.command(operation,input);
        if (disposed) return;
        saved = true;
        pending.delete(formKey);
        drafts.delete(formKey);
        renderPending();
        await load(true);
        if (disposed) return;   // destroyed (or replaced) while the refresh ran: touch nothing, least of all focus
        status.textContent = result.replayed ? 'Original saved result confirmed. Counts and queue refreshed.' :
          result.created === false && operation === 'detect' ? 'Check complete. Existing alert retained, or no low-par alert needed.' : 'Saved. Counts and queue refreshed.';
        const focus = binsArea.querySelector(`[id="supply-${identity.binId}"]`) || refresh;   // only this instance's own heading
        focus.focus();
      } catch (ex) {
        if (disposed) return;
        if(saved){sayError(ex);status.textContent='Saved, but refresh failed. Refresh counts and queue before another action.';submit.textContent='Saved — refresh required';return;}
        if (!ex.uncertain) {pending.delete(formKey);controls().forEach(n => {n.disabled=false;});submit.textContent=label;}
        renderPending();
        if ([401,403].includes(ex.status)) clearAccess();
        sayError(ex);status.textContent=ex.uncertain ? 'Result unknown. Retry this unchanged request before starting another action.' : 'Not saved. Your entries are preserved.';
        if(['invalid_quantity','invalid_text'].includes(ex.message)) {
          const input=controls().find(n=>ex.message==='invalid_text'?n.name==='reason':n.name!=='reason');
          if(input){input.setAttribute('aria-invalid','true');
            const inline=el('p',error.textContent,{class:'field-error',id:`error-${makeKey()}`});
            input.parentElement.append(inline);input.setAttribute('aria-describedby',inline.id);input.focus();}
        }
      } finally {busy=false;submit.disabled=false;refresh.disabled=false;}
    });
    details.append(f);card.append(details);
  }
  function render() {
    renderPending();
    rowHeading(tasksArea,'Replenishment queue','supplies-tasks-title');
    tasksArea.append(el('p','Each active item is one in-app alert. Work stays queued until completed, even if a later stock update brings the bin above par.',{class:'muted'}));
    if (!tasks.length) tasksArea.append(el('p','No active replenishment tasks in this loaded page.'));
    for (const t of tasks) {
      const card=el('article',null,{class:'supply-card mint'});
      card.append(el('h3',`${t.name} · ${t.code}`),el('p',`${t.status === 'open' ? 'Unassigned' : t.assigned_to_me ? 'Assigned to you' : 'Assigned to another staff member'} · ${t.low_par ? 'Below par' : 'At or above par'}`),
        el('p',`${t.quantity} ${t.unit} on hand · configured par ${t.par_quantity} ${t.unit}`));
      const identity={binId:t.bin_id,taskId:t.id,expectedTaskVersion:t.version,label:t.code};
      if (canWrite && t.status==='open') form(card,'Assign to me','assign',identity,() => {});
      if (canWrite && t.status==='assigned' && t.assigned_to_me) form(card,'Complete replenishment','complete',
        {...identity,expectedStockVersion:t.stock_version}, f => {
          field(f,`Actual quantity received (${t.unit})`,'receivedQuantity',{numeric:true});
          f.append(el('p','Enter 0 only when closing without adding stock; explain why in the reason.',{class:'hint'}));
        });
      tasksArea.append(card);
    }
    if (taskCursor) tasksArea.append(button('Load more tasks',() => more('tasks')));
    rowHeading(binsArea,'Bin counts and par levels','supplies-bins-title');
    if (!bins.length) binsArea.append(el('p','No authorized supply bins in this loaded page.'));
    for (const b of bins) {
      const card=el('article',null,{class:'supply-card blue'});
      const h=el('h3',`${b.name} · ${b.code}`,{id:`supply-${b.id}`,tabindex:'-1'});
      card.append(h,el('p',`${b.quantity} ${b.unit} on hand`),
        el('p',b.par_quantity == null ? 'Par level not configured — no low-stock decision is made.' :
          `Par ${b.par_quantity} ${b.unit} · ${b.low_par ? 'Below par' : 'At or above par'}`));
      if (canWrite) {
        const identity={binId:b.id,label:b.code};
        form(card,'Configure par level','configure',{...identity,expectedPolicyVersion:b.par_version},f => field(f,`Par quantity (${b.unit})`,'parQuantity',{value:b.par_quantity ?? '',numeric:true}));
        if (b.par_quantity != null) form(card,'Check low stock','detect',identity,() => {});
        form(card,'Correct counted stock','correct',{...identity,expectedStockVersion:b.stock_version},f => field(f,`Counted quantity (${b.unit})`,'countedQuantity',{numeric:true}));
        const history=el('div');
        let after=null;
        const historyButton=button('View audit history',async () => {
          if (busy) return;busy=true;historyButton.disabled=true;
          try {const page=await client.history(b.id,after);if(disposed)return;
            if(!after)history.replaceChildren();
            for(const record of page.items) history.append(el('p',`${record.kind} · ${record.recorded_at} · ${JSON.stringify(record.detail)}`));
            if(!page.items.length&&!after)history.append(el('p','No replenishment audit events.'));
            after=page.nextCursor;historyButton.textContent=after?'Load more audit history':'Refresh audit history';
          } catch(ex){if([401,403].includes(ex.status))clearAccess();sayError(ex);}finally{busy=false;historyButton.disabled=false;}
        });
        card.append(historyButton,history);
      }
      binsArea.append(card);
    }
    if(binCursor)binsArea.append(button('Load more bins',() => more('bins')));
  }
  async function more(kind) {
    if(busy)return;busy=true;refresh.disabled=true;error.textContent='';
    try {const page=await (kind==='bins'?client.listBins(binCursor):client.listTasks(taskCursor));if(disposed)return;
      if(kind==='bins'){bins.push(...page.items.filter(x=>!bins.some(b=>b.id===x.id)));binCursor=page.nextCursor;}
      else {tasks.push(...page.items.filter(x=>!tasks.some(t=>t.id===x.id)));taskCursor=page.nextCursor;}
      render();status.textContent='More records loaded.';
    }catch(ex){if([401,403].includes(ex.status))clearAccess();sayError(ex);}finally{busy=false;refresh.disabled=false;}
  }
  async function load(fromSave=false) {
    if(busy&&!fromSave)return;
    const current=++generation;
    if(!fromSave){busy=true;refresh.disabled=true;error.textContent='';}
    status.textContent='Loading authorized supplies…';
    try {
      const [b,t]=await Promise.all([client.listBins(),client.listTasks()]);
      if(disposed||current!==generation)return;
      bins=b.items;tasks=t.items;binCursor=b.nextCursor;taskCursor=t.nextCursor;canWrite=b.canWrite;
      stale=false;
      render();status.textContent=`Loaded ${bins.length} bins and ${tasks.length} active tasks${binCursor||taskCursor?' (more pages available)':''}.`;
    }catch(ex){if(disposed)return;stale=true;if([401,403].includes(ex.status))clearAccess();sayError(ex);status.textContent='Refresh failed. Displayed records may be out of date.';
      if(fromSave)throw ex;
    }finally{if(!fromSave){busy=false;refresh.disabled=false;}}
  }
  const ready=load();
  return {ready,refresh:() => load(),destroy(){
    disposed=true;generation++;clearAccess();
    // Remove only this instance's nodes. A newer mount on the same root keeps its content, and a second destroy() is harmless.
    for(const node of own)if(node.parentNode===root)root.removeChild(node);
    if(!root.firstChild)root.classList.remove('supplies');
  }};
}
