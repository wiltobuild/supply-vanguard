import {describeFreshness,nextToReview,summarize} from './lib.js';
// Mutate only text, classes and visibility. No form, list button or focused control is replaced.
export function updateEquipmentFreshness(root,items,{now=Date.now(),stale}={}){
 const byId=new Map(items.map(item=>[item.id,item]));
 for(const node of root.querySelectorAll('[data-freshness-id]')){
  const item=byId.get(node.dataset.freshnessId);if(!item)continue;
  const f=describeFreshness(item,stale,now);node.textContent=f.text;node.className=`fresh-${f.state}`;
 }
 const count=root.querySelector('[data-verification-count]');
 if(count)count.textContent=`${summarize(items,stale,now).needsVerification} need location verification`;
 const next=nextToReview(items,stale,now),summary=root.querySelector('[data-review-summary]'),empty=root.querySelector('[data-review-empty]'),button=root.querySelector('[data-review-id]');
 if(summary)summary.hidden=!next;if(empty)empty.hidden=!!next;
 if(button){button.hidden=!next;button.dataset.reviewId=next?.id||'';}
 if(next){
  const name=root.querySelector('[data-review-name]'),location=root.querySelector('[data-review-location]'),fresh=root.querySelector('[data-review-freshness]');
  if(name)name.textContent=next.name;if(location)location.textContent=`${next.id} · ${next.roomId}`;
  if(fresh){const f=describeFreshness(next,stale,now);fresh.textContent=f.text;fresh.className=`fresh-${f.state}`;}
 }
}
