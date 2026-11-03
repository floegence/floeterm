import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryScrollbar } from './HistoryScrollbar';
const owned: HistoryScrollbar[]=[];
afterEach(()=>{owned.splice(0).forEach(item=>item.dispose());document.body.replaceChildren();});
function fixture(){
 const track=document.createElement('div'),thumb=document.createElement('div');track.append(thumb);document.body.append(track);
 Object.assign(track.style,{position:'absolute',left:'100px',top:'20px',height:'400px',width:'16px'});
 Object.assign(thumb.style,{position:'absolute',left:'2px',right:'2px'});
 let offset=500;const changes:number[]=[];
 const controller={getState:()=>({browsing:offset<1000,busy:false,offset,totalRows:1100,screenStartOffset:1000,error:null}),showOffset:(value:number)=>{offset=Math.max(0,Math.min(1000,value));changes.push(offset)},showLatest:()=>{offset=1000},scrollByRows:vi.fn()};
 const bar=new HistoryScrollbar({track,thumb,controller});owned.push(bar);
 track.setPointerCapture=vi.fn();track.hasPointerCapture=()=>false;
 return {track,thumb,bar,changes};
}
describe('HistoryScrollbar',()=>{
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
