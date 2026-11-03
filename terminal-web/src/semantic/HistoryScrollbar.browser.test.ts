import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryScrollbar } from './HistoryScrollbar';
const owned: HistoryScrollbar[]=[];
afterEach(()=>{owned.splice(0).forEach(item=>item.dispose());document.body.replaceChildren();});
function fixture(){
 const track=document.createElement('div'),thumb=document.createElement('div');track.append(thumb);document.body.append(track);
 Object.assign(track.style,{position:'absolute',left:'100px',top:'20px',height:'400px',width:'16px'});
 Object.assign(thumb.style,{position:'absolute',left:'2px',right:'2px'});
 let offset=500;let maximum=1000;const changes:number[]=[];
 const controller={getState:()=>({browsing:offset<maximum,busy:false,offset,totalRows:maximum+100,screenStartOffset:maximum,error:null}),showOffset:(value:number)=>{offset=Math.max(0,Math.min(maximum,value));changes.push(offset)},showLatest:()=>{offset=1000},scrollByRows:vi.fn()};
 const bar=new HistoryScrollbar({track,thumb,controller});owned.push(bar);
 track.setPointerCapture=vi.fn();track.hasPointerCapture=()=>false;
 return {track,thumb,bar,changes,setMaximum:(value:number)=>{maximum=value;bar.update()}};
}
describe('HistoryScrollbar',()=>{
 it('recomputes drag geometry after appended output and cancels on lost capture',async()=>{
  const {track,thumb,bar,changes,setMaximum}=fixture();
  const bounds=thumb.getBoundingClientRect();
  thumb.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:4,clientY:bounds.top+10}));
  setMaximum(2000);
  track.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:4,clientY:420}));
  await new Promise(requestAnimationFrame);
  expect(changes[changes.length-1]).toBe(2000);
  track.dispatchEvent(new PointerEvent('lostpointercapture',{bubbles:true,pointerId:4}));
  expect(track.dataset.dragging).toBe('false');
  setMaximum(0);expect(track.hidden).toBe(true);
  bar.dispose();
 });
 it('preserves the grab point and coalesces pointer motion',async()=>{
  const {track,thumb,changes}=fixture();const y=thumb.getBoundingClientRect().top+10;
  thumb.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:1,clientY:y}));
  expect(changes).toEqual([]);expect(getComputedStyle(track).cursor).toBe('grabbing');
  for(let n=0;n<100;n++)track.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:1,clientY:y+n}));
  expect(changes).toEqual([]);await new Promise(requestAnimationFrame);
  expect(changes).toHaveLength(1);expect(changes[0]).toBeGreaterThan(500);
  track.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientY:900}));
  expect(changes[changes.length-1]).toBe(1000);expect(getComputedStyle(thumb).cursor).toBe('grab');
 });
 it('provides keyboard navigation and cancels pending drag work',()=>{
  const {track,thumb,changes}=fixture();
  for(const [key,value] of [['Home',0],['PageDown',100],['End',1000]] as const){
   const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});track.dispatchEvent(event);
   expect(event.defaultPrevented).toBe(true);expect(changes[changes.length-1]).toBe(value);
  }
  const count=changes.length;
  thumb.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:2,clientY:300}));
  track.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:2,clientY:10}));
  track.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:2}));
  expect(changes).toHaveLength(count);expect(track.dataset.dragging).toBe('false');
  expect(track.tabIndex).toBe(0);expect(getComputedStyle(track).userSelect).toBe('none');
 });
});
