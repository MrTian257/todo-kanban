var bs = penpot.currentPage.root.children.filter(function (s) { return s.name.indexOf("todo-kanban 看板") === 0; });
return bs.map(function (b) {
  var kids = b.children || [];
  var texts = kids.filter(function (c) { return c.type === "text"; });
  var over = texts.filter(function (t) { return t.textBounds && t.textBounds.width > t.width + 1.5; });
  return {
    board: b.name, size: Math.round(b.width) + "x" + Math.round(b.height), children: kids.length,
    rects: kids.filter(function (c) { return c.type === "rectangle"; }).length,
    texts: texts.length,
    icons: kids.filter(function (c) { return c.type === "group"; }).length,
    overflow: over.length,
    overflowSamples: over.slice(0, 6).map(function (t) { return t.name + " box=" + Math.round(t.width) + " need=" + Math.round(t.textBounds.width); }),
    font: texts.length ? (texts[0].fontFamily + " " + texts[0].fontSize + "px/" + texts[0].fontWeight) : null,
    titles: texts.filter(function (t) { return t.name.indexOf("text/") === 0 && t.fontSize === "15"; }).map(function (t) { return String(t.name).slice(5, 20); }).slice(0, 8)
  };
});