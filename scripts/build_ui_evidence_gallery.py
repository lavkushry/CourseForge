"""Build a local before/after viewer from complete, validated PNG evidence."""
from pathlib import Path
import argparse
import json
import os


def build(before: Path, after: Path, output: Path):
    baseline=json.loads((before/'manifest.json').read_text())
    final=json.loads((after/'manifest.json').read_text())
    assert baseline['views']==final['views'] and baseline['screenshots']==final['screenshots']==415
    before_url=os.path.relpath(before,output.parent)
    after_url=os.path.relpath(after,output.parent)
    views=json.dumps(baseline['views'])
    output.write_text('''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>CourseForge — before and after</title>
<style>
body{margin:0;background:#f5f6fa;color:#162039;font:16px/1.5 system-ui}main{max-width:1500px;margin:auto;padding:24px}h1{margin:0;font-size:28px}p{margin:8px 0 20px}.controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:24px 0}select,button{font:inherit;min-height:44px;border:1px solid #b8c0d3;border-radius:8px;padding:8px 12px;background:white;color:inherit;max-width:100%}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{min-width:0;border:1px solid #d8ddeb;border-radius:12px;padding:16px;background:white}h2{margin:0 0 12px;font-size:20px}img{display:block;width:100%;height:700px;object-fit:contain;object-position:top}.full img{height:auto}a{color:#4338ca}small{display:block;margin-top:12px}@media(max-width:800px){.comparison{grid-template-columns:1fr}img{height:550px}}
</style><main><h1>CourseForge UI consistency pass</h1>
<p>83 views × 5 widths = 415 comparisons. Real course content and isolated, anonymized accounts. Open either image for full resolution.</p>
<div class="controls"><label>View <select id="view"></select></label><label>Width <select id="width"><option>320</option><option selected>390</option><option>768</option><option>1366</option><option>1920</option></select> px</label><button id="previous">Previous view</button><button id="next">Next view</button><label><input id="full" type="checkbox"> Show full screenshot height</label></div>
<div class="comparison"><article><h2>Before</h2><a id="beforeLink"><img id="before" alt="Before UI fixes"></a></article><article><h2>After</h2><a id="afterLink"><img id="after" alt="After UI fixes"></a></article></div>
<small>Full evidence: <a href="stage-1/index.html">Audit</a> · <a href="stage-2/index.html">Layout</a> · <a href="stage-3/index.html">Shared components</a> · <a href="stage-4/validation.json">Final validation</a></small></main>
<script>
const views='''+views+''';const view=document.querySelector('#view'),width=document.querySelector('#width');
for(const name of views){const option=new Option(name.replaceAll('-',' '),name);view.add(option)}view.value='dashboard';
function render(){const name=view.value+'-'+width.value+'.png';for(const [id,folder] of [['before','''+json.dumps(before_url)+'''],['after','''+json.dumps(after_url)+''']]){const url=folder+'/screenshots/'+name;document.getElementById(id).src=url;document.getElementById(id+'Link').href=url}history.replaceState(null,'','#'+view.value+'/'+width.value)}
view.onchange=width.onchange=render;document.querySelector('#previous').onclick=()=>{view.selectedIndex=(view.selectedIndex+views.length-1)%views.length;render()};document.querySelector('#next').onclick=()=>{view.selectedIndex=(view.selectedIndex+1)%views.length;render()};document.querySelector('#full').onchange=e=>document.body.classList.toggle('full',e.target.checked);
const [name,size]=location.hash.slice(1).split('/');if(views.includes(name))view.value=name;if(['320','390','768','1366','1920'].includes(size))width.value=size;render();
</script></html>''')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before',type=Path,default=Path('docs/ui-evidence/stage-1'))
    parser.add_argument('--after',type=Path,default=Path('docs/ui-evidence/stage-3'))
    parser.add_argument('--output',type=Path,default=Path('docs/ui-evidence/index.html'))
    args=parser.parse_args();build(args.before,args.after,args.output)
