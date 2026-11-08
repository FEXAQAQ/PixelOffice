const fs=require('fs'),path=require('path');
function within(root, target) {
  const relative=path.relative(root,target);
  return relative==='' || (!relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative));
}
function canonical(target) {
  let existing=path.resolve(target), tail=[];
  while (!fs.existsSync(existing)) {
    const parent=path.dirname(existing);
    if (parent===existing) throw Error('路徑不存在');
    tail.unshift(path.basename(existing));existing=parent;
  }
  return path.join(fs.realpathSync(existing),...tail);
}
module.exports={within,canonical};
